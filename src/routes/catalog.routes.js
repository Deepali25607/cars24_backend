const express = require('express');
const { db } = require('../db');
const { authenticate, requireRole } = require('../auth');
const { audit } = require('../services');

const router = express.Router();
router.use(authenticate);

// All users can browse active catalog items (BRD 7.7).
router.get('/', (req, res) => {
  const all = req.user.role === 'ADMIN' && req.query.all === '1';
  res.json(db.prepare(`
    SELECT ci.*, g.name AS group_name
    FROM catalog_items ci LEFT JOIN support_groups g ON g.id = ci.support_group_id
    ${all ? '' : 'WHERE ci.active = 1'}
    ORDER BY ci.name ASC`).all());
});

// ---------- Admin management ----------
router.post('/', requireRole('ADMIN'), (req, res) => {
  const { name, description, icon, support_group_id, requires_approval } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Item name is required' });
  try {
    const info = db.prepare(`INSERT INTO catalog_items
      (name, description, icon, support_group_id, requires_approval)
      VALUES (?,?,?,?,?)`)
      .run(String(name).trim(), description || null, icon || null,
        support_group_id || null, requires_approval === false ? 0 : 1);
    audit(req.user.id, 'CATALOG_ITEM_CREATED', 'catalog_item', info.lastInsertRowid, name, req);
    res.status(201).json(db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(info.lastInsertRowid));
  } catch {
    res.status(409).json({ error: 'A catalog item with that name already exists' });
  }
});

router.patch('/:id', requireRole('ADMIN'), (req, res) => {
  const item = db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Catalog item not found' });
  const { name, description, icon, support_group_id, requires_approval, active } = req.body || {};
  try {
    db.prepare(`UPDATE catalog_items SET
        name = COALESCE(?, name), description = COALESCE(?, description),
        icon = COALESCE(?, icon), support_group_id = COALESCE(?, support_group_id),
        requires_approval = COALESCE(?, requires_approval),
        active = COALESCE(?, active)
      WHERE id = ?`)
      .run(name ? String(name).trim() : null, description ?? null, icon ?? null,
        support_group_id ?? null,
        requires_approval !== undefined ? (requires_approval ? 1 : 0) : null,
        active !== undefined ? (active ? 1 : 0) : null, item.id);
    audit(req.user.id, 'CATALOG_ITEM_UPDATED', 'catalog_item', item.id, name || item.name, req);
    res.json(db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(item.id));
  } catch {
    res.status(409).json({ error: 'A catalog item with that name already exists' });
  }
});

module.exports = router;
