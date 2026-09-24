const express = require('express');
const { db } = require('../db');
const { authenticate, requireRole, IT_ROLES } = require('../auth');
const { audit } = require('../services');
const { getConfig, updateConfig } = require('../email/config');
const templates = require('../email/templates');
const { processInboundEmail, createTicketFromLog } = require('../email/pipeline');
const queue = require('../email/queue');
const { listenerStatus, mailPollerEnabled } = require('../email/listener');
const { sanitizeHtml } = require('../email/parser');
const elog = require('../email/log');

// ================= Email channel admin API (S10 extension) =================
// /api/email/* — configuration, classification rules, templates, message log,
// quarantine / dead-letter queue, per-ticket thread view.

const router = express.Router();
router.use(authenticate);

const LOG_SELECT = `
  SELECT l.id, l.ticket_id, t.ticket_number, l.message_id, l.in_reply_to, l.direction, l.from_address, l.from_name,
         l.to_addresses, l.cc_addresses, l.subject, l.received_or_sent_at, l.processing_status, l.ignore_reason,
         l.event_type, l.attachments_json, l.auth_results, l.created_at
  FROM email_message_log l LEFT JOIN tickets t ON t.id = l.ticket_id`;

// ---------- Per-ticket thread (IT users) ----------
router.get('/ticket/:id', requireRole(...IT_ROLES), (req, res) => {
  res.json(db.prepare(`${LOG_SELECT} WHERE l.ticket_id = ? ORDER BY l.id ASC`).all(req.params.id));
});

// Everything below is admin-only.
router.use(requireRole('ADMIN'));

// ---------- Status / metrics ----------
router.get('/status', (_req, res) => {
  const last24 = db.prepare(`SELECT direction, processing_status, COUNT(*) AS n FROM email_message_log
    WHERE created_at >= datetime('now', '-1 day') GROUP BY direction, processing_status`).all();
  const jobs = db.prepare('SELECT status, COUNT(*) AS n FROM email_jobs GROUP BY status').all();
  const cfg = getConfig();
  res.json({
    enabled: !!cfg.enabled,
    listener: listenerStatus(),
    mailbox_configured: mailPollerEnabled(),
    smtp_configured: !!process.env.SMTP_HOST,
    metrics: elog.snapshot(),
    last_24h: last24,
    jobs,
    // Production checklist: which settings are present (values never exposed).
    env: {
      NODE_ENV: process.env.NODE_ENV || 'development',
      SMTP_HOST: !!process.env.SMTP_HOST, SMTP_PORT: process.env.SMTP_PORT || '587 (default)',
      SMTP_SECURE: process.env.SMTP_SECURE || 'false (default)', SMTP_USER: !!process.env.SMTP_USER,
      SMTP_PASS: !!process.env.SMTP_PASS, SMTP_FROM: process.env.SMTP_FROM || '(unset → itsm@company.local)',
      MAIL_IN_HOST: process.env.MAIL_IN_HOST || null, MAIL_IN_PORT: process.env.MAIL_IN_PORT || '993 (default)',
      MAIL_IN_SECURE: process.env.MAIL_IN_SECURE || 'true (default)', MAIL_IN_USER: process.env.MAIL_IN_USER || null,
      MAIL_IN_PASS: !!process.env.MAIL_IN_PASS, MAIL_IN_OAUTH_TOKEN: !!process.env.MAIL_IN_OAUTH_TOKEN,
      PORTAL_URL: cfg.portalUrl, mailbox_address: cfg.mailboxAddress, allowed_domains: cfg.allowedDomains,
    },
  });
});

