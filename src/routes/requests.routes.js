const express = require('express');
const { db, nextRequestNumber } = require('../db');
const { authenticate, requireRole, IT_ROLES } = require('../auth');
const { audit, notifyUser } = require('../services');

const router = express.Router();
router.use(authenticate);

// BRD 7.8/7.9: request lifecycle with a configurable two-step approval chain
// (level 1 = manager/TEAM_LEAD, level 2 = IT/ADMIN), then fulfillment tasks.

const REQUEST_SELECT = `
  SELECT r.*, u.full_name AS requester_name, ci.name AS item_name, ci.icon AS item_icon,
    g.name AS group_name
  FROM requests r
  JOIN users u ON u.id = r.requester_id
  JOIN catalog_items ci ON ci.id = r.catalog_item_id
  LEFT JOIN support_groups g ON g.id = r.support_group_id
`;

function getRequest(id) {
  return db.prepare(`${REQUEST_SELECT} WHERE r.id = ?`).get(id);
}

function isIT(user) { return IT_ROLES.includes(user.role); }

function touch(id) {
  db.prepare("UPDATE requests SET updated_at = datetime('now') WHERE id = ?").run(id);
}

// DEF-A-002: approvals are strictly sequential — only the CURRENT (lowest
// pending) level can be acted on, and each level is reserved for its role:
// level 1 = Team Lead, level 2 = Administrator. Safety valve: if no active
// Team Lead exists, an Administrator may take the Team Lead step so
// requests cannot deadlock.
function noActiveLeads() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'TEAM_LEAD' AND active = 1").get().n === 0;
}

function roleCanAct(user, approverRole) {
  if (approverRole === 'ADMIN') return user.role === 'ADMIN';
  // TEAM_LEAD step
  return user.role === 'TEAM_LEAD' || (user.role === 'ADMIN' && noActiveLeads());
}

function fullRequest(id, user) {
  const request = getRequest(id);
  const approvals = db.prepare(`
    SELECT ra.*, u.full_name AS approver_name
    FROM request_approvals ra LEFT JOIN users u ON u.id = ra.approver_id
    WHERE ra.request_id = ? ORDER BY ra.level ASC`).all(id);
  const tasks = db.prepare(`
    SELECT rt.*, u.full_name AS agent_name
    FROM request_tasks rt LEFT JOIN users u ON u.id = rt.assigned_agent_id
    WHERE rt.request_id = ? ORDER BY rt.id ASC`).all(id);
  const nextPending = approvals.find((a) => a.status === 'PENDING') || null;
  const can_approve_level = nextPending && roleCanAct(user, nextPending.approver_role)
    ? nextPending.level : null;
  return {
    ...request, approvals, tasks, can_approve_level,
    awaiting_role: request.status === 'PENDING_APPROVAL' ? nextPending?.approver_role ?? null : null,
  };
}

