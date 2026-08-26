const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { authenticate, requireRole } = require('../auth');
const { audit } = require('../services');

const router = express.Router();
router.use(authenticate, requireRole('ADMIN'));

// ---------- Users ----------
router.get('/users', (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.email, u.full_name, u.role, u.active, u.phone, u.created_at,
           u.department_id, u.location_id, u.support_group_id,
           d.name AS department_name, l.name AS location_name, g.name AS group_name
    FROM users u
    LEFT JOIN departments d ON d.id = u.department_id
    LEFT JOIN locations l ON l.id = u.location_id
    LEFT JOIN support_groups g ON g.id = u.support_group_id
    ORDER BY u.full_name`).all());
});

router.post('/users', (req, res) => {
  const { email, full_name, role, password, department_id, location_id, support_group_id, phone } = req.body || {};
  if (!email || !full_name) return res.status(400).json({ error: 'Email and full name are required' });
  if (!['EMPLOYEE', 'AGENT', 'TEAM_LEAD', 'ADMIN'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'A user with this email already exists' });
  }
  const pw = password && password.length >= 8 ? password : 'Welcome1!';
  const info = db.prepare(`INSERT INTO users
    (email, password_hash, full_name, role, department_id, location_id, support_group_id, phone, must_change_password)
    VALUES (?,?,?,?,?,?,?,?,1)`)
    .run(email.trim(), bcrypt.hashSync(pw, 10), full_name.trim(), role,
      department_id || null, location_id || null, support_group_id || null, phone || null);
  audit(req.user.id, 'USER_CREATED', 'user', info.lastInsertRowid, email, req);
  res.status(201).json({ id: info.lastInsertRowid, temp_password: password ? undefined : pw });
});

router.patch('/users/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { full_name, role, department_id, location_id, support_group_id, phone, active, reset_password } = req.body || {};
  if (role && !['EMPLOYEE', 'AGENT', 'TEAM_LEAD', 'ADMIN'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  if (active === 0 && user.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot deactivate your own account' });
  }
  let tempPassword;
  if (reset_password) {
    tempPassword = 'Reset' + Math.random().toString(36).slice(2, 8) + '!';
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?')
      .run(bcrypt.hashSync(tempPassword, 10), user.id);
  }
  db.prepare(`UPDATE users SET
      full_name = COALESCE(?, full_name),
      role = COALESCE(?, role),
      department_id = ?, location_id = ?, support_group_id = ?,
      phone = ?, active = COALESCE(?, active)
    WHERE id = ?`)
    .run(full_name || null, role || null,
      department_id !== undefined ? department_id : user.department_id,
      location_id !== undefined ? location_id : user.location_id,
      support_group_id !== undefined ? support_group_id : user.support_group_id,
      phone !== undefined ? phone : user.phone,
      active !== undefined ? (active ? 1 : 0) : null,
      user.id);
  audit(req.user.id, 'USER_UPDATED', 'user', user.id, JSON.stringify(req.body), req);
  res.json({ ok: true, temp_password: tempPassword });
});

// ---------- Generic reference-data CRUD ----------
function crud(name, table, columns) {
  router.get(`/${name}`, (_req, res) => {
    res.json(db.prepare(`SELECT * FROM ${table} ORDER BY name`).all());
  });
  router.post(`/${name}`, (req, res) => {
    const vals = columns.map((c) => req.body?.[c] ?? null);
    if (!req.body?.name) return res.status(400).json({ error: 'Name is required' });
    try {
      const info = db.prepare(
        `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
      ).run(...vals);
      audit(req.user.id, `${table.toUpperCase()}_CREATED`, table, info.lastInsertRowid, req.body.name, req);
      res.status(201).json({ id: info.lastInsertRowid });
    } catch (e) {
      res.status(409).json({ error: `That name already exists` });
    }
  });
  router.patch(`/${name}/:id`, (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const sets = [];
    const vals = [];
    for (const c of [...columns, 'active']) {
      if (req.body?.[c] !== undefined) { sets.push(`${c} = ?`); vals.push(req.body[c]); }
    }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.id);
    try {
      db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      audit(req.user.id, `${table.toUpperCase()}_UPDATED`, table, req.params.id, JSON.stringify(req.body), req);
      res.json({ ok: true });
    } catch {
      res.status(409).json({ error: 'That name already exists' });
    }
  });
}