// ---------- Production diagnostics ----------
// Send one test email through the configured SMTP transport and report the
// transport's own error message (the same failure the job queue would retry).
router.post('/test/smtp', async (req, res) => {
  const to = String((req.body || {}).to || req.user.email).trim();
  if (!/@/.test(to)) return res.status(400).json({ error: 'A valid recipient address is required' });
  if (!process.env.SMTP_HOST) {
    return res.status(400).json({ ok: false, error: 'SMTP_HOST is not set on the server — outbound mail is only logged to the console.' });
  }
  const { sendEmail } = require('../services');
  const started = Date.now();
  try {
    const r = await sendEmail(to, `[ITSM] SMTP test ${new Date().toISOString()}`,
      'This is a test message from the ITSM email channel. If you can read this, outbound SMTP works.',
      { html: '<p>This is a test message from the ITSM email channel. If you can read this, outbound SMTP works.</p>', throwOnError: true });
    audit(req.user.id, 'EMAIL_SMTP_TEST', 'email_channel_config', 1, to, req);
    res.json({ ok: true, to, message_id: r.messageId, ms: Date.now() - started, from: process.env.SMTP_FROM || null });
  } catch (err) {
    res.json({ ok: false, to, error: err.message, code: err.code || err.responseCode || null, ms: Date.now() - started });
  }
});

// Connect to the mailbox with the MAIL_IN_* credentials, open INBOX and
// report counts — or the exact IMAP error.
router.post('/test/imap', async (req, res) => {
  const missing = ['MAIL_IN_HOST', 'MAIL_IN_USER'].filter((k) => !process.env[k]);
  if (!process.env.MAIL_IN_PASS && !process.env.MAIL_IN_OAUTH_TOKEN) missing.push('MAIL_IN_PASS (or MAIL_IN_OAUTH_TOKEN)');
  if (missing.length) return res.status(400).json({ ok: false, error: `Missing server settings: ${missing.join(', ')}` });
  const { ImapFlow } = require('imapflow');
  const started = Date.now();
  const client = new ImapFlow({
    host: process.env.MAIL_IN_HOST,
    port: Number(process.env.MAIL_IN_PORT || 993),
    secure: process.env.MAIL_IN_SECURE !== 'false',
    auth: process.env.MAIL_IN_OAUTH_TOKEN
      ? { user: process.env.MAIL_IN_USER, accessToken: process.env.MAIL_IN_OAUTH_TOKEN }
      : { user: process.env.MAIL_IN_USER, pass: process.env.MAIL_IN_PASS },
    logger: false, emitLogs: false, connectionTimeout: 20000, greetingTimeout: 20000,
  });
  try {
    await client.connect();
    const box = await client.mailboxOpen(process.env.MAIL_IN_FOLDER || 'INBOX');
    const unseen = await client.search({ seen: false }, { uid: true });
    const folders = (await client.list()).map((m) => m.path);
    await client.logout();
    audit(req.user.id, 'EMAIL_IMAP_TEST', 'email_channel_config', 1, process.env.MAIL_IN_USER, req);
    res.json({
      ok: true, host: process.env.MAIL_IN_HOST, user: process.env.MAIL_IN_USER, folder: box.path,
      messages: box.exists, unseen: (unseen || []).length, folders: folders.slice(0, 30), ms: Date.now() - started,
    });
  } catch (err) {
    try { await client.logout(); } catch { /* ignore */ }
    res.json({ ok: false, host: process.env.MAIL_IN_HOST, user: process.env.MAIL_IN_USER, error: err.message,
      code: err.code || err.responseText || null, ms: Date.now() - started });
  }
});