// ---------- Create (any authenticated user) ----------
router.post('/', (req, res) => {
  const { catalog_item_id, description } = req.body || {};
  const item = db.prepare('SELECT * FROM catalog_items WHERE id = ? AND active = 1').get(catalog_item_id);
  if (!item) return res.status(400).json({ error: 'Please choose a valid catalog item' });

  // DEF-A-001 hardening: request + approval chain/tasks are created
  // atomically — a failure can no longer strand a request without approvers.
  const number = nextRequestNumber();
  const createRequest = db.transaction(() => {
    const status = item.requires_approval ? 'PENDING_APPROVAL' : 'APPROVED';
    const info = db.prepare(`INSERT INTO requests
      (request_number, requester_id, catalog_item_id, description, status, support_group_id)
      VALUES (?,?,?,?,?,?)`)
      .run(number, req.user.id, item.id, description ? String(description).trim() : null,
        status, item.support_group_id || null);
    const newId = info.lastInsertRowid;
    if (item.requires_approval) {
      db.prepare("INSERT INTO request_approvals (request_id, approver_role, level) VALUES (?, 'TEAM_LEAD', 1)").run(newId);
      db.prepare("INSERT INTO request_approvals (request_id, approver_role, level) VALUES (?, 'ADMIN', 2)").run(newId);
    } else {
      db.prepare('INSERT INTO request_tasks (request_id, title) VALUES (?, ?)').run(newId, `Fulfil: ${item.name}`);
      db.prepare("UPDATE requests SET status = 'IN_FULFILLMENT' WHERE id = ?").run(newId);
    }
    return newId;
  });
  const id = createRequest();

  if (item.requires_approval) {
    const approvers = db.prepare("SELECT id FROM users WHERE role IN ('TEAM_LEAD','ADMIN') AND active = 1").all();
    for (const a of approvers) {
      notifyUser(a.id, null, 'REQUEST_APPROVAL', `Request ${number} (${item.name}) awaits approval.`);
    }
  }

  audit(req.user.id, 'REQUEST_CREATED', 'request', id, number, req);
  notifyUser(req.user.id, null, 'REQUEST_CREATED', `Your request ${number} for "${item.name}" has been submitted.`);
  res.status(201).json(fullRequest(id, req.user));
});

// ---------- List ----------
router.get('/', (req, res) => {
  const { scope, status } = req.query;
  const where = [];
  const params = {};
  if (!isIT(req.user) || scope === 'my') {
    where.push('r.requester_id = @uid'); params.uid = req.user.id;
  } else if (scope === 'approvals') {
    // Only requests whose CURRENT pending level is actionable by this user
    // (DEF-A-002: an admin no longer sees requests still awaiting the lead).
    const actionable = req.user.role === 'ADMIN'
      ? (noActiveLeads() ? "('TEAM_LEAD','ADMIN')" : "('ADMIN')")
      : "('TEAM_LEAD')";
    where.push(`(SELECT ra.approver_role FROM request_approvals ra
      WHERE ra.request_id = r.id AND ra.status = 'PENDING'
      ORDER BY ra.level ASC LIMIT 1) IN ${actionable}`);
    where.push("r.status = 'PENDING_APPROVAL'");
  } else if (scope === 'fulfillment') {
    where.push("r.status IN ('APPROVED','IN_FULFILLMENT')");
    if (req.user.role !== 'ADMIN') {
      where.push('(r.support_group_id = @gid OR r.support_group_id IS NULL)');
      params.gid = req.user.support_group_id;
    }
  }
  if (status) { where.push('r.status = @status'); params.status = status; }
  res.json(db.prepare(`${REQUEST_SELECT}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.updated_at DESC LIMIT 300`).all(params));
});

router.get('/:id', (req, res) => {
  const request = getRequest(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.requester_id !== req.user.id && !isIT(req.user)) {
    return res.status(403).json({ error: 'Not permitted' });
  }
  res.json(fullRequest(request.id, req.user));
});

