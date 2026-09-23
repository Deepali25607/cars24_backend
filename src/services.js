const nodemailer = require('nodemailer');
const { db } = require('./db');

// ---------- Audit ----------
function audit(actorId, action, entity, entityId, detail, req) {
  db.prepare(
    'INSERT INTO audit_log (actor_id, action, entity, entity_id, detail, ip) VALUES (?,?,?,?,?,?)'
  ).run(actorId ?? null, action, entity, String(entityId ?? ''), detail ?? null, req?.ip ?? null);
}

function ticketHistory(ticketId, actorId, action, detail) {
  db.prepare(
    'INSERT INTO ticket_history (ticket_id, actor_id, action, detail) VALUES (?,?,?,?)'
  ).run(ticketId, actorId ?? null, action, detail ?? null);
}

// ---------- Email ----------
// Uses SMTP when configured via .env; otherwise logs to console (dev mode).
let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}

// Test mode captures every outbound message here instead of sending it, so
// tests can assert on subjects, recipients and threading headers.
const outbox = [];
function clearOutbox() { outbox.length = 0; }

// opts (all optional): { html, cc, headers, inReplyTo, references, messageId, from, replyTo }
// Returns { messageId, sent } — callers that ignore the result keep working.
async function sendEmail(to, subject, text, opts = {}) {
  if (!to) return { messageId: null, sent: false };
  const mail = {
    from: opts.from || process.env.SMTP_FROM || 'itsm@company.local',
    to, subject, text,
  };
  if (opts.html) mail.html = opts.html;
  if (opts.cc && (Array.isArray(opts.cc) ? opts.cc.length : opts.cc)) mail.cc = opts.cc;
  if (opts.replyTo) mail.replyTo = opts.replyTo;
  if (opts.messageId) mail.messageId = opts.messageId;
  if (opts.inReplyTo) mail.inReplyTo = opts.inReplyTo;
  if (opts.references) mail.references = opts.references;
  if (opts.headers) mail.headers = opts.headers;

  if (process.env.NODE_ENV === 'test') {
    outbox.push({ ...mail, sentAt: new Date().toISOString() });
    return { messageId: mail.messageId || `<test-${outbox.length}@itsm.test>`, sent: true, test: true };
  }
  if (transporter) {
    try {
      const info = await transporter.sendMail(mail);
      return { messageId: info.messageId || mail.messageId || null, sent: true };
    } catch (err) {
      console.error('[email] send failed:', err.message);
      if (opts.throwOnError) throw err;
      return { messageId: mail.messageId || null, sent: false, error: err.message };
    }
  }
  const cc = mail.cc ? ` | Cc: ${Array.isArray(mail.cc) ? mail.cc.join(', ') : mail.cc}` : '';
  console.log(`[email:dev] To: ${to}${cc} | ${subject}\n${text}\n`);
  return { messageId: mail.messageId || `<dev-${Date.now()}@itsm.local>`, sent: true, dev: true };
}

// ---------- Notifications (in-app + email) ----------
function notifyUser(userId, ticket, type, message) {
  if (!userId) return;
  db.prepare(
    'INSERT INTO notifications (user_id, ticket_id, type, message) VALUES (?,?,?,?)'
  ).run(userId, ticket?.id ?? null, type, message);
  // STANDARD S11: honour the user's email notification preference
  const pref = db.prepare('SELECT email_enabled FROM user_prefs WHERE user_id = ?').get(userId);
  if (pref && !pref.email_enabled) return;
  // Email-sourced tickets keep the requester informed on the ORIGINAL mail
  // thread (src/email/outbound.js); the generic notification mail would be a
  // duplicate, so only the in-app notification is kept for them.
  if (ticket && (ticket.source === 'EMAIL' || ticket.thread_subject) && ticket.requester_id === userId) return;
  const user = db.prepare('SELECT email, full_name FROM users WHERE id = ?').get(userId);
  // Threaded (email) tickets: agents / leads are NOT emailed by default so the
  // incident has exactly one mail chain (caller ↔ support mailbox); they keep
  // the in-app notification. Admins can enable copies on the same chain via
  // "thread_internal_notifications" — never a standalone mail.
  if (user && ticket && (ticket.source === 'EMAIL' || ticket.thread_subject)) {
    const { getConfig } = require('./email/config');
    if (getConfig().thread_internal_notifications) {
      require('./email/outbound').sendThreadNotification(ticket.id, user, message);
    }
    return;
  }
  if (user) {
    const subject = ticket
      ? `[${ticket.ticket_number}] ${message}`
      : `ITSM: ${message}`;
    sendEmail(user.email, subject, `Hello ${user.full_name},\n\n${message}\n\n— IT Service Desk`);
  }
}

// Notify everyone who should hear about a ticket event, except the actor.
function notifyTicketParties(ticket, actorId, type, message) {
  const targets = new Set();
  if (ticket.requester_id) targets.add(ticket.requester_id);
  if (ticket.assigned_agent_id) targets.add(ticket.assigned_agent_id);
  targets.delete(actorId);
  for (const uid of targets) notifyUser(uid, ticket, type, message);
}

module.exports = { audit, ticketHistory, sendEmail, notifyUser, notifyTicketParties, outbox, clearOutbox };
