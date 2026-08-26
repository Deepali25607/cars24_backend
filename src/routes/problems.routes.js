const express = require('express');
const { db, nextProblemNumber } = require('../db');
const { authenticate, requireRole, IT_ROLES } = require('../auth');
const { audit, notifyUser } = require('../services');

const router = express.Router();
router.use(authenticate, requireRole(...IT_ROLES));

// BRD 8.4: problem creation, RCA, known error, workaround, permanent
// resolution, related incidents, problem tasks, closure.

const PROBLEM_SELECT = `
  SELECT pr.*, c.name AS category_name, p.code AS priority_code,
    g.name AS group_name, ag.full_name AS agent_name, cb.full_name AS created_by_name,
    (SELECT COUNT(*) FROM problem_tickets pt WHERE pt.problem_id = pr.id) AS linked_count
  FROM problems pr
  LEFT JOIN categories c ON c.id = pr.category_id
  LEFT JOIN priorities p ON p.id = pr.priority_id
  LEFT JOIN support_groups g ON g.id = pr.support_group_id
  LEFT JOIN users ag ON ag.id = pr.assigned_agent_id
  JOIN users cb ON cb.id = pr.created_by
`;

const TRANSITIONS = {
  NEW: ['ROOT_CAUSE_ANALYSIS', 'CLOSED'],
  ROOT_CAUSE_ANALYSIS: ['KNOWN_ERROR', 'RESOLVED'],
  KNOWN_ERROR: ['RESOLVED', 'ROOT_CAUSE_ANALYSIS'],
  RESOLVED: ['CLOSED', 'ROOT_CAUSE_ANALYSIS'],
  CLOSED: [],
};

function getProblem(id) { return db.prepare(`${PROBLEM_SELECT} WHERE pr.id = ?`).get(id); }

function touch(id) { db.prepare("UPDATE problems SET updated_at = datetime('now') WHERE id = ?").run(id); }

function fullProblem(id) {
  const problem = getProblem(id);
  const tickets = db.prepare(`
    SELECT t.id, t.ticket_number, t.title, t.status
    FROM problem_tickets pt JOIN tickets t ON t.id = pt.ticket_id
    WHERE pt.problem_id = ? ORDER BY t.created_at DESC`).all(id);
  const tasks = db.prepare(`
    SELECT pt.*, u.full_name AS agent_name
    FROM problem_tasks pt LEFT JOIN users u ON u.id = pt.assigned_agent_id
    WHERE pt.problem_id = ? ORDER BY pt.id ASC`).all(id);
  return { ...problem, tickets, tasks };
}

router.get('/', (req, res) => {
  const { status, q } = req.query;
  const where = [];
  const params = {};
  if (status) { where.push('pr.status = @status'); params.status = status; }
  if (q) { where.push('(pr.title LIKE @q OR pr.problem_number LIKE @q)'); params.q = `%${q}%`; }
  res.json(db.prepare(`${PROBLEM_SELECT}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY pr.updated_at DESC LIMIT 300`).all(params));
});

router.get('/:id', (req, res) => {
  const problem = getProblem(req.params.id);
  if (!problem) return res.status(404).json({ error: 'Problem not found' });
  res.json(fullProblem(problem.id));
});

router.post('/', (req, res) => {
  const { title, description, category_id, priority_id, support_group_id, ticket_ids } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required' });
  if (!description || !String(description).trim()) return res.status(400).json({ error: 'Description is required' });
  const number = nextProblemNumber();
  const info = db.prepare(`INSERT INTO problems
    (problem_number, title, description, category_id, priority_id, support_group_id, created_by)
    VALUES (?,?,?,?,?,?,?)`)
    .run(number, String(title).trim(), String(description).trim(),
      category_id || null, priority_id || null, support_group_id || null, req.user.id);
  const id = info.lastInsertRowid;
  for (const tid of Array.isArray(ticket_ids) ? ticket_ids : []) {
    if (db.prepare('SELECT id FROM tickets WHERE id = ?').get(tid)) {
      db.prepare('INSERT OR IGNORE INTO problem_tickets (problem_id, ticket_id) VALUES (?,?)').run(id, tid);
    }
  }
  audit(req.user.id, 'PROBLEM_CREATED', 'problem', id, number, req);
  res.status(201).json(fullProblem(id));
});

