const express = require('express');
const { db } = require('../db');
const { authenticate, requireRole, IT_ROLES } = require('../auth');
const { audit, notifyUser } = require('../services');

function assetHistory(assetId, actorId, action, detail) {
  db.prepare('INSERT INTO asset_history (asset_id, actor_id, action, detail) VALUES (?,?,?,?)')
    .run(assetId, actorId ?? null, action, detail ?? null);
}

const router = express.Router();
router.use(authenticate);

const ASSET_SELECT = `
  SELECT a.*, u.full_name AS assigned_user_name, u.email AS assigned_user_email,
         l.name AS location_name
  FROM assets a
  LEFT JOIN users u ON u.id = a.assigned_user_id
  LEFT JOIN locations l ON l.id = a.location_id`;

// IT users browse the repository; employees see their own laptops via /api/meta.
router.get('/', requireRole(...IT_ROLES), (req, res) => {
  const { q } = req.query;
  if (q) {
    const like = `%${q}%`;
    return res.json(db.prepare(
      `${ASSET_SELECT} WHERE a.asset_tag LIKE ? OR a.serial_number LIKE ? OR a.hostname LIKE ? OR u.full_name LIKE ? ORDER BY a.asset_tag`
    ).all(like, like, like, like));
  }
  res.json(db.prepare(`${ASSET_SELECT} ORDER BY a.asset_tag`).all());
});

router.get('/:id', requireRole(...IT_ROLES), (req, res) => {
  const asset = db.prepare(`${ASSET_SELECT} WHERE a.id = ?`).get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const tickets = db.prepare(`
    SELECT t.id, t.ticket_number, t.title, t.status, t.created_at
    FROM tickets t WHERE t.asset_id = ? ORDER BY t.created_at DESC LIMIT 50`).all(asset.id);
  const history = db.prepare(`
    SELECT ah.*, u.full_name AS actor_name
    FROM asset_history ah LEFT JOIN users u ON u.id = ah.actor_id
    WHERE ah.asset_id = ? ORDER BY ah.id DESC LIMIT 100`).all(asset.id);
  res.json({ ...asset, tickets, history });
});