crud('departments', 'departments', ['name']);
crud('locations', 'locations', ['name', 'city', 'country']);
crud('groups', 'support_groups', ['name', 'description']);
crud('categories', 'categories', ['name', 'icon']);

// Subcategories (nested under category)
router.post('/categories/:id/subcategories', (req, res) => {
  if (!req.body?.name) return res.status(400).json({ error: 'Name is required' });
  try {
    const info = db.prepare('INSERT INTO subcategories (category_id, name) VALUES (?,?)')
      .run(req.params.id, req.body.name);
    audit(req.user.id, 'SUBCATEGORY_CREATED', 'subcategories', info.lastInsertRowid, req.body.name, req);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch {
    res.status(409).json({ error: 'That subcategory already exists in this category' });
  }
});
router.patch('/subcategories/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM subcategories WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE subcategories SET name = COALESCE(?, name), active = COALESCE(?, active) WHERE id = ?')
    .run(req.body?.name || null, req.body?.active !== undefined ? (req.body.active ? 1 : 0) : null, req.params.id);
  res.json({ ok: true });
});

// Priority configuration (labels/descriptions editable; P1–P4 fixed per BRD)
router.patch('/priorities/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM priorities WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE priorities SET label = COALESCE(?, label), description = COALESCE(?, description) WHERE id = ?')
    .run(req.body?.label || null, req.body?.description || null, req.params.id);
  audit(req.user.id, 'PRIORITY_UPDATED', 'priorities', req.params.id, JSON.stringify(req.body), req);
  res.json({ ok: true });
});

// ---------- STANDARD S3: assignment rules ----------
router.get('/assignment-rules', (_req, res) => {
  res.json(db.prepare(`
    SELECT r.*, c.name AS category_name, sc.name AS subcategory_name,
      p.code AS priority_code, l.name AS location_name, d.name AS department_name,
      g.name AS target_group_name, u.full_name AS target_agent_name
    FROM assignment_rules r
    LEFT JOIN categories c ON c.id = r.category_id
    LEFT JOIN subcategories sc ON sc.id = r.subcategory_id
    LEFT JOIN priorities p ON p.id = r.priority_id
    LEFT JOIN locations l ON l.id = r.location_id
    LEFT JOIN departments d ON d.id = r.department_id
    JOIN support_groups g ON g.id = r.target_group_id
    LEFT JOIN users u ON u.id = r.target_agent_id
    ORDER BY r.sort ASC, r.id ASC`).all());
});

