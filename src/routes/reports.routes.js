const express = require('express');
const { db } = require('../db');
const { authenticate, requireRole, IT_ROLES } = require('../auth');
const { reportInsights } = require('../dashboard');
const { catalog, buildReport, renderReport } = require('../reportBuilder');
const { audit } = require('../services');

const router = express.Router();
router.use(authenticate);

// ---------- Report generator ----------
// GET /reports/catalog → available report types.
// GET /reports/generate?type=&from=&to=&group_id=&priority_id=&category_id=&status=&format=json|csv|xlsx|pdf
router.get('/catalog', requireRole(...IT_ROLES), (_req, res) => res.json(catalog()));

router.get('/generate', requireRole(...IT_ROLES), async (req, res, next) => {
  try {
    const rep = buildReport(req.user, req.query);
    const format = String(req.query.format || 'json').toLowerCase();
    if (format === 'json') return res.json(rep);
    const { buffer, mime, filename } = await renderReport(rep, format);
    audit(req.user.id, 'REPORT_EXPORTED', 'report', rep.type, `${format} ${rep.period.from}..${rep.period.to} (${rep.row_count} rows)`, req);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Reports workspace insights (agent workload, group performance, backlog,
// resolution/SLA trends, service metrics). Query: from, to, group_id,
// category_id, priority_id, status. Same role scope as /reports/dashboard.
router.get('/insights', requireRole(...IT_ROLES), (req, res) => {
  try {
    res.json(reportInsights(req.user, req.query));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// Per-role dashboard numbers.
router.get('/dashboard', (req, res) => {
  const uid = req.user.id;
  if (req.user.role === 'EMPLOYEE') {
    const my = (cond) => db.prepare(
      `SELECT COUNT(*) AS n FROM tickets WHERE requester_id = ? AND ${cond}`
    ).get(uid).n;
    return res.json({
      role: 'EMPLOYEE',
      open: my("status IN ('NEW','ASSIGNED','IN_PROGRESS','REOPENED')"),
      pending: my("status = 'PENDING'"),
      resolved: my("status = 'RESOLVED'"),
      closed: my("status = 'CLOSED'"),
      recent: db.prepare(`
        SELECT t.id, t.ticket_number, t.title, t.status, t.updated_at, p.code AS priority_code
        FROM tickets t JOIN priorities p ON p.id = t.priority_id
        WHERE t.requester_id = ? ORDER BY t.updated_at DESC LIMIT 6`).all(uid),
    });
  }

  // IT roles
  const gid = req.user.support_group_id;
  const isAdmin = req.user.role === 'ADMIN';
  const teamCond = isAdmin ? '1=1' : '(support_group_id = @gid OR support_group_id IS NULL)';
  const count = (cond) => db.prepare(
    `SELECT COUNT(*) AS n FROM tickets WHERE ${cond}`
  ).get({ uid, gid }).n;

  res.json({
    role: req.user.role,
    mine: count('assigned_agent_id = @uid AND status NOT IN (\'RESOLVED\',\'CLOSED\')'),
    unassigned: count(`assigned_agent_id IS NULL AND status IN ('NEW','REOPENED') AND ${teamCond}`),
    open: count(`status IN ('NEW','ASSIGNED','IN_PROGRESS','REOPENED') AND ${teamCond}`),
    pending: count(`status = 'PENDING' AND ${teamCond}`),
    resolvedToday: count(`status = 'RESOLVED' AND date(resolved_at) = date('now') AND ${teamCond}`),
    total: count(isAdmin ? '1=1' : teamCond),
    closed: count(`status = 'CLOSED' AND ${teamCond}`),
    byPriority: db.prepare(`
      SELECT p.code, COUNT(t.id) AS n
      FROM priorities p LEFT JOIN tickets t
        ON t.priority_id = p.id AND t.status NOT IN ('RESOLVED','CLOSED')
        ${isAdmin ? '' : 'AND (t.support_group_id = @gid OR t.support_group_id IS NULL)'}
      GROUP BY p.id ORDER BY p.sort`).all({ gid }),
    byStatus: db.prepare(`
      SELECT status, COUNT(*) AS n FROM tickets
      ${isAdmin ? '' : 'WHERE (support_group_id = @gid OR support_group_id IS NULL)'}
      GROUP BY status`).all({ gid }),
  });
});

// Basic reports (BRD 6.2): by status / priority / category / agent / group
router.get('/tickets', requireRole(...IT_ROLES), (req, res) => {
  const { from, to } = req.query;
  const where = [];
  const params = {};
  if (from) { where.push('date(t.created_at) >= date(@from)'); params.from = from; }
  if (to) { where.push('date(t.created_at) <= date(@to)'); params.to = to; }
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const group = (expr, label) => db.prepare(`
    SELECT ${expr} AS label, COUNT(*) AS n FROM tickets t
    ${label === 'agent' ? 'LEFT JOIN users u ON u.id = t.assigned_agent_id' : ''}
    ${label === 'category' ? 'JOIN categories c ON c.id = t.category_id' : ''}
    ${label === 'priority' ? 'JOIN priorities p ON p.id = t.priority_id' : ''}
    ${label === 'group' ? 'LEFT JOIN support_groups g ON g.id = t.support_group_id' : ''}
    ${W} GROUP BY label ORDER BY n DESC`).all(params);

  res.json({
    total: db.prepare(`SELECT COUNT(*) AS n FROM tickets t ${W}`).get(params).n,
    open: db.prepare(`SELECT COUNT(*) AS n FROM tickets t ${W ? W + ' AND' : 'WHERE'} t.status NOT IN ('RESOLVED','CLOSED')`).get(params).n,
    closed: db.prepare(`SELECT COUNT(*) AS n FROM tickets t ${W ? W + ' AND' : 'WHERE'} t.status = 'CLOSED'`).get(params).n,
    byStatus: group('t.status', 'status'),
    byPriority: group('p.code', 'priority'),
    byCategory: group('c.name', 'category'),
    byAgent: group("COALESCE(u.full_name, 'Unassigned')", 'agent'),
    byGroup: group("COALESCE(g.name, 'No group')", 'group'),
    daily: db.prepare(`
      SELECT date(t.created_at) AS day, COUNT(*) AS n FROM tickets t
      ${W} GROUP BY day ORDER BY day DESC LIMIT 30`).all(params),
  });
});

// ---------- STANDARD S9: advanced reports (BRD 7.12) ----------
router.get('/standard', requireRole(...IT_ROLES), (req, res) => {
  const { from, to } = req.query;
  const where = [];
  const params = {};
  if (from) { where.push('date(t.created_at) >= date(@from)'); params.from = from; }
  if (to) { where.push('date(t.created_at) <= date(@to)'); params.to = to; }
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const AND = where.length ? ' AND ' : ' WHERE ';

  // SLA compliance / breach
  const sla = db.prepare(`
    SELECT COUNT(*) AS tracked,
      SUM(CASE WHEN s.resolution_breached = 1 THEN 1 ELSE 0 END) AS breached,
      SUM(CASE WHEN s.completed_at IS NOT NULL AND s.resolution_breached = 0 THEN 1 ELSE 0 END) AS met,
      SUM(CASE WHEN s.response_breached = 1 THEN 1 ELSE 0 END) AS response_breached
    FROM ticket_sla s JOIN tickets t ON t.id = s.ticket_id ${W}`).get(params);

  // MTTR (minutes, resolved tickets) and first response time
  const mttr = db.prepare(`
    SELECT AVG((julianday(t.resolved_at) - julianday(t.created_at)) * 24 * 60) AS minutes
    FROM tickets t ${W}${AND}t.resolved_at IS NOT NULL`).get(params);
  const frt = db.prepare(`
    SELECT AVG((julianday(s.first_response_at) - julianday(t.created_at)) * 24 * 60) AS minutes
    FROM ticket_sla s JOIN tickets t ON t.id = s.ticket_id
    ${W}${AND}s.first_response_at IS NOT NULL`).get(params);

  // First contact resolution: resolved without any reassignment
  const fcr = db.prepare(`
    SELECT COUNT(*) AS resolved,
      SUM(CASE WHEN NOT EXISTS (
        SELECT 1 FROM ticket_history h WHERE h.ticket_id = t.id AND h.action = 'REASSIGNED'
      ) THEN 1 ELSE 0 END) AS first_contact
    FROM tickets t ${W}${AND}t.resolved_at IS NOT NULL`).get(params);

  // Ticket aging buckets (open tickets)
  const aging = db.prepare(`
    SELECT CASE
        WHEN julianday('now') - julianday(t.created_at) <= 1 THEN '0-1 days'
        WHEN julianday('now') - julianday(t.created_at) <= 3 THEN '1-3 days'
        WHEN julianday('now') - julianday(t.created_at) <= 7 THEN '3-7 days'
        WHEN julianday('now') - julianday(t.created_at) <= 14 THEN '7-14 days'
        ELSE '14+ days' END AS bucket,
      COUNT(*) AS n
    FROM tickets t
    WHERE t.status NOT IN ('RESOLVED','CLOSED') GROUP BY bucket`).all();

  // Agent productivity
  const agents = db.prepare(`
    SELECT u.full_name AS agent, COUNT(*) AS resolved,
      ROUND(AVG((julianday(t.resolved_at) - julianday(t.created_at)) * 24 * 60)) AS avg_mttr_minutes
    FROM tickets t JOIN users u ON u.id = t.assigned_agent_id
    ${W}${AND}t.resolved_at IS NOT NULL
    GROUP BY u.id ORDER BY resolved DESC LIMIT 20`).all(params);

  // Group performance
  const groups = db.prepare(`
    SELECT COALESCE(g.name, 'No group') AS grp, COUNT(*) AS total,
      SUM(CASE WHEN t.status IN ('RESOLVED','CLOSED') THEN 1 ELSE 0 END) AS resolved,
      SUM(CASE WHEN s.resolution_breached = 1 THEN 1 ELSE 0 END) AS breached
    FROM tickets t
    LEFT JOIN support_groups g ON g.id = t.support_group_id
    LEFT JOIN ticket_sla s ON s.ticket_id = t.id
    ${W} GROUP BY grp ORDER BY total DESC`).all(params);

  // Trends (last 12 weeks by category / location / department of requester)
  const trend = (join, label) => db.prepare(`
    SELECT strftime('%Y-%W', t.created_at) AS week, ${label} AS label, COUNT(*) AS n
    FROM tickets t ${join}
    WHERE julianday('now') - julianday(t.created_at) <= 84
    GROUP BY week, label ORDER BY week ASC`).all();
  const categoryTrend = trend('JOIN categories c ON c.id = t.category_id', 'c.name');
  const locationTrend = trend('LEFT JOIN locations l ON l.id = t.location_id', "COALESCE(l.name,'Unknown')");
  const departmentTrend = trend(
    'JOIN users u ON u.id = t.requester_id LEFT JOIN departments d ON d.id = u.department_id',
    "COALESCE(d.name,'Unknown')");

  // Recurring issues: same category+subcategory appearing most in the window
  const recurring = db.prepare(`
    SELECT c.name AS category, COALESCE(sc.name, '(no subcategory)') AS subcategory, COUNT(*) AS n
    FROM tickets t
    JOIN categories c ON c.id = t.category_id
    LEFT JOIN subcategories sc ON sc.id = t.subcategory_id
    ${W} GROUP BY c.id, sc.id HAVING COUNT(*) >= 2 ORDER BY n DESC LIMIT 15`).all(params);

  res.json({
    sla: {
      tracked: sla.tracked || 0,
      met: sla.met || 0,
      breached: sla.breached || 0,
      response_breached: sla.response_breached || 0,
      compliance_pct: sla.tracked ? Math.round((1 - (sla.breached || 0) / sla.tracked) * 100) : null,
    },
    mttr_minutes: mttr.minutes ? Math.round(mttr.minutes) : null,
    first_response_minutes: frt.minutes ? Math.round(frt.minutes) : null,
    fcr: {
      resolved: fcr.resolved || 0,
      first_contact: fcr.first_contact || 0,
      pct: fcr.resolved ? Math.round(((fcr.first_contact || 0) / fcr.resolved) * 100) : null,
    },
    aging, agents, groups, categoryTrend, locationTrend, departmentTrend, recurring,
  });
});

module.exports = router;