router.post('/', requireRole('ADMIN', 'TEAM_LEAD'), (req, res) => {
  const { asset_tag, serial_number, manufacturer, model, hostname,
    operating_system, assigned_user_id, location_id, warranty_until,
    vendor, purchase_date, purchase_cost } = req.body || {};
  if (!asset_tag || !serial_number || !manufacturer || !model) {
    return res.status(400).json({ error: 'Asset tag, serial number, manufacturer and model are required' });
  }
  try {
    const info = db.prepare(`INSERT INTO assets
      (asset_tag, serial_number, manufacturer, model, hostname, operating_system,
       assigned_user_id, location_id, warranty_until, vendor, purchase_date, purchase_cost, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(asset_tag.trim(), serial_number.trim(), manufacturer.trim(), model.trim(),
        hostname || null, operating_system || null, assigned_user_id || null,
        location_id || null, warranty_until || null, vendor || null,
        purchase_date || null, purchase_cost ?? null,
        assigned_user_id ? 'ASSIGNED' : 'IN_STOCK');
    assetHistory(info.lastInsertRowid, req.user.id, 'CREATED',
      assigned_user_id ? 'Registered and assigned' : 'Registered in stock');
    audit(req.user.id, 'ASSET_CREATED', 'asset', info.lastInsertRowid, asset_tag, req);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch {
    res.status(409).json({ error: 'Asset tag or serial number already exists' });
  }
});

// ---------- STANDARD S7: lifecycle actions ----------
// ASSIGN / TRANSFER {user_id}, UNASSIGN, REPAIR {note}, REPAIR_DONE,
// RETIRE {note}, REACTIVATE
router.post('/:id/action', requireRole('ADMIN', 'TEAM_LEAD'), (req, res) => {
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const { action, user_id, note } = req.body || {};
  const act = String(action || '').toUpperCase();

  if (act === 'ASSIGN' || act === 'TRANSFER') {
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(user_id);
    if (!user) return res.status(400).json({ error: 'Choose an active user to assign the laptop to' });
    if (asset.status === 'RETIRED') return res.status(400).json({ error: 'A retired asset cannot be assigned' });
    const prev = asset.assigned_user_id
      ? db.prepare('SELECT full_name FROM users WHERE id = ?').get(asset.assigned_user_id)?.full_name
      : null;
    db.prepare("UPDATE assets SET assigned_user_id = ?, status = 'ASSIGNED' WHERE id = ?").run(user.id, asset.id);
    assetHistory(asset.id, req.user.id, prev ? 'TRANSFERRED' : 'ASSIGNED',
      prev ? `Transferred from ${prev} to ${user.full_name}` : `Assigned to ${user.full_name}`);
    notifyUser(user.id, null, 'ASSET_ASSIGNED', `Laptop ${asset.asset_tag} (${asset.manufacturer} ${asset.model}) has been assigned to you.`);
  } else if (act === 'UNASSIGN') {
    db.prepare("UPDATE assets SET assigned_user_id = NULL, status = 'IN_STOCK' WHERE id = ?").run(asset.id);
    assetHistory(asset.id, req.user.id, 'UNASSIGNED', note || 'Returned to stock');
  } else if (act === 'REPAIR') {
    db.prepare("UPDATE assets SET status = 'IN_REPAIR' WHERE id = ?").run(asset.id);
    assetHistory(asset.id, req.user.id, 'REPAIR', note || 'Sent for repair');
  } else if (act === 'REPAIR_DONE') {
    if (asset.status !== 'IN_REPAIR') return res.status(400).json({ error: 'Asset is not in repair' });
    db.prepare("UPDATE assets SET status = ? WHERE id = ?")
      .run(asset.assigned_user_id ? 'ASSIGNED' : 'IN_STOCK', asset.id);
    assetHistory(asset.id, req.user.id, 'REPAIR_DONE', note || 'Repair completed');
  } else if (act === 'RETIRE') {
    db.prepare("UPDATE assets SET status = 'RETIRED', active = 0, assigned_user_id = NULL, retired_at = datetime('now') WHERE id = ?")
      .run(asset.id);
    assetHistory(asset.id, req.user.id, 'RETIRED', note || 'Retired from service');
  } else if (act === 'REACTIVATE') {
    if (asset.status !== 'RETIRED') return res.status(400).json({ error: 'Only retired assets can be reactivated' });
    db.prepare("UPDATE assets SET status = 'IN_STOCK', active = 1, retired_at = NULL WHERE id = ?").run(asset.id);
    assetHistory(asset.id, req.user.id, 'REACTIVATED', note || null);
  } else {
    return res.status(400).json({ error: 'Unknown asset action' });
  }
  audit(req.user.id, `ASSET_${act}`, 'asset', asset.id, note || null, req);
  res.json(db.prepare(`${ASSET_SELECT} WHERE a.id = ?`).get(asset.id));
});

router.patch('/:id', requireRole('ADMIN', 'TEAM_LEAD'), (req, res) => {
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const fields = ['asset_tag', 'serial_number', 'manufacturer', 'model', 'hostname',
    'operating_system', 'assigned_user_id', 'location_id', 'warranty_until', 'active',
    'vendor', 'purchase_date', 'purchase_cost'];
  const sets = [];
  const vals = [];
  for (const f of fields) {
    if (req.body?.[f] !== undefined) { sets.push(`${f} = ?`); vals.push(req.body[f]); }
  }
  if (!sets.length) return res.json({ ok: true });
  vals.push(asset.id);
  try {
    db.prepare(`UPDATE assets SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    audit(req.user.id, 'ASSET_UPDATED', 'asset', asset.id, JSON.stringify(req.body), req);
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: 'Asset tag or serial number already exists' });
  }
});

module.exports = router;