router.patch('/:id', (req, res) => {
  const problem = getProblem(req.params.id);
  if (!problem) return res.status(404).json({ error: 'Problem not found' });
  const fields = ['title', 'description', 'root_cause', 'workaround', 'permanent_fix',
    'category_id', 'priority_id', 'support_group_id', 'assigned_agent_id'];
  const sets = [];
  const vals = [];
  for (const f of fields) {
    if (req.body?.[f] !== undefined) { sets.push(`${f} = ?`); vals.push(req.body[f]); }
  }
  if (sets.length) {
    vals.push(problem.id);
    db.prepare(`UPDATE problems SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    touch(problem.id);
    audit(req.user.id, 'PROBLEM_UPDATED', 'problem', problem.id, Object.keys(req.body).join(','), req);
  }
  res.json(fullProblem(problem.id));
});

router.post('/:id/status', (req, res) => {
  const problem = getProblem(req.params.id);
  if (!problem) return res.status(404).json({ error: 'Problem not found' });
  const target = String((req.body || {}).status || '').toUpperCase();
  const allowed = TRANSITIONS[problem.status] || [];
  if (!allowed.includes(target)) {
    return res.status(400).json({ error: `Cannot move a ${problem.status.replaceAll('_', ' ').toLowerCase()} problem to ${target.replaceAll('_', ' ').toLowerCase()}` });
  }
  if (target === 'KNOWN_ERROR' && !problem.root_cause && !(req.body || {}).root_cause) {
    return res.status(400).json({ error: 'Record the root cause before marking a known error' });
  }
  if (target === 'RESOLVED' && !problem.permanent_fix && !(req.body || {}).permanent_fix) {
    return res.status(400).json({ error: 'Record the permanent resolution before resolving the problem' });
  }
  const { root_cause, workaround, permanent_fix } = req.body || {};
  db.prepare(`UPDATE problems SET status = ?,
      root_cause = COALESCE(?, root_cause),
      workaround = COALESCE(?, workaround),
      permanent_fix = COALESCE(?, permanent_fix),
      closed_at = CASE WHEN ? = 'CLOSED' THEN datetime('now') ELSE closed_at END
    WHERE id = ?`)
    .run(target, root_cause || null, workaround || null, permanent_fix || null, target, problem.id);
  touch(problem.id);
  audit(req.user.id, 'PROBLEM_STATUS', 'problem', problem.id, target, req);

  // Closing with a permanent fix notifies agents on linked incidents.
  if (target === 'RESOLVED' || target === 'CLOSED') {
    const linked = db.prepare(`
      SELECT DISTINCT t.assigned_agent_id AS uid, t.ticket_number
      FROM problem_tickets pt JOIN tickets t ON t.id = pt.ticket_id
      WHERE pt.problem_id = ? AND t.assigned_agent_id IS NOT NULL`).all(problem.id);
    for (const l of linked) {
      notifyUser(l.uid, null, 'PROBLEM_RESOLVED',
        `Problem ${problem.problem_number} affecting ${l.ticket_number} has a permanent resolution.`);
    }
  }
  res.json(fullProblem(problem.id));
});

router.post('/:id/tickets', (req, res) => {
  const problem = getProblem(req.params.id);
  if (!problem) return res.status(404).json({ error: 'Problem not found' });
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get((req.body || {}).ticket_id);
  if (!ticket) return res.status(400).json({ error: 'Unknown ticket' });
  db.prepare('INSERT OR IGNORE INTO problem_tickets (problem_id, ticket_id) VALUES (?,?)')
    .run(problem.id, ticket.id);
  touch(problem.id);
  res.status(201).json(fullProblem(problem.id));
});

router.delete('/:id/tickets/:ticketId', (req, res) => {
  db.prepare('DELETE FROM problem_tickets WHERE problem_id = ? AND ticket_id = ?')
    .run(req.params.id, req.params.ticketId);
  res.json(fullProblem(req.params.id));
});

router.post('/:id/tasks', (req, res) => {
  const problem = getProblem(req.params.id);
  if (!problem) return res.status(404).json({ error: 'Problem not found' });
  const { title } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Task title is required' });
  db.prepare('INSERT INTO problem_tasks (problem_id, title) VALUES (?,?)').run(problem.id, String(title).trim());
  touch(problem.id);
  res.status(201).json(fullProblem(problem.id));
});

router.post('/tasks/:taskId', (req, res) => {
  const task = db.prepare('SELECT * FROM problem_tasks WHERE id = ?').get(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const target = String((req.body || {}).status || '').toUpperCase();
  if (!['OPEN', 'IN_PROGRESS', 'DONE'].includes(target)) {
    return res.status(400).json({ error: 'Task status must be OPEN, IN_PROGRESS or DONE' });
  }
  db.prepare(`UPDATE problem_tasks SET status = ?,
      assigned_agent_id = COALESCE(assigned_agent_id, ?),
      done_at = CASE WHEN ? = 'DONE' THEN datetime('now') ELSE done_at END
    WHERE id = ?`)
    .run(target, req.user.id, target, task.id);
  touch(task.problem_id);
  res.json(fullProblem(task.problem_id));
});

module.exports = router;
