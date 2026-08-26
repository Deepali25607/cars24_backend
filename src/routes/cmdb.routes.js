const express = require('express');
const { db, nextCiNumber } = require('../db');
const { authenticate, requireRole, IT_ROLES } = require('../auth');
const { audit } = require('../services');

const router = express.Router();
router.use(authenticate, requireRole(...IT_ROLES));

const CI_SELECT = `
  SELECT ci.*, u.full_name AS owner_name, a.asset_tag, a.serial_number,
    a.manufacturer, a.model
  FROM cis ci
  LEFT JOIN users u ON u.id = ci.owner_user_id
  LEFT JOIN assets a ON a.id = ci.asset_id
`;

function getCi(id) { return db.prepare(`${CI_SELECT} WHERE ci.id = ?`).get(id); }

router.get('/', (req, res) => {
  const { type, q, status } = req.query;
  const where = [];
  const params = {};
  if (type) { where.push('ci.ci_type = @type'); params.type = type; }
  if (status) { where.push('ci.status = @status'); params.status = status; }
  if (q) {
    where.push('(ci.name LIKE @q OR ci.ci_number LIKE @q OR a.asset_tag LIKE @q)');
    params.q = `%${q}%`;
  }
  res.json(db.prepare(`${CI_SELECT}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ci.ci_type, ci.name LIMIT 500`).all(params));
});

router.get('/:id', (req, res) => {
  const ci = getCi(req.params.id);
  if (!ci) return res.status(404).json({ error: 'Configuration item not found' });

  const upstream = db.prepare(`
    SELECT r.id AS rel_id, r.relation_type, c.id, c.ci_number, c.name, c.ci_type
    FROM ci_relationships r JOIN cis c ON c.id = r.parent_id
    WHERE r.child_id = ?`).all(ci.id);
  const downstream = db.prepare(`
    SELECT r.id AS rel_id, r.relation_type, c.id, c.ci_number, c.name, c.ci_type
    FROM ci_relationships r JOIN cis c ON c.id = r.child_id
    WHERE r.parent_id = ?`).all(ci.id);

  // Recent tickets: via linked asset (laptop CIs)
  const tickets = ci.asset_id
    ? db.prepare(`SELECT id, ticket_number, title, status, created_at FROM tickets
        WHERE asset_id = ? ORDER BY created_at DESC LIMIT 20`).all(ci.asset_id)
    : [];
  const changeRefs = db.prepare(`
    SELECT ch.id, ch.change_number, ch.title, ch.status
    FROM change_cis cc JOIN changes ch ON ch.id = cc.change_id
    WHERE cc.ci_id = ? ORDER BY ch.updated_at DESC LIMIT 20`).all(ci.id);

  res.json({ ...ci, upstream, downstream, tickets, changes: changeRefs });
});

router.post('/', requireRole('TEAM_LEAD', 'ADMIN'), (req, res) => {
  const { name, ci_type, asset_id, owner_user_id, description, status } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'CI name is required' });
  const types = ['BUSINESS_SERVICE', 'APPLICATION', 'SERVER', 'LAPTOP', 'NETWORK_DEVICE'];
  if (!types.includes(ci_type)) return res.status(400).json({ error: 'Choose a valid CI type' });
  if (asset_id && !db.prepare('SELECT id FROM assets WHERE id = ?').get(asset_id)) {
    return res.status(400).json({ error: 'Unknown asset' });
  }
  const number = nextCiNumber();
  const info = db.prepare(`INSERT INTO cis (ci_number, name, ci_type, asset_id, owner_user_id, description, status)
    VALUES (?,?,?,?,?,?,?)`)
    .run(number, String(name).trim(), ci_type, asset_id || null, owner_user_id || null,
      description || null, ['ACTIVE', 'INACTIVE', 'RETIRED'].includes(status) ? status : 'ACTIVE');
  audit(req.user.id, 'CI_CREATED', 'ci', info.lastInsertRowid, number, req);
  res.status(201).json(getCi(info.lastInsertRowid));
});

router.patch('/:id', requireRole('TEAM_LEAD', 'ADMIN'), (req, res) => {
  const ci = getCi(req.params.id);
  if (!ci) return res.status(404).json({ error: 'Configuration item not found' });
  const { name, owner_user_id, description, status } = req.body || {};
  if (status && !['ACTIVE', 'INACTIVE', 'RETIRED'].includes(status)) {
    return res.status(400).json({ error: 'Invalid CI status' });
  }
  db.prepare(`UPDATE cis SET name = COALESCE(?, name), owner_user_id = ?,
      description = COALESCE(?, description), status = COALESCE(?, status)
    WHERE id = ?`)
    .run(name ? String(name).trim() : null,
      owner_user_id !== undefined ? owner_user_id : ci.owner_user_id,
      description ?? null, status || null, ci.id);
  audit(req.user.id, 'CI_UPDATED', 'ci', ci.id, JSON.stringify(req.body), req);
  res.json(getCi(ci.id));
});

// Relationships: parent --(relation)--> child, e.g. Application DEPENDS_ON Server
router.post('/:id/relationships', requireRole('TEAM_LEAD', 'ADMIN'), (req, res) => {
  const parent = getCi(req.params.id);
  if (!parent) return res.status(404).json({ error: 'Configuration item not found' });
  const { child_id, relation_type } = req.body || {};
  const child = getCi(child_id);
  if (!child || child.id === parent.id) return res.status(400).json({ error: 'Choose a different existing CI to relate' });
  const rel = ['DEPENDS_ON', 'RUNS_ON', 'USED_BY', 'CONNECTS_TO'].includes(relation_type)
    ? relation_type : 'DEPENDS_ON';
  try {
    const info = db.prepare('INSERT INTO ci_relationships (parent_id, child_id, relation_type) VALUES (?,?,?)')
      .run(parent.id, child.id, rel);
    audit(req.user.id, 'CI_RELATED', 'ci', parent.id, `${parent.ci_number} ${rel} ${child.ci_number}`, req);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch {
    res.status(409).json({ error: 'That relationship already exists' });
  }
});

router.delete('/relationships/:relId', requireRole('TEAM_LEAD', 'ADMIN'), (req, res) => {
  const rel = db.prepare('SELECT * FROM ci_relationships WHERE id = ?').get(req.params.relId);
  if (!rel) return res.status(404).json({ error: 'Relationship not found' });
  db.prepare('DELETE FROM ci_relationships WHERE id = ?').run(rel.id);
  audit(req.user.id, 'CI_UNRELATED', 'ci', rel.parent_id, String(rel.id), req);
  res.json({ ok: true });
});

module.exports = router;
