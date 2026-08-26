const express = require('express');
const { db } = require('../db');
const { authenticate, requireRole, IT_ROLES } = require('../auth');
const { audit } = require('../services');
const { sweepSla } = require('../sla');
const { runDueJobs } = require('../workflow');
const { getBusinessHours, setBusinessHours } = require('../calendar');

const router = express.Router();
router.use(authenticate);

// ---------- Policies ----------
router.get('/policies', requireRole(...IT_ROLES), (_req, res) => {
  res.json(db.prepare(`
    SELECT sp.*, p.code AS priority_code, p.label AS priority_label
    FROM sla_policies sp JOIN priorities p ON p.id = sp.priority_id
    ORDER BY p.sort ASC`).all());
});

router.patch('/policies/:id', requireRole('ADMIN'), (req, res) => {
  const policy = db.prepare('SELECT * FROM sla_policies WHERE id = ?').get(req.params.id);
  if (!policy) return res.status(404).json({ error: 'SLA policy not found' });
  const { response_minutes, resolution_minutes, use_business_hours, active, approved } = req.body || {};
  if (response_minutes !== undefined && (!Number.isInteger(response_minutes) || response_minutes < 1)) {
    return res.status(400).json({ error: 'Response minutes must be a positive whole number' });
  }
  if (resolution_minutes !== undefined && (!Number.isInteger(resolution_minutes) || resolution_minutes < 1)) {
    return res.status(400).json({ error: 'Resolution minutes must be a positive whole number' });
  }
  db.prepare(`UPDATE sla_policies SET
      response_minutes = COALESCE(?, response_minutes),
      resolution_minutes = COALESCE(?, resolution_minutes),
      use_business_hours = COALESCE(?, use_business_hours),
      active = COALESCE(?, active),
      approved = COALESCE(?, approved)
    WHERE id = ?`)
    .run(response_minutes ?? null, resolution_minutes ?? null,
      use_business_hours !== undefined ? (use_business_hours ? 1 : 0) : null,
      active !== undefined ? (active ? 1 : 0) : null,
      approved !== undefined ? (approved ? 1 : 0) : null,
      policy.id);
  audit(req.user.id, 'SLA_POLICY_UPDATED', 'sla_policy', policy.id, JSON.stringify(req.body), req);
  res.json(db.prepare('SELECT * FROM sla_policies WHERE id = ?').get(policy.id));
});

// ---------- Business calendar ----------
router.get('/calendar', requireRole(...IT_ROLES), (_req, res) => {
  res.json({
    business_hours: getBusinessHours(),
    holidays: db.prepare('SELECT * FROM holidays ORDER BY date ASC').all(),
  });
});

router.put('/calendar/hours', requireRole('ADMIN'), (req, res) => {
  const { days, start, end } = req.body || {};
  if (!Array.isArray(days) || !days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return res.status(400).json({ error: 'Days must be a list of weekday numbers (0=Sunday .. 6=Saturday)' });
  }
  if (!/^\d{2}:\d{2}$/.test(String(start)) || !/^\d{2}:\d{2}$/.test(String(end)) || start >= end) {
    return res.status(400).json({ error: 'Start/end must be HH:MM with start before end' });
  }
  setBusinessHours({ days, start, end });
  audit(req.user.id, 'BUSINESS_HOURS_UPDATED', 'settings', 'business_hours', `${days.join(',')} ${start}-${end}`, req);
  res.json({ business_hours: getBusinessHours() });
});

router.post('/calendar/holidays', requireRole('ADMIN'), (req, res) => {
  const { date, name } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Holiday name is required' });
  try {
    const info = db.prepare('INSERT INTO holidays (date, name) VALUES (?,?)').run(date, String(name).trim());
    audit(req.user.id, 'HOLIDAY_CREATED', 'holiday', info.lastInsertRowid, `${date} ${name}`, req);
    res.status(201).json(db.prepare('SELECT * FROM holidays WHERE id = ?').get(info.lastInsertRowid));
  } catch {
    res.status(409).json({ error: 'That date is already a holiday' });
  }
});

router.delete('/calendar/holidays/:id', requireRole('ADMIN'), (req, res) => {
  const row = db.prepare('SELECT * FROM holidays WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Holiday not found' });
  db.prepare('DELETE FROM holidays WHERE id = ?').run(row.id);
  audit(req.user.id, 'HOLIDAY_DELETED', 'holiday', row.id, `${row.date} ${row.name}`, req);
  res.json({ ok: true });
});

// ---------- SLA dashboard (BRD 7.4) ----------
router.get('/dashboard', requireRole(...IT_ROLES), (_req, res) => {
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS tracked,
      SUM(CASE WHEN completed_at IS NOT NULL AND resolution_breached = 0 THEN 1 ELSE 0 END) AS met,
      SUM(CASE WHEN resolution_breached = 1 THEN 1 ELSE 0 END) AS breached,
      SUM(CASE WHEN completed_at IS NULL AND paused_at IS NOT NULL THEN 1 ELSE 0 END) AS paused,
      SUM(CASE WHEN completed_at IS NULL AND warning_sent = 1 AND resolution_breached = 0 THEN 1 ELSE 0 END) AS at_risk
    FROM ticket_sla`).get();

  const byPriority = db.prepare(`
    SELECT p.code, COUNT(*) AS tracked,
      SUM(CASE WHEN s.resolution_breached = 1 THEN 1 ELSE 0 END) AS breached
    FROM ticket_sla s
    JOIN tickets t ON t.id = s.ticket_id
    JOIN priorities p ON p.id = t.priority_id
    GROUP BY p.code ORDER BY p.code`).all();

  const atRisk = db.prepare(`
    SELECT t.id, t.ticket_number, t.title, t.status, p.code AS priority_code,
      s.resolution_due_at, s.resolution_breached, s.warning_sent, s.paused_at
    FROM ticket_sla s
    JOIN tickets t ON t.id = s.ticket_id
    JOIN priorities p ON p.id = t.priority_id
    WHERE s.completed_at IS NULL AND t.status NOT IN ('RESOLVED','CLOSED')
      AND (s.warning_sent = 1 OR s.resolution_breached = 1 OR s.response_breached = 1)
    ORDER BY s.resolution_due_at ASC LIMIT 50`).all();

  res.json({ totals, byPriority, atRisk });
});

// ---------- Manual sweep (also used by tests; timer calls the same functions) ----------
router.post('/sweep', requireRole('ADMIN', 'TEAM_LEAD'), (_req, res) => {
  const events = sweepSla();
  const jobs = runDueJobs();
  res.json({ events, jobs_run: jobs });
});

module.exports = router;
