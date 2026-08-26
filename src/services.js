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

async function sendEmail(to, subject, text) {
  if (!to || process.env.NODE_ENV === 'test') return;
  if (transporter) {
    try {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || 'itsm@company.local',
        to, subject, text,
      });
    } catch (err) {
      console.error('[email] send failed:', err.message);
    }
  } else {
    console.log(`[email:dev] To: ${to} | ${subject}\n${text}\n`);
  }
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
  const user = db.prepare('SELECT email, full_name FROM users WHERE id = ?').get(userId);
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

module.exports = { audit, ticketHistory, sendEmail, notifyUser, notifyTicketParties };
