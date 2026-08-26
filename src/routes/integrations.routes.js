const express = require('express');
const crypto = require('crypto');
const { db, nextTicketNumber } = require('../db');
const { authenticate, requireRole } = require('../auth');
const { audit, ticketHistory, notifyUser } = require('../services');
const { applySla } = require('../sla');
const { applyAssignmentRules, runWorkflows } = require('../workflow');
const { processInboundEmail, mailPollerEnabled } = require('../mailin');

const router = express.Router();

// ================= S15: API tokens (admin-managed, for external systems) =================
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Auth middleware for machine-to-machine calls (X-Api-Token header).
function apiTokenAuth(req, res, next) {
  const raw = req.headers['x-api-token'];
  if (!raw) return res.status(401).json({ error: 'Missing X-Api-Token header' });
  const row = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ? AND active = 1').get(hashToken(raw));
  if (!row) return res.status(401).json({ error: 'Invalid or revoked API token' });
  db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  req.apiToken = row;
  next();
}

router.get('/tokens', authenticate, requireRole('ADMIN'), (_req, res) => {
  res.json(db.prepare(`
    SELECT t.id, t.name, t.active, t.last_used_at, t.created_at, u.full_name AS created_by_name
    FROM api_tokens t LEFT JOIN users u ON u.id = t.created_by
    ORDER BY t.created_at DESC`).all());
});

router.post('/tokens', authenticate, requireRole('ADMIN'), (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Token name is required' });
  const token = `itsm_${crypto.randomBytes(24).toString('hex')}`;
  const info = db.prepare('INSERT INTO api_tokens (name, token_hash, created_by) VALUES (?,?,?)')
    .run(String(name).trim(), hashToken(token), req.user.id);
  audit(req.user.id, 'API_TOKEN_CREATED', 'api_token', info.lastInsertRowid, name, req);
  // The clear-text token is shown exactly once.
  res.status(201).json({ id: info.lastInsertRowid, name: String(name).trim(), token });
});

router.post('/tokens/:id/revoke', authenticate, requireRole('ADMIN'), (req, res) => {
  const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Token not found' });
  db.prepare('UPDATE api_tokens SET active = 0 WHERE id = ?').run(row.id);
  audit(req.user.id, 'API_TOKEN_REVOKED', 'api_token', row.id, row.name, req);
  res.json({ ok: true });
});

// ================= S10: email-to-ticket (BRD 7.13) =================
// Transport-agnostic inbound endpoint: an IMAP poller, a mail-provider webhook
// or a relay script POSTs each received message here with an API token.
// Subject containing an existing INC-number threads the mail as a comment;
// otherwise a new incident is created for the sender (matched by email).
// Live mailbox polling is enabled once the customer provides mailbox
// credentials (MAIL_IN_* env) — see docs; the processing path is identical.
router.post('/inbound-email', apiTokenAuth, (req, res) => {
  const { http, payload } = processInboundEmail(req.body || {});
  res.status(http).json(payload);
});

// Mailbox poller status (admin) — live polling starts when MAIL_IN_* is set.
router.get('/mailbox', authenticate, requireRole('ADMIN'), (_req, res) => {
  res.json({
    polling_enabled: mailPollerEnabled(),
    host: process.env.MAIL_IN_HOST || null,
    note: mailPollerEnabled() ? undefined
      : 'Set MAIL_IN_HOST, MAIL_IN_USER and MAIL_IN_PASS (customer mailbox) to enable live email-to-ticket polling. The relay endpoint above works regardless.',
  });
});

