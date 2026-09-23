const crypto = require('crypto');
const { db } = require('../db');
const { getConfig } = require('./config');
const { renderTemplate } = require('./templates');
const { domainOf } = require('./parser');
const elog = require('./log');

// ================= Outbound sync (FR5 ack + FR7 updates) =================
// Every customer-visible event on an email-sourced ticket produces one
// message on the ORIGINAL thread: same cleaned subject + [INC-token],
// In-Reply-To = latest Message-ID in the thread, References = full chain.
// Sending is asynchronous through email_jobs (retries + dead-letter).

const MAX_REFERENCES_CHARS = 900; // stay well under common 998-char header limits

function ticketWithNames(ticketId) {
  return db.prepare(`
    SELECT t.*, req.full_name AS requester_name, req.email AS requester_email,
      c.name AS category_name, p.code AS priority_code, p.label AS priority_label,
      g.name AS group_name, ag.full_name AS agent_name
    FROM tickets t
    JOIN users req ON req.id = t.requester_id
    JOIN categories c ON c.id = t.category_id
    JOIN priorities p ON p.id = t.priority_id
    LEFT JOIN support_groups g ON g.id = t.support_group_id
    LEFT JOIN users ag ON ag.id = t.assigned_agent_id
    WHERE t.id = ?`).get(ticketId);
}

// A ticket has an email thread when it was created by email, or when a
// portal ticket has received at least one email (thread_subject is then set).
function hasEmailThread(ticket) {
  return !!ticket && (ticket.source === 'EMAIL' || !!ticket.thread_subject);
}

function shouldSync(ticket) {
  if (!hasEmailThread(ticket)) return false;
  const config = getConfig();
  if (!config.enabled) return false;
  return true;
}

function parseCcList(ticket) {
  try { return JSON.parse(ticket.cc_list || '[]').map((s) => String(s).toLowerCase()); } catch { return []; }
}

function recipientsFor(ticket, config) {
  const to = (ticket.caller_email || ticket.requester_email || '').toLowerCase();
  const cc = parseCcList(ticket).filter((a) => a && a !== to && !config.systemAddresses.has(a));
  // The assigned agent is copied on every thread mail so they follow the
  // whole conversation in their own mailbox (no separate notification mail).
  if (config.cc_assigned_agent && ticket.assigned_agent_id) {
    const agent = db.prepare('SELECT email FROM users WHERE id = ? AND active = 1').get(ticket.assigned_agent_id);
    const a = (agent?.email || '').toLowerCase();
    if (a && a !== to && !config.systemAddresses.has(a)) cc.push(a);
  }
  return { to, cc: [...new Set(cc)] };
}

function buildThreadHeaders(ticketId) {
  const rows = db.prepare(`
    SELECT message_id FROM email_message_log
    WHERE ticket_id = ? AND message_id IS NOT NULL AND processing_status <> 'FAILED'
    ORDER BY id ASC`).all(ticketId);
  // Synthetic ids (mail that arrived without a Message-ID) never appeared in
  // any real header, so clients cannot chain on them — leave them out and the
  // thread continues from the last real id (usually our own previous mail).
  const real = (id) => id && !/^<itsm-(noid|raw)-/.test(id);
  const ids = [...new Set(rows.map((r) => r.message_id).filter(real))];
  const t = db.prepare('SELECT original_message_id FROM tickets WHERE id = ?').get(ticketId);
  if (real(t?.original_message_id) && !ids.includes(t.original_message_id)) ids.unshift(t.original_message_id);
  const inReplyTo = ids.length ? ids[ids.length - 1] : null;
  // Truncate from the oldest entries but always keep the thread root.
  let refs = ids.slice();
  while (refs.length > 2 && refs.join(' ').length > MAX_REFERENCES_CHARS) refs.splice(1, 1);
  return { inReplyTo, references: refs };
}

