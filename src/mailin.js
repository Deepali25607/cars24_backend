const { db, nextTicketNumber } = require('./db');
const { audit, ticketHistory, notifyUser } = require('./services');
const { applySla } = require('./sla');
const { applyAssignmentRules, runWorkflows } = require('./workflow');

// ================= Email-to-ticket processing (BRD 7.13) =================
// Single processing pipeline used by BOTH:
//  - POST /api/integrations/inbound-email (token-secured relay/webhook path)
//  - the live IMAP mailbox poller below (activates when MAIL_IN_* is set)

function processInboundEmail({ message_id, from_email, subject, body }) {
  if (!from_email || !/@/.test(String(from_email))) {
    return { http: 400, payload: { error: 'A valid from_email is required' } };
  }
  if (message_id) {
    const dupe = db.prepare('SELECT id, ticket_id FROM inbound_emails WHERE message_id = ?').get(message_id);
    if (dupe) return { http: 200, payload: { ok: true, duplicate: true, ticket_id: dupe.ticket_id } };
  }

  const sender = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(String(from_email).trim());
  const record = (ticketId, status, error) => {
    db.prepare(`INSERT INTO inbound_emails (message_id, from_email, subject, body, ticket_id, status, error)
      VALUES (?,?,?,?,?,?,?)`)
      .run(message_id || null, String(from_email).trim(), subject || null, body || null,
        ticketId, status, error || null);
  };

  if (!sender) {
    record(null, 'REJECTED', 'Sender is not a registered active user');
    return {
      http: 202,
      payload: { ok: false, reason: 'Sender is not a registered active user; message stored for review' },
    };
  }

  // Reply threading: subject references an existing ticket number
  const match = String(subject || '').match(/INC-\d{6}/);
  if (match) {
    const ticket = db.prepare('SELECT * FROM tickets WHERE ticket_number = ?').get(match[0]);
    if (ticket && (ticket.requester_id === sender.id || ['AGENT', 'TEAM_LEAD', 'ADMIN'].includes(sender.role))) {
      db.prepare('INSERT INTO ticket_comments (ticket_id, author_id, body, is_internal) VALUES (?,?,?,0)')
        .run(ticket.id, sender.id, String(body || '(empty email body)').trim());
      db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(ticket.id);
      ticketHistory(ticket.id, sender.id, 'COMMENT', 'Comment added via email');
      record(ticket.id, 'THREADED');
      audit(sender.id, 'EMAIL_THREADED', 'ticket', ticket.id, match[0]);
      return { http: 201, payload: { ok: true, threaded: true, ticket_number: ticket.ticket_number } };
    }
  }

  // New incident from email (default P3; agents triage after)
  const category = db.prepare('SELECT id FROM categories WHERE active = 1 ORDER BY id LIMIT 1').get();
  if (!category) {
    record(null, 'FAILED', 'No active categories configured');
    return { http: 500, payload: { error: 'No active categories configured' } };
  }
  const title = String(subject || 'Email issue report').slice(0, 200) || 'Email issue report';
  const number = nextTicketNumber();
  const info = db.prepare(`INSERT INTO tickets
    (ticket_number, requester_id, title, description, category_id, priority_id, location_id, status)
    VALUES (?,?,?,?,?,?,?, 'NEW')`)
    .run(number, sender.id, title, String(body || '(empty email body)').trim(),
      category.id, 3, sender.location_id || null);
  let ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(info.lastInsertRowid);

  ticketHistory(ticket.id, sender.id, 'CREATED', 'Ticket created from inbound email');
  const rule = applyAssignmentRules(ticket);
  if (rule) {
    db.prepare('UPDATE tickets SET support_group_id = ? WHERE id = ?').run(rule.target_group_id, ticket.id);
    ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
    ticketHistory(ticket.id, null, 'AUTO_ASSIGNED', `Rule "${rule.name}" routed the email ticket`);
  }
  applySla(ticket);
  runWorkflows('ticket.created', ticket);
  record(ticket.id, 'CREATED');
  audit(sender.id, 'EMAIL_TICKET_CREATED', 'ticket', ticket.id, number);
  notifyUser(sender.id, ticket, 'TICKET_CREATED',
    `Your email was converted to ticket ${number}. Reply with ${number} in the subject to add comments.`);
  return { http: 201, payload: { ok: true, ticket_number: number } };
}

// ================= Live IMAP mailbox poller =================
// Activates only when the customer supplies mailbox credentials:
//   MAIL_IN_HOST, MAIL_IN_USER, MAIL_IN_PASS
// Optional: MAIL_IN_PORT (993), MAIL_IN_SECURE (true), MAIL_IN_POLL_SECONDS (120)
// Unseen INBOX messages are processed through the pipeline above and marked seen.

function mailPollerEnabled() {
  return !!(process.env.MAIL_IN_HOST && process.env.MAIL_IN_USER && process.env.MAIL_IN_PASS);
}

async function pollOnce() {
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({
    host: process.env.MAIL_IN_HOST,
    port: Number(process.env.MAIL_IN_PORT || 993),
    secure: process.env.MAIL_IN_SECURE !== 'false',
    auth: { user: process.env.MAIL_IN_USER, pass: process.env.MAIL_IN_PASS },
    logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const unseen = await client.search({ seen: false });
      for (const seq of unseen || []) {
        const msg = await client.fetchOne(seq, { envelope: true, bodyText: true });
        if (!msg) continue;
        const result = processInboundEmail({
          message_id: msg.envelope?.messageId || null,
          from_email: msg.envelope?.from?.[0]?.address || '',
          subject: msg.envelope?.subject || '',
          body: (msg.bodyText || '').trim().slice(0, 20000),
        });
        console.log(`[mail-in] ${msg.envelope?.from?.[0]?.address}: ${result.payload.ticket_number || result.payload.reason || 'processed'}`);
        await client.messageFlagsAdd(seq, ['\\Seen']);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

function startMailPoller() {
  if (!mailPollerEnabled() || process.env.NODE_ENV === 'test') {
    if (!mailPollerEnabled() && process.env.NODE_ENV !== 'test') {
      console.log('[mail-in] mailbox poller idle — set MAIL_IN_HOST/USER/PASS to enable email-to-ticket polling');
    }
    return null;
  }
  const seconds = Number(process.env.MAIL_IN_POLL_SECONDS || 120);
  const run = () => pollOnce().catch((err) => console.error('[mail-in] poll failed:', err.message));
  run();
  const timer = setInterval(run, seconds * 1000);
  timer.unref();
  console.log(`[mail-in] polling ${process.env.MAIL_IN_USER}@${process.env.MAIL_IN_HOST} every ${seconds}s`);
  return timer;
}

module.exports = { processInboundEmail, startMailPoller, mailPollerEnabled };