// ---------- Configuration ----------
router.get('/config', (_req, res) => {
  const c = getConfig();
  res.json({ ...c, systemAddresses: [...c.systemAddresses] });
});
router.put('/config', (req, res) => {
  try {
    const c = updateConfig(req.body || {}, req.user.id);
    res.json({ ...c, systemAddresses: [...c.systemAddresses] });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---------- Classification rules ----------
const RULE_SELECT = `
  SELECT r.*, c.name AS category_name, sc.name AS subcategory_name, g.name AS group_name, p.code AS priority_code
  FROM email_classification_rules r
  JOIN categories c ON c.id = r.category_id
  LEFT JOIN subcategories sc ON sc.id = r.subcategory_id
  LEFT JOIN support_groups g ON g.id = r.assignment_group_id
  LEFT JOIN priorities p ON p.id = r.default_priority_id`;

router.get('/rules', (_req, res) => {
  res.json(db.prepare(`${RULE_SELECT} ORDER BY c.name, r.keyword`).all());
});

function validateRule(body) {
  const keyword = String(body.keyword || '').trim().toLowerCase();
  if (!keyword || keyword.length > 60) throw new Error('Keyword is required (max 60 chars)');
  const category = db.prepare('SELECT id FROM categories WHERE id = ? AND active = 1').get(body.category_id);
  if (!category) throw new Error('Choose a valid category');
  const weight = Number(body.weight ?? 1);
  if (!Number.isInteger(weight) || weight < 1 || weight > 10) throw new Error('Weight must be 1–10');
  if (body.subcategory_id && !db.prepare('SELECT id FROM subcategories WHERE id = ? AND category_id = ?').get(body.subcategory_id, category.id)) {
    throw new Error('Subcategory does not belong to the chosen category');
  }
  if (body.assignment_group_id && !db.prepare('SELECT id FROM support_groups WHERE id = ?').get(body.assignment_group_id)) {
    throw new Error('Invalid support group');
  }
  if (body.default_priority_id && !db.prepare('SELECT id FROM priorities WHERE id = ?').get(body.default_priority_id)) {
    throw new Error('Invalid priority');
  }
  return {
    keyword, category_id: category.id, weight,
    subcategory_id: body.subcategory_id || null,
    assignment_group_id: body.assignment_group_id || null,
    default_priority_id: body.default_priority_id || null,
    is_active: body.is_active === undefined ? 1 : (body.is_active ? 1 : 0),
  };
}

router.post('/rules', (req, res) => {
  try {
    const r = validateRule(req.body || {});
    const info = db.prepare(`INSERT INTO email_classification_rules
      (keyword, category_id, weight, subcategory_id, assignment_group_id, default_priority_id, is_active)
      VALUES (?,?,?,?,?,?,?)`)
      .run(r.keyword, r.category_id, r.weight, r.subcategory_id, r.assignment_group_id, r.default_priority_id, r.is_active);
    audit(req.user.id, 'EMAIL_RULE_CREATED', 'email_rule', info.lastInsertRowid, r.keyword, req);
    res.status(201).json(db.prepare(`${RULE_SELECT} WHERE r.id = ?`).get(info.lastInsertRowid));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put('/rules/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM email_classification_rules WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Rule not found' });
  try {
    const r = validateRule({ ...existing, ...(req.body || {}) });
    db.prepare(`UPDATE email_classification_rules SET keyword = ?, category_id = ?, weight = ?, subcategory_id = ?,
      assignment_group_id = ?, default_priority_id = ?, is_active = ? WHERE id = ?`)
      .run(r.keyword, r.category_id, r.weight, r.subcategory_id, r.assignment_group_id, r.default_priority_id, r.is_active, existing.id);
    audit(req.user.id, 'EMAIL_RULE_UPDATED', 'email_rule', existing.id, r.keyword, req);
    res.json(db.prepare(`${RULE_SELECT} WHERE r.id = ?`).get(existing.id));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/rules/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM email_classification_rules WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Rule not found' });
  db.prepare('DELETE FROM email_classification_rules WHERE id = ?').run(existing.id);
  audit(req.user.id, 'EMAIL_RULE_DELETED', 'email_rule', existing.id, existing.keyword, req);
  res.json({ ok: true });
});

// Dry-run the classifier against a subject/body (admin tool).
router.post('/rules/test', (req, res) => {
  const { getClassifier } = require('../email/classifier');
  const { subject, body } = req.body || {};
  const result = getClassifier().classify({ subject: subject || '', body: body || '' });
  const cat = result.category_id ? db.prepare('SELECT name FROM categories WHERE id = ?').get(result.category_id) : null;
  const grp = result.assignment_group_id ? db.prepare('SELECT name FROM support_groups WHERE id = ?').get(result.assignment_group_id) : null;
  res.json({ ...result, category_name: cat?.name || null, group_name: grp?.name || null });
});

// ---------- Templates ----------
router.get('/templates', (_req, res) => {
  templates.ensureTemplates();
  res.json({
    placeholders: templates.PLACEHOLDERS,
    templates: db.prepare('SELECT * FROM email_templates ORDER BY id').all(),
  });
});
router.put('/templates/:type', (req, res) => {
  try { res.json(templates.updateTemplate(String(req.params.type).toUpperCase(), req.body || {}, req.user.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/templates/:type/reset', (req, res) => {
  try {
    const t = templates.resetTemplate(String(req.params.type).toUpperCase());
    audit(req.user.id, 'EMAIL_TEMPLATE_RESET', 'email_template', t.event_type, null, req);
    res.json(t);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/templates/:type/preview', (req, res) => {
  const type = String(req.params.type).toUpperCase();
  const sample = {
    incident_number: 'INC-001234', caller_name: 'Priya Sharma', recipient_name: 'Arjun Mehta', short_description: 'Laptop not charging',
    status: 'New', assignment_group: 'Desktop Support', priority: 'P3 – Medium', category: 'Hardware',
    comment: 'We have ordered a replacement charger.', portal_link: `${getConfig().portalUrl}/tickets/1`,
    original_subject: 'Laptop not charging', agent_name: 'Arjun Mehta', resolution_note: 'Charger replaced.',
    description: 'My laptop battery does not charge since this morning.',
    conversation_history: 'Original request — Priya Sharma <priya@cars24.com> · 21 Sep 2026, 09:58 IST · via Email\nMy laptop battery does not charge since this morning.\n\nArjun Mehta (IT Service Desk) · 21 Sep 2026, 10:30 IST · via portal\nWe are checking the charger.',
    conversation_history_html: '<div style="margin:0 0 10px;padding:6px 12px;border-left:3px solid #ddd"><div style="font-size:12px;color:#666"><b>Original request</b> — Priya Sharma &lt;priya@cars24.com&gt; · 21 Sep 2026, 09:58 IST · via Email</div><div>My laptop battery does not charge since this morning.</div></div><div style="margin:0 0 10px;padding:6px 12px;border-left:3px solid #ddd"><div style="font-size:12px;color:#666">Arjun Mehta (IT Service Desk) · 21 Sep 2026, 10:30 IST · via portal</div><div>We are checking the charger.</div></div>',
  };
  try {
    const t = req.body && req.body.subject_template
      ? { subject_template: req.body.subject_template, body_html_template: req.body.body_html_template, body_text_template: req.body.body_text_template }
      : templates.getTemplate(type);
    const fill = (tpl, html) => String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
      if (k.endsWith('_html')) return html ? (sample[k] ?? '') : '';
      return html ? templates.escapeHtml(sample[k] ?? '').replace(/\n/g, '<br>') : (sample[k] ?? '');
    });
    res.json({ subject: fill(t.subject_template, false), html: fill(t.body_html_template, true), text: fill(t.body_text_template, false) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---------- Message log ----------
router.get('/log', (req, res) => {
  const { direction, status, from, to, q, ticket_id, limit } = req.query;
  const where = [];
  const vals = [];
  if (direction) { where.push('l.direction = ?'); vals.push(String(direction).toUpperCase()); }
  if (status) { where.push('l.processing_status = ?'); vals.push(String(status).toUpperCase()); }
  if (from) { where.push('l.created_at >= ?'); vals.push(String(from)); }
  if (to) { where.push('l.created_at <= ?'); vals.push(`${String(to)} 23:59:59`); }
  if (ticket_id) { where.push('l.ticket_id = ?'); vals.push(Number(ticket_id)); }
  if (q) {
    where.push('(l.subject LIKE ? OR l.from_address LIKE ? OR l.to_addresses LIKE ? OR t.ticket_number LIKE ?)');
    const like = `%${String(q)}%`;
    vals.push(like, like, like, like);
  }
  const sql = `${LOG_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.id DESC LIMIT ?`;
  vals.push(Math.min(500, Number(limit) || 200));
  res.json(db.prepare(sql).all(...vals));
});

router.get('/log/:id', (req, res) => {
  const row = db.prepare('SELECT l.*, t.ticket_number FROM email_message_log l LEFT JOIN tickets t ON t.id = l.ticket_id WHERE l.id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Log entry not found' });
  let headers = {};
  try { headers = JSON.parse(row.raw_headers || '{}'); } catch { /* ignore */ }
  res.json({
    ...row,
    raw_headers: headers,
    body_html_safe: row.body_html_raw ? sanitizeHtml(row.body_html_raw) : null,
    body_html_raw: undefined,
    raw_source: undefined,
    has_raw_source: !!row.raw_source,
  });
});

router.get('/log/:id/raw', (req, res) => {
  const row = db.prepare('SELECT raw_source, message_id FROM email_message_log WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Log entry not found' });
  if (!row.raw_source) return res.status(404).json({ error: 'Raw source not stored for this message' });
  res.setHeader('Content-Type', 'message/rfc822');
  res.setHeader('Content-Disposition', `attachment; filename="email-${req.params.id}.eml"`);
  res.send(row.raw_source);
});

// ---------- Quarantine / dead-letter actions ----------
router.get('/quarantine', (_req, res) => {
  res.json({
    messages: db.prepare(`${LOG_SELECT} WHERE l.direction = 'INBOUND' AND l.processing_status IN ('QUARANTINED','FAILED','IGNORED')
      ORDER BY l.id DESC LIMIT 200`).all(),
    jobs: queue.listJobs(),
  });
});

// Re-run the pipeline for a stored message, bypassing policy checks (admin decision).
router.post('/log/:id/reprocess', async (req, res) => {
  const row = db.prepare('SELECT * FROM email_message_log WHERE id = ?').get(req.params.id);
  if (!row || row.direction !== 'INBOUND') return res.status(404).json({ error: 'Inbound email not found' });
  if (row.processing_status === 'PROCESSED' && row.ticket_id) return res.status(400).json({ error: 'Already processed' });
  let headers = {};
  try { headers = JSON.parse(row.raw_headers || '{}'); } catch { /* ignore */ }
  const input = row.raw_source ? { raw: row.raw_source } : {
    message_id: row.message_id, from_email: row.from_address, from_name: row.from_name, to: row.to_addresses,
    cc: row.cc_addresses, subject: row.subject, body: row.body_text, html: row.body_html_raw,
    in_reply_to: row.in_reply_to, references: row.references_header, headers, received_at: row.received_or_sent_at,
  };
  const { http, payload } = await processInboundEmail(input, { force: true, logId: row.id });
  audit(req.user.id, 'EMAIL_REPROCESSED', 'email_log', row.id, payload.ticket_number || payload.reason || null, req);
  await queue.runEmailJobs();
  res.status(http).json(payload);
});

router.post('/log/:id/create-ticket', (req, res) => {
  try {
    const ticket = createTicketFromLog(Number(req.params.id), req.body || {}, req.user);
    res.status(201).json(ticket);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/log/:id/discard', (req, res) => {
  const row = db.prepare('SELECT * FROM email_message_log WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Log entry not found' });
  if (row.processing_status === 'PROCESSED' && row.ticket_id) return res.status(400).json({ error: 'Processed messages cannot be discarded' });
  db.prepare("UPDATE email_message_log SET processing_status = 'DISCARDED', ignore_reason = COALESCE(ignore_reason, 'Discarded by admin') WHERE id = ?").run(row.id);
  audit(req.user.id, 'EMAIL_DISCARDED', 'email_log', row.id, row.subject, req);
  res.json({ ok: true });
});

router.get('/jobs', (req, res) => res.json(queue.listJobs({ status: req.query.status })));
router.post('/jobs/:id/retry', (req, res) => {
  try {
    const job = queue.retryJob(Number(req.params.id));
    audit(req.user.id, 'EMAIL_JOB_RETRIED', 'email_job', job.id, job.kind, req);
    res.json(job);
  } catch (err) { res.status(404).json({ error: err.message }); }
});
router.post('/jobs/:id/discard', (req, res) => {
  try {
    queue.discardJob(Number(req.params.id));
    audit(req.user.id, 'EMAIL_JOB_DISCARDED', 'email_job', req.params.id, null, req);
    res.json({ ok: true });
  } catch (err) { res.status(404).json({ error: err.message }); }
});
router.post('/jobs/run', async (_req, res) => {
  const n = await queue.runEmailJobs();
  res.json({ ok: true, attempted: n });
});

module.exports = router;
