const express = require('express');
const { db, nextChangeNumber } = require('../db');
const { authenticate, requireRole, IT_ROLES } = require('../auth');
const { audit, notifyUser } = require('../services');

const router = express.Router();
router.use(authenticate, requireRole(...IT_ROLES));

// BRD 8.5: standard/normal/emergency changes, risk assessment, approval,
// change calendar, implementation & backout plans, tasks, post-implementation review.

const CHANGE_SELECT = `
  SELECT ch.*, u.full_name AS requested_by_name, g.name AS group_name
  FROM changes ch
  JOIN users u ON u.id = ch.requested_by
  LEFT JOIN support_groups g ON g.id = ch.support_group_id
`;

function getChange(id) { return db.prepare(`${CHANGE_SELECT} WHERE ch.id = ?`).get(id); }
function touch(id) { db.prepare("UPDATE changes SET updated_at = datetime('now') WHERE id = ?").run(id); }

// DEF-A-002 (same rule as requests): approvals are strictly sequential and
// role-reserved — level 1 = Team Lead, level 2 = Administrator; an admin may
// take the Team Lead step only when no active Team Lead exists.
function roleCanAct(user, approverRole) {
  if (approverRole === 'ADMIN') return user.role === 'ADMIN';
  const noLeads = db.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'TEAM_LEAD' AND active = 1"
  ).get().n === 0;
  return user.role === 'TEAM_LEAD' || (user.role === 'ADMIN' && noLeads);
}

function fullChange(id, user) {
  const change = getChange(id);
  const approvals = db.prepare(`
    SELECT ca.*, u.full_name AS approver_name
    FROM change_approvals ca LEFT JOIN users u ON u.id = ca.approver_id
    WHERE ca.change_id = ? ORDER BY ca.level ASC`).all(id);
  const tasks = db.prepare(`
    SELECT ct.*, u.full_name AS agent_name
    FROM change_tasks ct LEFT JOIN users u ON u.id = ct.assigned_agent_id
    WHERE ct.change_id = ? ORDER BY ct.id ASC`).all(id);
  const cis = db.prepare(`
    SELECT c.id, c.ci_number, c.name, c.ci_type, cc.id AS link_id
    FROM change_cis cc JOIN cis c ON c.id = cc.ci_id WHERE cc.change_id = ?`).all(id);
  const nextPending = approvals.find((a) => a.status === 'PENDING') || null;
  const can_approve = !!(nextPending && roleCanAct(user, nextPending.approver_role));
  return {
    ...change, approvals, tasks, cis, can_approve,
    awaiting_role: change.status === 'PENDING_APPROVAL' ? nextPending?.approver_role ?? null : null,
  };
}

router.get('/', (req, res) => {
  const { status, type, q } = req.query;
  const where = [];
  const params = {};
  if (status) { where.push('ch.status = @status'); params.status = status; }
  if (type) { where.push('ch.change_type = @type'); params.type = type; }
  if (q) { where.push('(ch.title LIKE @q OR ch.change_number LIKE @q)'); params.q = `%${q}%`; }
  res.json(db.prepare(`${CHANGE_SELECT}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ch.updated_at DESC LIMIT 300`).all(params));
});

// Change calendar: scheduled/in-progress changes in a window (BRD 8.5).
router.get('/calendar', (req, res) => {
  const from = req.query.from || new Date().toISOString().slice(0, 10);
  const days = Math.min(Number(req.query.days || 30), 90);
  res.json(db.prepare(`${CHANGE_SELECT}
    WHERE ch.planned_start IS NOT NULL
      AND ch.status IN ('APPROVED','SCHEDULED','IN_PROGRESS','COMPLETED','FAILED')
      AND date(ch.planned_start) >= date(@from)
      AND date(ch.planned_start) <= date(@from, '+' || @days || ' days')
    ORDER BY ch.planned_start ASC`).all({ from, days }));
});

router.get('/:id', (req, res) => {
  const change = getChange(req.params.id);
  if (!change) return res.status(404).json({ error: 'Change not found' });
  res.json(fullChange(change.id, req.user));
});