function statusLabel(status) {
  return String(status || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

const IST = { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
function fmtIst(sql) {
  if (!sql) return '';
  const d = new Date(String(sql).includes('T') ? sql : `${String(sql).replace(' ', 'T')}Z`);
  return `${d.toLocaleString('en-IN', IST)} IST`;
}

// Chronological public conversation (original request + customer-visible
// comments). Internal work notes are never included. The comment currently
// being sent is excluded so it is not repeated under itself.
function conversationHistory(ticket, { excludeCommentId = null, limit = 20 } = {}) {
  const entries = [{
    who: ticket.caller_unverified ? ticket.caller_email : `${ticket.requester_name} <${ticket.caller_email || ticket.requester_email}>`,
    when: ticket.created_at, via: ticket.source === 'EMAIL' ? 'via Email' : 'via portal',
    label: 'Original request', body: ticket.description || '',
  }];
  const rows = db.prepare(`
    SELECT c.id, c.body, c.created_at, c.source, c.sender_email, u.full_name, u.email, u.role
    FROM ticket_comments c JOIN users u ON u.id = c.author_id
    WHERE c.ticket_id = ? AND c.is_internal = 0 ORDER BY c.created_at ASC, c.id ASC`).all(ticket.id);
  for (const c of rows) {
    if (excludeCommentId && c.id === excludeCommentId) continue;
    const isIT = ['AGENT', 'TEAM_LEAD', 'ADMIN'].includes(c.role);
    entries.push({
      who: c.source === 'EMAIL' ? (c.sender_email || c.full_name) : `${c.full_name}${isIT ? ' (IT Service Desk)' : ''}`,
      when: c.created_at, via: c.source === 'EMAIL' ? 'via Email' : 'via portal', label: null, body: c.body,
    });
  }
  const shown = entries.slice(-limit);
  const { escapeHtml } = require('./templates');
  const text = shown.map((e) => `${e.label ? `${e.label} — ` : ''}${e.who} · ${fmtIst(e.when)} · ${e.via}\n${String(e.body).slice(0, 2000)}`).join('\n\n');
  const html = shown.map((e) => `<div style="margin:0 0 10px;padding:6px 12px;border-left:3px solid #ddd">
<div style="font-size:12px;color:#666">${e.label ? `<b>${e.label}</b> — ` : ''}${escapeHtml(e.who)} · ${escapeHtml(fmtIst(e.when))} · ${e.via}</div>
<div style="white-space:pre-wrap">${escapeHtml(String(e.body).slice(0, 2000))}</div>
</div>`).join('');
  return { text, html };
}

function templateVars(ticket, extra = {}) {
  const config = getConfig();
  const history = conversationHistory(ticket, { excludeCommentId: extra.exclude_comment_id || null });
  return {
    incident_number: ticket.ticket_number,
    caller_name: ticket.caller_unverified ? (extra.caller_name || ticket.caller_email || 'there') : ticket.requester_name,
    short_description: ticket.title,
    description: ticket.description || '',
    conversation_history: history.text,
    conversation_history_html: history.html,
    status: statusLabel(ticket.status),
    assignment_group: ticket.group_name || 'Service Desk',
    priority: ticket.priority_code ? `${ticket.priority_code} – ${ticket.priority_label}` : '',
    category: ticket.category_name || '',
    comment: extra.comment || '',
    portal_link: `${config.portalUrl}/tickets/${ticket.id}`,
    original_subject: ticket.thread_subject || ticket.title,
    agent_name: extra.agent_name || ticket.agent_name || 'The IT Service Desk',
    resolution_note: extra.resolution_note || ticket.resolution_note || '',
    ...extra,
  };
}

function newMessageId(config) {
  const domain = domainOf(config.mailboxAddress || '') || 'itsm.local';
  return `<itsm-${crypto.randomUUID()}@${domain}>`;
}

// Queue one threaded email for a ticket event. Returns the log row (or null
// when nothing should be sent: non-email ticket, channel disabled, template off).
function sendTicketEmail(ticketId, eventType, extra = {}) {
  const ticket = ticketWithNames(ticketId);
  if (!shouldSync(ticket)) return null;
  const config = getConfig();
  const rendered = renderTemplate(eventType, templateVars(ticket, extra));
  if (!rendered.active) return null;
  const { to, cc } = recipientsFor(ticket, config);
  if (!to) return null;
  const { inReplyTo, references } = buildThreadHeaders(ticket.id);
  const messageId = newMessageId(config);
  const info = db.prepare(`INSERT INTO email_message_log
    (ticket_id, message_id, in_reply_to, references_header, direction, from_address, to_addresses,
     cc_addresses, subject, body_text, body_html_raw, processing_status, event_type, raw_headers)
    VALUES (?,?,?,?,'OUTBOUND',?,?,?,?,?,?,'PENDING',?,?)`)
    .run(ticket.id, messageId, inReplyTo, references.join(' '), config.mailboxAddress || process.env.SMTP_FROM || null,
      to, cc.join(', '), rendered.subject, rendered.text, rendered.html, eventType,
      JSON.stringify({ 'auto-submitted': eventType === 'ACK' ? 'auto-generated' : 'auto-replied' }));
  const logId = info.lastInsertRowid;
  const { enqueue, kick } = require('./queue');
  enqueue('OUTBOUND', { logId }, { message_id: messageId });
  elog.info('outbound.queued', { message_id: messageId, ticket: ticket.ticket_number, event_type: eventType, to });
  kick();
  return db.prepare('SELECT * FROM email_message_log WHERE id = ?').get(logId);
}

// Executed by the job worker. Throws on transport failure so the job retries.
async function deliverOutbound({ logId }) {
  const row = db.prepare('SELECT * FROM email_message_log WHERE id = ?').get(logId);
  if (!row) throw new Error(`Outbound log row #${logId} not found`);
  if (row.processing_status === 'PROCESSED') return { skipped: 'already sent' };
  const config = getConfig();
  const { sendEmail } = require('../services');
  const t = db.prepare('SELECT ticket_number FROM tickets WHERE id = ?').get(row.ticket_id);
  const mailbox = config.mailboxAddress || row.from_address || process.env.SMTP_FROM || '';
  // Header order matters for some webmail "Reply" dialogs (smtp4dev prefills
  // To from the first non-Reply-To header): keep an address header first.
  const headers = {
    Sender: mailbox,
    'Reply-To': mailbox,
    'Auto-Submitted': row.event_type === 'ACK' ? 'auto-generated' : 'auto-replied',
    'X-ITSM-Incident': t?.ticket_number || '',
  };
  const result = await sendEmail(row.to_addresses, row.subject, row.body_text, {
    html: row.body_html_raw,
    cc: row.cc_addresses ? row.cc_addresses.split(',').map((s) => s.trim()).filter(Boolean) : [],
    from: row.from_address || undefined,
    replyTo: mailbox || undefined,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to || undefined,
    references: row.references_header || undefined,
    headers,
    throwOnError: true,
  });
  if (!result.sent) throw new Error(result.error || 'Mail transport unavailable');
  db.prepare(`UPDATE email_message_log SET processing_status = 'PROCESSED', received_or_sent_at = datetime('now'),
    ignore_reason = NULL WHERE id = ?`).run(logId);
  elog.inc('outbound_sent');
  elog.info('outbound.sent', { message_id: row.message_id, ticket: t?.ticket_number, event_type: row.event_type });
  return { sent: true, message_id: row.message_id };
}

function markOutboundFailed(logId, reason) {
  db.prepare("UPDATE email_message_log SET processing_status = 'FAILED', ignore_reason = ? WHERE id = ?")
    .run(String(reason).slice(0, 500), logId);
  elog.inc('outbound_failed');
}

// ---------- Event hooks called from the ticket routes ----------
function onPublicComment(ticket, comment, actor) {
  if (!shouldSync(ticket)) return null;
  if (comment.is_internal) return null; // never leak work notes
  if (comment.source === 'EMAIL') return null; // the customer's own email — do not echo it back
  return sendTicketEmail(ticket.id, 'COMMENT', { comment: comment.body, agent_name: actor?.full_name, exclude_comment_id: comment.id });
}

const STATUS_EVENT = { IN_PROGRESS: 'IN_PROGRESS', PENDING: 'ON_HOLD', RESOLVED: 'RESOLVED', CLOSED: 'CLOSED', REOPENED: 'REOPENED' };
function onStatusChange(ticket, target, note, actor) {
  if (!shouldSync(ticket)) return null;
  const event = STATUS_EVENT[target];
  if (!event) return null;
  if (event === 'IN_PROGRESS' && !getConfig().notify_on_progress) return null;
  return sendTicketEmail(ticket.id, event, {
    comment: note || '', resolution_note: note || ticket.resolution_note || '', agent_name: actor?.full_name,
  });
}

// Assigned / reassigned / moved to another group — `detail` is the human text
// already written to the ticket history ("Assigned to X (Group)").
function onAssigned(ticket, actor, detail) {
  if (!shouldSync(ticket) || !getConfig().notify_on_assignment) return null;
  return sendTicketEmail(ticket.id, 'ASSIGNED', { comment: detail, agent_name: actor?.full_name });
}

// Category / subcategory / priority / location edited — `changes` is the list
// written to the history ("category → Hardware, priority → P2").
function onDetailsUpdated(ticket, actor, changes) {
  if (!shouldSync(ticket) || !getConfig().notify_on_update || !changes) return null;
  return sendTicketEmail(ticket.id, 'UPDATED', { comment: changes, agent_name: actor?.full_name });
}

// Notification to an agent / lead about a threaded ticket: same subject and
// headers as the customer chain, addressed to that person only.
function sendThreadNotification(ticketId, recipient, message) {
  const ticket = ticketWithNames(ticketId);
  if (!shouldSync(ticket) || !getConfig().thread_internal_notifications) return null;
  if (!recipient?.email) return null;
  const config = getConfig();
  const rendered = renderTemplate('NOTIFY', templateVars(ticket, { comment: message, recipient_name: recipient.full_name || recipient.email }));
  if (!rendered.active) return null;
  const { inReplyTo, references } = buildThreadHeaders(ticket.id);
  const messageId = newMessageId(config);
  const info = db.prepare(`INSERT INTO email_message_log
    (ticket_id, message_id, in_reply_to, references_header, direction, from_address, to_addresses,
     cc_addresses, subject, body_text, body_html_raw, processing_status, event_type, raw_headers)
    VALUES (?,?,?,?,'OUTBOUND',?,?,?,?,?,?,'PENDING','NOTIFY',?)`)
    .run(ticket.id, messageId, inReplyTo, references.join(' '), config.mailboxAddress || process.env.SMTP_FROM || null,
      recipient.email.toLowerCase(), '', rendered.subject, rendered.text, rendered.html,
      JSON.stringify({ 'auto-submitted': 'auto-replied' }));
  const { enqueue, kick } = require('./queue');
  enqueue('OUTBOUND', { logId: info.lastInsertRowid }, { message_id: messageId });
  kick();
  return { messageId };
}

module.exports = {
  sendTicketEmail, deliverOutbound, markOutboundFailed, buildThreadHeaders, recipientsFor,
  templateVars, shouldSync, hasEmailThread, onPublicComment, onStatusChange, onAssigned, onDetailsUpdated,
  sendThreadNotification,
};