// ================= ADVANCED A9: event/monitoring integration (BRD 8.14) =================
// Monitoring systems POST alerts here with an API token. Events sharing a
// dedupe_key while their ticket is still open become work notes instead of
// duplicate incidents. Severity maps to priority.
router.post('/event', apiTokenAuth, (req, res) => {
  const { dedupe_key, source, severity, subject, body } = req.body || {};
  if (!subject || !String(subject).trim()) {
    return res.status(400).json({ error: 'Event subject is required' });
  }

  // Dedupe: same key, ticket still open → append instead of creating.
  if (dedupe_key) {
    const prior = db.prepare(`
      SELECT e.ticket_id FROM inbound_events e
      JOIN tickets t ON t.id = e.ticket_id
      WHERE e.dedupe_key = ? AND t.status NOT IN ('RESOLVED','CLOSED')
      ORDER BY e.id DESC LIMIT 1`).get(dedupe_key);
    if (prior) {
      const sys = db.prepare("SELECT id FROM users WHERE role = 'ADMIN' AND active = 1 ORDER BY id LIMIT 1").get();
      if (sys) {
        db.prepare('INSERT INTO ticket_comments (ticket_id, author_id, body, is_internal) VALUES (?,?,?,1)')
          .run(prior.ticket_id, sys.id,
            `[monitoring] Repeat event from ${source || 'monitoring'}: ${subject}\n${body || ''}`.trim());
      }
      db.prepare(`INSERT INTO inbound_events (dedupe_key, source, severity, subject, body, ticket_id, status)
        VALUES (?,?,?,?,?,?, 'DEDUPED')`)
        .run(dedupe_key, source || null, severity || null, subject, body || null, prior.ticket_id);
      db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(prior.ticket_id);
      const tn = db.prepare('SELECT ticket_number FROM tickets WHERE id = ?').get(prior.ticket_id);
      return res.json({ ok: true, deduped: true, ticket_number: tn.ticket_number });
    }
  }

  const sevMap = { critical: 1, high: 2, warning: 3, info: 4 };
  const priorityId = sevMap[String(severity || '').toLowerCase()] || 3;
  const requester = db.prepare("SELECT * FROM users WHERE role = 'ADMIN' AND active = 1 ORDER BY id LIMIT 1").get();
  if (!requester) return res.status(500).json({ error: 'No active administrator to own monitoring tickets' });
  const category = db.prepare('SELECT id FROM categories WHERE active = 1 ORDER BY id LIMIT 1').get();

  const number = nextTicketNumber();
  const info = db.prepare(`INSERT INTO tickets
    (ticket_number, requester_id, title, description, category_id, priority_id, status)
    VALUES (?,?,?,?,?,?, 'NEW')`)
    .run(number, requester.id, String(subject).slice(0, 200),
      `[monitoring event${source ? ` from ${source}` : ''}]\n${body || subject}`,
      category.id, priorityId);
  let ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(info.lastInsertRowid);
  ticketHistory(ticket.id, null, 'CREATED', `Created from monitoring event (${severity || 'unclassified'})`);
  const rule = applyAssignmentRules(ticket);
  if (rule) {
    db.prepare('UPDATE tickets SET support_group_id = ? WHERE id = ?').run(rule.target_group_id, ticket.id);
    ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
    ticketHistory(ticket.id, null, 'AUTO_ASSIGNED', `Rule "${rule.name}" routed the event ticket`);
  }
  applySla(ticket);
  runWorkflows('ticket.created', ticket);
  db.prepare(`INSERT INTO inbound_events (dedupe_key, source, severity, subject, body, ticket_id, status)
    VALUES (?,?,?,?,?,?, 'CREATED')`)
    .run(dedupe_key || null, source || null, severity || null, subject, body || null, ticket.id);
  audit(null, 'EVENT_TICKET_CREATED', 'ticket', ticket.id, `${source || 'monitoring'}: ${subject}`);
  res.status(201).json({ ok: true, ticket_number: number });
});

// Event log (admin)
router.get('/events', authenticate, requireRole('ADMIN'), (_req, res) => {
  res.json(db.prepare('SELECT * FROM inbound_events ORDER BY created_at DESC LIMIT 200').all());
});

// Inbound email log (admin)
router.get('/inbound-email', authenticate, requireRole('ADMIN'), (_req, res) => {
  res.json(db.prepare('SELECT * FROM inbound_emails ORDER BY created_at DESC LIMIT 200').all());
});

// ================= S14: SSO status (config-driven, off until IdP details provided) =================
router.get('/sso', (_req, res) => {
  res.json({
    enabled: !!(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID),
    provider: process.env.OIDC_PROVIDER_NAME || null,
    note: process.env.OIDC_ISSUER
      ? undefined
      : 'SSO is configured via OIDC_* environment variables once the customer confirms the identity provider (BRD 7.14).',
  });
});

module.exports = router;