// ---------- Approvals (BRD 7.9) ----------
router.post('/:id/approve', requireRole('TEAM_LEAD', 'ADMIN'), (req, res) => {
  const request = getRequest(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'PENDING_APPROVAL') return res.status(400).json({ error: 'Request is not awaiting approval' });

  const pending = db.prepare(`SELECT * FROM request_approvals
    WHERE request_id = ? AND status = 'PENDING' ORDER BY level ASC LIMIT 1`).get(request.id);
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
  db.prepare(`UPDATE request_approvals SET status = ?, approver_id = ?, note = ?, acted_at = datetime('now')
    WHERE id = ?`)
    .run(approve ? 'APPROVED' : 'REJECTED', req.user.id, note || null, pending.id);

  if (!approve) {
    db.prepare("UPDATE requests SET status = 'REJECTED' WHERE id = ?").run(request.id);
    touch(request.id);
    notifyUser(request.requester_id, null, 'REQUEST_REJECTED',
      `Your request ${request.request_number} was rejected${note ? `: ${note}` : '.'}`);
    audit(req.user.id, 'REQUEST_REJECTED', 'request', request.id, note || '', req);
    return res.json(fullRequest(request.id, req.user));
  }

  const remaining = db.prepare(
    "SELECT COUNT(*) AS n FROM request_approvals WHERE request_id = ? AND status = 'PENDING'"
  ).get(request.id).n;
  if (remaining === 0) {
    const item = db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(request.catalog_item_id);
    db.prepare("UPDATE requests SET status = 'IN_FULFILLMENT' WHERE id = ?").run(request.id);
    db.prepare('INSERT INTO request_tasks (request_id, title) VALUES (?, ?)').run(request.id, `Fulfil: ${item.name}`);
    notifyUser(request.requester_id, null, 'REQUEST_APPROVED',
      `Your request ${request.request_number} was approved and is being fulfilled.`);
  }
  touch(request.id);
  audit(req.user.id, 'REQUEST_APPROVED', 'request', request.id, `level ${pending.level}`, req);
  res.json(fullRequest(request.id, req.user));
});

// ---------- Fulfillment tasks ----------
router.post('/:id/tasks', requireRole(...IT_ROLES), (req, res) => {
  const request = getRequest(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  const { title } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Task title is required' });
  const info = db.prepare('INSERT INTO request_tasks (request_id, title) VALUES (?,?)')
    .run(request.id, String(title).trim());
  touch(request.id);
  res.status(201).json(db.prepare('SELECT * FROM request_tasks WHERE id = ?').get(info.lastInsertRowid));
});

router.post('/tasks/:taskId', requireRole(...IT_ROLES), (req, res) => {
  const task = db.prepare('SELECT * FROM request_tasks WHERE id = ?').get(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const { status, assign_to_me } = req.body || {};
  const target = status ? String(status).toUpperCase() : null;
  if (target && !['OPEN', 'IN_PROGRESS', 'DONE'].includes(target)) {
    return res.status(400).json({ error: 'Task status must be OPEN, IN_PROGRESS or DONE' });
  }
  db.prepare(`UPDATE request_tasks SET
      status = COALESCE(?, status),
      assigned_agent_id = COALESCE(?, assigned_agent_id),
      done_at = CASE WHEN ? = 'DONE' THEN datetime('now') ELSE done_at END
    WHERE id = ?`)
    .run(target, assign_to_me ? req.user.id : null, target, task.id);
  touch(task.request_id);

  // All tasks done -> request completed
  if (target === 'DONE') {
    const open = db.prepare(
      "SELECT COUNT(*) AS n FROM request_tasks WHERE request_id = ? AND status != 'DONE'"
    ).get(task.request_id).n;
    if (open === 0) {
      db.prepare("UPDATE requests SET status = 'COMPLETED', completed_at = datetime('now') WHERE id = ?")
        .run(task.request_id);
      const request = getRequest(task.request_id);
      notifyUser(request.requester_id, null, 'REQUEST_COMPLETED',
        `Your request ${request.request_number} has been completed.`);
      audit(req.user.id, 'REQUEST_COMPLETED', 'request', task.request_id, request.request_number, req);
    }
  }
  res.json(db.prepare('SELECT * FROM request_tasks WHERE id = ?').get(task.id));
});

// ---------- Cancel (requester, while not fulfilled) ----------
router.post('/:id/cancel', (req, res) => {
  const request = getRequest(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.requester_id !== req.user.id && req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Not permitted' });
  }
  if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(request.status)) {
    return res.status(400).json({ error: 'This request can no longer be cancelled' });
  }
  db.prepare("UPDATE requests SET status = 'CANCELLED' WHERE id = ?").run(request.id);
  touch(request.id);
  audit(req.user.id, 'REQUEST_CANCELLED', 'request', request.id, request.request_number, req);
  res.json(fullRequest(request.id, req.user));
});

module.exports = router;