router.post('/assignment-rules', (req, res) => {
  const { name, sort, category_id, subcategory_id, priority_id, location_id,
    department_id, target_group_id, target_agent_id } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Rule name is required' });
  if (!target_group_id || !db.prepare('SELECT id FROM support_groups WHERE id = ?').get(target_group_id)) {
    return res.status(400).json({ error: 'A valid target assignment group is required' });
  }
  // No conditions = catch-all rule (matches every ticket; first match by sort wins).
  const info = db.prepare(`INSERT INTO assignment_rules
    (name, sort, category_id, subcategory_id, priority_id, location_id, department_id,
     target_group_id, target_agent_id)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(String(name).trim(), Number.isInteger(sort) ? sort : 100,
      category_id || null, subcategory_id || null, priority_id || null,
      location_id || null, department_id || null, target_group_id, target_agent_id || null);
  audit(req.user.id, 'ASSIGNMENT_RULE_CREATED', 'assignment_rule', info.lastInsertRowid, name, req);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.patch('/assignment-rules/:id', (req, res) => {
  const rule = db.prepare('SELECT * FROM assignment_rules WHERE id = ?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  const fields = ['name', 'sort', 'active', 'category_id', 'subcategory_id', 'priority_id',
    'location_id', 'department_id', 'target_group_id', 'target_agent_id'];
  const sets = [];
  const vals = [];
  for (const f of fields) {
    if (req.body?.[f] !== undefined) { sets.push(`${f} = ?`); vals.push(req.body[f]); }
  }
  if (!sets.length) return res.json({ ok: true });
  vals.push(rule.id);
  db.prepare(`UPDATE assignment_rules SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  audit(req.user.id, 'ASSIGNMENT_RULE_UPDATED', 'assignment_rule', rule.id, JSON.stringify(req.body), req);
  res.json({ ok: true });
});

// ---------- STANDARD S8: workflows ----------
const WF_TRIGGERS = new Set([
  'ticket.created', 'ticket.assigned',
  'ticket.status.ASSIGNED', 'ticket.status.IN_PROGRESS', 'ticket.status.PENDING',
  'ticket.status.RESOLVED', 'ticket.status.CLOSED', 'ticket.status.REOPENED',
  // ADVANCED A10: enterprise automation triggers
  'ticket.sla_breach', 'ticket.major_declared',
]);

function validWorkflowBody(body) {
  const { trigger_event, conditions, actions } = body || {};
  if (trigger_event !== undefined && !WF_TRIGGERS.has(trigger_event)) {
    return 'Unknown trigger event';
  }
  for (const [key, val] of [['conditions', conditions], ['actions', actions]]) {
    if (val !== undefined && !Array.isArray(val)) return `${key} must be a list`;
  }
  return null;
}

router.get('/workflows', (_req, res) => {
  res.json(db.prepare('SELECT * FROM workflows ORDER BY sort ASC, id ASC').all()
    .map((w) => ({ ...w, conditions: JSON.parse(w.conditions_json || '[]'), actions: JSON.parse(w.actions_json || '[]') })));
});

router.post('/workflows', (req, res) => {
  const { name, trigger_event, conditions, actions, sort } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Workflow name is required' });
  if (!WF_TRIGGERS.has(trigger_event)) return res.status(400).json({ error: 'Choose a valid trigger event' });
  const err = validWorkflowBody(req.body);
  if (err) return res.status(400).json({ error: err });
  if (!Array.isArray(actions) || !actions.length) return res.status(400).json({ error: 'Add at least one action' });
  const info = db.prepare(`INSERT INTO workflows (name, trigger_event, conditions_json, actions_json, sort)
    VALUES (?,?,?,?,?)`)
    .run(String(name).trim(), trigger_event, JSON.stringify(conditions || []),
      JSON.stringify(actions), Number.isInteger(sort) ? sort : 100);
  audit(req.user.id, 'WORKFLOW_CREATED', 'workflow', info.lastInsertRowid, name, req);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.patch('/workflows/:id', (req, res) => {
  const wf = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });
  const err = validWorkflowBody(req.body);
  if (err) return res.status(400).json({ error: err });
  const { name, trigger_event, conditions, actions, sort, active } = req.body || {};
  db.prepare(`UPDATE workflows SET
      name = COALESCE(?, name), trigger_event = COALESCE(?, trigger_event),
      conditions_json = COALESCE(?, conditions_json),
      actions_json = COALESCE(?, actions_json),
      sort = COALESCE(?, sort), active = COALESCE(?, active)
    WHERE id = ?`)
    .run(name ? String(name).trim() : null, trigger_event || null,
      conditions !== undefined ? JSON.stringify(conditions) : null,
      actions !== undefined ? JSON.stringify(actions) : null,
      Number.isInteger(sort) ? sort : null,
      active !== undefined ? (active ? 1 : 0) : null, wf.id);
  audit(req.user.id, 'WORKFLOW_UPDATED', 'workflow', wf.id, JSON.stringify(req.body), req);
  res.json({ ok: true });
});

// ---------- ADVANCED closeout: database backups (BRD 6.14) ----------
const { runBackup, listBackups } = require('../backup');

router.get('/backups', (_req, res) => {
  res.json(listBackups());
});

router.post('/backups', async (req, res) => {
  try {
    const r = await runBackup();
    audit(req.user.id, 'BACKUP_CREATED', 'backup', r.file, `${r.size_bytes} bytes, pruned ${r.pruned}`, req);
    res.status(201).json(r);
  } catch (err) {
    res.status(500).json({ error: `Backup failed: ${err.message}` });
  }
});

// ---------- Audit log ----------
router.get('/audit', (req, res) => {
  res.json(db.prepare(`
    SELECT a.*, u.full_name AS actor_name
    FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
    ORDER BY a.id DESC LIMIT 300`).all());
});

module.exports = router;