router.post('/', (req, res) => {
  const { title, description, change_type, risk, implementation_plan, backout_plan,
    planned_start, planned_end, support_group_id, ci_ids } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required' });
  if (!description || !String(description).trim()) return res.status(400).json({ error: 'Description is required' });
  const type = ['STANDARD', 'NORMAL', 'EMERGENCY'].includes(change_type) ? change_type : 'NORMAL';
  const riskLevel = ['LOW', 'MEDIUM', 'HIGH'].includes(risk) ? risk : 'MEDIUM';

  const number = nextChangeNumber();
  const info = db.prepare(`INSERT INTO changes
    (change_number, title, description, change_type, risk, implementation_plan,
     backout_plan, planned_start, planned_end, requested_by, support_group_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(number, String(title).trim(), String(description).trim(), type, riskLevel,
      implementation_plan || null, backout_plan || null, planned_start || null,
      planned_end || null, req.user.id, support_group_id || null);
  const id = info.lastInsertRowid;
  for (const ciId of Array.isArray(ci_ids) ? ci_ids : []) {
    if (db.prepare('SELECT id FROM cis WHERE id = ?').get(ciId)) {
      db.prepare('INSERT OR IGNORE INTO change_cis (change_id, ci_id) VALUES (?,?)').run(id, ciId);
    }
  }
  audit(req.user.id, 'CHANGE_CREATED', 'change', id, number, req);
  res.status(201).json(fullChange(id, req.user));
});

router.patch('/:id', (req, res) => {
  const change = getChange(req.params.id);
  if (!change) return res.status(404).json({ error: 'Change not found' });
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(change.status)) {
    return res.status(400).json({ error: 'Only draft or pending changes can be edited' });
  }
  const fields = ['title', 'description', 'change_type', 'risk', 'implementation_plan',
    'backout_plan', 'planned_start', 'planned_end', 'support_group_id'];
  const sets = [];
  const vals = [];
  for (const f of fields) {
    if (req.body?.[f] !== undefined) { sets.push(`${f} = ?`); vals.push(req.body[f]); }
  }
  if (sets.length) {
    vals.push(change.id);
    db.prepare(`UPDATE changes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    touch(change.id);
    audit(req.user.id, 'CHANGE_UPDATED', 'change', change.id, Object.keys(req.body).join(','), req);
  }
  res.json(fullChange(change.id, req.user));
});

// Submit for approval. STANDARD changes are pre-approved by definition;
// NORMAL needs Team Lead + Admin (CAB); EMERGENCY needs Admin only.
router.post('/:id/submit', (req, res) => {
  const change = getChange(req.params.id);
  if (!change) return res.status(404).json({ error: 'Change not found' });
  if (change.status !== 'DRAFT') return res.status(400).json({ error: 'Only draft changes can be submitted' });
  if (!change.implementation_plan || !change.backout_plan) {
    return res.status(400).json({ error: 'Implementation and backout plans are required before submission' });
  }

  if (change.change_type === 'STANDARD') {
    db.prepare("UPDATE changes SET status = 'APPROVED' WHERE id = ?").run(change.id);
  } else {
    db.prepare("UPDATE changes SET status = 'PENDING_APPROVAL' WHERE id = ?").run(change.id);
    if (change.change_type === 'NORMAL') {
      db.prepare("INSERT INTO change_approvals (change_id, approver_role, level) VALUES (?, 'TEAM_LEAD', 1)").run(change.id);
      db.prepare("INSERT INTO change_approvals (change_id, approver_role, level) VALUES (?, 'ADMIN', 2)").run(change.id);
    } else { // EMERGENCY
      db.prepare("INSERT INTO change_approvals (change_id, approver_role, level) VALUES (?, 'ADMIN', 1)").run(change.id);
    }
    const approvers = db.prepare("SELECT id FROM users WHERE role IN ('TEAM_LEAD','ADMIN') AND active = 1").all();
    for (const a of approvers) {
      notifyUser(a.id, null, 'CHANGE_APPROVAL', `Change ${change.change_number} "${change.title}" awaits approval.`);
    }
  }
  touch(change.id);
  audit(req.user.id, 'CHANGE_SUBMITTED', 'change', change.id, change.change_type, req);
  res.json(fullChange(change.id, req.user));
});

router.post('/:id/approve', requireRole('TEAM_LEAD', 'ADMIN'), (req, res) => {
  const change = getChange(req.params.id);
  if (!change) return res.status(404).json({ error: 'Change not found' });
  if (change.status !== 'PENDING_APPROVAL') return res.status(400).json({ error: 'Change is not awaiting approval' });
  const pending = db.prepare(`SELECT * FROM change_approvals
    WHERE change_id = ? AND status = 'PENDING' ORDER BY level ASC LIMIT 1`).get(change.id);
  if (!pending) return res.status(400).json({ error: 'Nothing to approve' });
  if (!roleCanAct(req.user, pending.approver_role)) {
    return res.status(403).json({
      error: pending.approver_role === 'TEAM_LEAD'
        ? 'Awaiting Team Lead approval (level 1) — IT approval unlocks after it'
        : 'This step needs an administrator approval',
    });
  }

  const { decision, note } = req.body || {};
  const approve = decision !== 'reject';
  db.prepare(`UPDATE change_approvals SET status = ?, approver_id = ?, note = ?, acted_at = datetime('now') WHERE id = ?`)
    .run(approve ? 'APPROVED' : 'REJECTED', req.user.id, note || null, pending.id);

  if (!approve) {
    db.prepare("UPDATE changes SET status = 'DRAFT' WHERE id = ?").run(change.id);
    notifyUser(change.requested_by, null, 'CHANGE_REJECTED',
      `Change ${change.change_number} was rejected${note ? `: ${note}` : '.'} It is back in draft.`);
  } else {
    const remaining = db.prepare(
      "SELECT COUNT(*) AS n FROM change_approvals WHERE change_id = ? AND status = 'PENDING'"
    ).get(change.id).n;
    if (remaining === 0) {
      db.prepare("UPDATE changes SET status = 'APPROVED' WHERE id = ?").run(change.id);
      notifyUser(change.requested_by, null, 'CHANGE_APPROVED', `Change ${change.change_number} was approved.`);
    }
  }
  touch(change.id);
  audit(req.user.id, approve ? 'CHANGE_APPROVED' : 'CHANGE_REJECTED', 'change', change.id, note || '', req);
  res.json(fullChange(change.id, req.user));
});

// Lifecycle: APPROVED → SCHEDULED → IN_PROGRESS → COMPLETED/FAILED; CANCELLED from pre-implementation states.
router.post('/:id/status', (req, res) => {
  const change = getChange(req.params.id);
  if (!change) return res.status(404).json({ error: 'Change not found' });
  const target = String((req.body || {}).status || '').toUpperCase();
  const allowed = {
    APPROVED: ['SCHEDULED', 'CANCELLED'],
    SCHEDULED: ['IN_PROGRESS', 'CANCELLED'],
    IN_PROGRESS: ['COMPLETED', 'FAILED'],
    DRAFT: ['CANCELLED'],
    PENDING_APPROVAL: ['CANCELLED'],
  }[change.status] || [];
  if (!allowed.includes(target)) {
    return res.status(400).json({ error: `Cannot move a ${change.status.replaceAll('_', ' ').toLowerCase()} change to ${target.replaceAll('_', ' ').toLowerCase()}` });
  }
  if (target === 'SCHEDULED' && !change.planned_start) {
    return res.status(400).json({ error: 'Set a planned start before scheduling' });
  }
  db.prepare(`UPDATE changes SET status = ?,
      completed_at = CASE WHEN ? IN ('COMPLETED','FAILED') THEN datetime('now') ELSE completed_at END
    WHERE id = ?`).run(target, target, change.id);
  touch(change.id);
  audit(req.user.id, 'CHANGE_STATUS', 'change', change.id, target, req);
  res.json(fullChange(change.id, req.user));
});

// Post-implementation review (BRD 8.5).
router.post('/:id/pir', requireRole('TEAM_LEAD', 'ADMIN'), (req, res) => {
  const change = getChange(req.params.id);
  if (!change) return res.status(404).json({ error: 'Change not found' });
  if (!['COMPLETED', 'FAILED'].includes(change.status)) {
    return res.status(400).json({ error: 'PIR is recorded after implementation completes or fails' });
  }
  const { outcome, notes } = req.body || {};
  if (!['SUCCESSFUL', 'COMPLETED_WITH_ISSUES', 'BACKED_OUT'].includes(outcome)) {
    return res.status(400).json({ error: 'Choose a valid PIR outcome' });
  }
  if (!notes || !String(notes).trim()) return res.status(400).json({ error: 'PIR notes are required' });
  db.prepare('UPDATE changes SET pir_outcome = ?, pir_notes = ? WHERE id = ?')
    .run(outcome, String(notes).trim(), change.id);
  touch(change.id);
  audit(req.user.id, 'CHANGE_PIR', 'change', change.id, outcome, req);
  res.json(fullChange(change.id, req.user));
});

router.post('/:id/tasks', (req, res) => {
  const change = getChange(req.params.id);
  if (!change) return res.status(404).json({ error: 'Change not found' });
  const { title } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Task title is required' });
  db.prepare('INSERT INTO change_tasks (change_id, title) VALUES (?,?)').run(change.id, String(title).trim());
  touch(change.id);
  res.status(201).json(fullChange(change.id, req.user));
});

router.post('/tasks/:taskId', (req, res) => {
  const task = db.prepare('SELECT * FROM change_tasks WHERE id = ?').get(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const target = String((req.body || {}).status || '').toUpperCase();
  if (!['OPEN', 'IN_PROGRESS', 'DONE'].includes(target)) {
    return res.status(400).json({ error: 'Task status must be OPEN, IN_PROGRESS or DONE' });
  }
  db.prepare(`UPDATE change_tasks SET status = ?,
      assigned_agent_id = COALESCE(assigned_agent_id, ?),
      done_at = CASE WHEN ? = 'DONE' THEN datetime('now') ELSE done_at END
    WHERE id = ?`).run(target, req.user.id, target, task.id);
  touch(task.change_id);
  res.json(fullChange(task.change_id, req.user));
});

// Link/unlink CIs
router.post('/:id/cis', (req, res) => {
  const change = getChange(req.params.id);
  if (!change) return res.status(404).json({ error: 'Change not found' });
  const ci = db.prepare('SELECT id FROM cis WHERE id = ?').get((req.body || {}).ci_id);
  if (!ci) return res.status(400).json({ error: 'Unknown configuration item' });
  db.prepare('INSERT OR IGNORE INTO change_cis (change_id, ci_id) VALUES (?,?)').run(change.id, ci.id);
  res.status(201).json(fullChange(change.id, req.user));
});

module.exports = router;
