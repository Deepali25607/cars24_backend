const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, nextTicketNumber } = require('../db');
const { audit, ticketHistory, notifyUser } = require('../services');
const { applySla, reopenSla } = require('../sla');
const { applyAssignmentRules, runWorkflows } = require('../workflow');
const parser = require('./parser');
const { matchThread } = require('./threadMatcher');
const participants = require('./participants');
const { getClassifier } = require('./classifier');
const { getConfig } = require('./config');
const antivirus = require('./antivirus');
const elog = require('./log');

// ================= Inbound processing pipeline (FR1–FR6, FR8, FR9) =================
// One entry point for every transport:
//   - POST /api/integrations/inbound-email (relay/webhook, token-secured)
//   - the IMAP listener (via email_jobs)
//   - admin "reprocess" of quarantined mail (opts.force bypasses policy checks)
// Idempotent on Message-ID. Returns { http, payload } like the S10 version.

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const BLOCKED_EXT = new Set(['.exe', '.bat', '.cmd', '.js', '.vbs', '.ps1', '.scr', '.msi', '.com', '.pif', '.jar', '.hta', '.wsf', '.dll']);
const BLOCKED_MIME = new Set(['application/x-msdownload', 'application/x-msdos-program', 'application/x-executable', 'application/x-sh', 'application/x-bat', 'application/java-archive']);
const GUEST_EMAIL = 'email-guest@system.local';

function getGuestUser() {
  let u = db.prepare('SELECT * FROM users WHERE email = ?').get(GUEST_EMAIL);
  if (!u) {
    db.prepare(`INSERT INTO users (email, password_hash, full_name, role, active)
      VALUES (?, '!', 'Email guest (unverified sender)', 'EMPLOYEE', 0)`).run(GUEST_EMAIL);
    u = db.prepare('SELECT * FROM users WHERE email = ?').get(GUEST_EMAIL);
    db.prepare('INSERT OR IGNORE INTO user_prefs (user_id, email_enabled) VALUES (?, 0)').run(u.id);
  }
  return u;
}

function syntheticMessageId(msg) {
  const h = crypto.createHash('sha256')
    .update(`${msg.from?.address || ''}|${msg.subject || ''}|${msg.date || ''}|${(msg.text || msg.html || '').slice(0, 2000)}`)
    .digest('hex').slice(0, 32);
  return `<itsm-noid-${h}@local>`;
}

function fmtAddrs(list) {
  return (list || []).map((a) => a.address).join(', ');
}

function attachmentsSummary(atts) {
  return JSON.stringify((atts || []).map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.size, inline: !!a.inline })));
}

// Insert (or reuse) the log row for this message; returns its id.
function openLogRow(msg, existingId) {
  const fields = {
    message_id: msg.message_id,
    in_reply_to: msg.in_reply_to,
    references_header: (msg.references || []).join(' ') || null,
    from_address: msg.from?.address || null,
    from_name: msg.from?.name || null,
    to_addresses: fmtAddrs(msg.to) || null,
    cc_addresses: fmtAddrs(msg.cc) || null,
    subject: msg.subject || null,
    body_text: (msg.text || parser.htmlToText(msg.html) || '').slice(0, 100000),
    body_html_raw: msg.html ? String(msg.html).slice(0, 500000) : null,
    received_or_sent_at: msg.date,
    raw_headers: JSON.stringify(msg.headers || {}).slice(0, 100000),
    raw_source: msg.raw ? String(msg.raw).slice(0, 2000000) : null,
    attachments_json: attachmentsSummary(msg.attachments),
    auth_results: JSON.stringify(parser.parseAuthResults(msg.headers)),
  };
  if (existingId) {
    const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE email_message_log SET ${sets}, processing_status = 'PENDING', ignore_reason = NULL WHERE id = ?`)
      .run(...Object.values(fields), existingId);
    return existingId;
  }
  const cols = Object.keys(fields);
  const info = db.prepare(`INSERT INTO email_message_log (${cols.join(', ')}, direction, processing_status)
    VALUES (${cols.map(() => '?').join(', ')}, 'INBOUND', 'PENDING')`).run(...Object.values(fields));
  return info.lastInsertRowid;
}

function closeLogRow(id, { status, reason, ticketId, event }) {
  db.prepare(`UPDATE email_message_log SET processing_status = ?, ignore_reason = ?, ticket_id = COALESCE(?, ticket_id),
    event_type = COALESCE(?, event_type) WHERE id = ?`)
    .run(status, reason ? String(reason).slice(0, 500) : null, ticketId ?? null, event ?? null, id);
}

function notifyAdmins(message) {
  const admins = db.prepare("SELECT id FROM users WHERE role = 'ADMIN' AND active = 1").all();
  for (const a of admins) notifyUser(a.id, null, 'EMAIL_CHANNEL_ALERT', message);
}

// Attachment policy: returns { keep: [], violations: [] }
function applyAttachmentPolicy(atts, config) {
  const keep = [];
  const violations = [];
  let total = 0;
  const perFile = config.max_attachment_mb * 1024 * 1024;
  const totalMax = config.max_total_attachment_mb * 1024 * 1024;
  for (const a of atts || []) {
    const ext = path.extname(a.filename || '').toLowerCase();
    if (a.inline && /^image\//i.test(a.contentType) && a.size < config.inline_image_min_kb * 1024) continue; // signature logos
    if (BLOCKED_EXT.has(ext) || BLOCKED_MIME.has(String(a.contentType).toLowerCase())) {
      violations.push({ filename: a.filename, reason: `blocked file type (${ext || a.contentType})` });
      continue;
    }
    if (a.size > perFile) {
      violations.push({ filename: a.filename, reason: `exceeds ${config.max_attachment_mb} MB` });
      continue;
    }
    if (total + a.size > totalMax) {
      violations.push({ filename: a.filename, reason: `total attachments exceed ${config.max_total_attachment_mb} MB` });
      continue;
    }
    total += a.size;
    keep.push(a);
  }
  return { keep, violations };
}

async function saveAttachments(ticketId, uploaderId, atts) {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const saved = [];
  const rejected = [];
  for (const a of atts) {
    if (!a.content) continue;
    const stored = `${crypto.randomUUID()}${path.extname(a.filename || '').slice(0, 10)}`;
    const full = path.join(UPLOAD_DIR, stored);
    fs.writeFileSync(full, a.content);
    const scan = await antivirus.scan(full, { filename: a.filename, contentType: a.contentType });
    if (!scan.clean) {
      fs.unlinkSync(full);
      rejected.push({ filename: a.filename, reason: `antivirus: ${scan.detail || 'rejected'}` });
      continue;
    }
    db.prepare(`INSERT INTO ticket_attachments (ticket_id, uploader_id, original_name, stored_name, mime_type, size_bytes)
      VALUES (?,?,?,?,?,?)`).run(ticketId, uploaderId, String(a.filename).slice(0, 255), stored, a.contentType, a.size || a.content.length);
    saved.push(a.filename);
  }
  return { saved, rejected };
}

function senderIsParticipant(ticket, address, user, config) {
  if (!address) return false;
  if (ticket.caller_email && ticket.caller_email.toLowerCase() === address) return true;
  if (user && ticket.requester_id === user.id) return true;
  if (user && ['AGENT', 'TEAM_LEAD', 'ADMIN'].includes(user.role)) return true;
  // Written from the shared support mailbox: that is the service desk itself,
  // not an outside party writing in.
  if (config && config.systemAddresses.has(address)) return true;
  return participants.listParticipants(ticket).includes(address);
}

function withinReopenWindow(ticket, days) {
  if (ticket.status !== 'RESOLVED' || !ticket.resolved_at) return false;
  const resolved = new Date(ticket.resolved_at.replace(' ', 'T') + 'Z').getTime();
  return Date.now() - resolved <= days * 86400000;
}

// ---------------------------------------------------------------------------
async function processInboundEmail(input, opts = {}) {
  const force = !!opts.force;
  let msg;
  try {
    msg = await parser.normalizeInput(input);
  } catch (err) {
    elog.error('parse.failed', { error: err.message });
    return { http: 400, payload: { error: `Could not parse email: ${err.message}` } };
  }
  if (!msg || !msg.from || !/@/.test(msg.from.address)) {
    return { http: 400, payload: { error: 'A valid from_email is required' } };
  }
  if (!msg.message_id) msg.message_id = syntheticMessageId(msg);
  const mid = msg.message_id;
  const from = msg.from.address;
  elog.inc('received');

  // Idempotency: a message already processed to a final state is never redone.
  const existing = db.prepare("SELECT id, ticket_id, processing_status FROM email_message_log WHERE message_id = ? AND direction = 'INBOUND'").get(mid);
  if (existing && !force && !['PENDING', 'FAILED'].includes(existing.processing_status)) {
    elog.inc('duplicates');
    elog.info('inbound.duplicate', { message_id: mid, status: existing.processing_status });
    return { http: 200, payload: { ok: true, duplicate: true, ticket_id: existing.ticket_id, log_id: existing.id } };
  }
  // One of our own outbound messages landing back in the mailbox: the loop stops
  // here, before the log row is opened (message_id is unique, so re-logging it
  // would fail). This is what makes it safe to accept mail whose From is the
  // support mailbox itself — see the FR8 block below.
  if (!force) {
    const ours = db.prepare("SELECT id FROM email_message_log WHERE message_id = ? AND direction = 'OUTBOUND'").get(mid);
    if (ours) {
      elog.inc('ignored');
      elog.info('inbound.ignored', { message_id: mid, from, reason: 'own outbound message returned' });
      return { http: 202, payload: { ok: false, ignored: true, log_id: ours.id, reason: 'Our own outbound message came back — loop prevented' } };
    }
  }
  const logId = openLogRow(msg, opts.logId || existing?.id || null);
  const config = getConfig();

  const finish = (status, reason, extra = {}, http = 202, payloadExtra = {}) => {
    closeLogRow(logId, { status, reason, ticketId: extra.ticketId, event: extra.event });
    elog.inc(status === 'IGNORED' ? 'ignored' : status === 'QUARANTINED' ? 'quarantined' : status === 'FAILED' ? 'failed' : 'processed');
    elog.info(`inbound.${status.toLowerCase()}`, { message_id: mid, from, reason, ticket: extra.ticketNumber });
    return { http, payload: { ok: false, reason, log_id: logId, ...payloadExtra } };
  };

  try {
    if (!config.enabled && !force) return finish('IGNORED', 'Email channel is disabled');

    // ---- FR8: loop & noise prevention ----
    if (!force) {
      // Bounces first: NDRs usually also carry Auto-Submitted, but we want them
      // linked to the incident whose mail bounced.
      const bounce = parser.isBounce(msg);
      if (bounce.bounce) {
        const related = matchThread(msg);
        if (related.ticket) {
          const sys = db.prepare("SELECT id FROM users WHERE role = 'ADMIN' AND active = 1 ORDER BY id LIMIT 1").get();
          if (sys) {
            db.prepare("INSERT INTO ticket_comments (ticket_id, author_id, body, is_internal, source, email_log_id) VALUES (?,?,?,1,'EMAIL',?)")
              .run(related.ticket.id, sys.id, `[email] Delivery failure received for this ticket's thread: ${msg.subject || bounce.reason}`, logId);
          }
          ticketHistory(related.ticket.id, null, 'EMAIL_BOUNCE', bounce.reason);
        }
        return finish('IGNORED', bounce.reason, { ticketId: related.ticket?.id, event: 'BOUNCE' }, 202, { ignored: true });
      }
      const auto = parser.isAutoReply(msg);
      if (auto.ignore) return finish('IGNORED', auto.reason, {}, 202, { ignored: true });
    }

    // ---- Sender resolution (FR4) + domain policy (FR9) ----
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(from);
    if (!user && !force) {
      const domain = parser.domainOf(from);
      if (!config.allowedDomains.includes(domain)) {
        const status = config.unknown_sender_action === 'REJECT' ? 'IGNORED' : 'QUARANTINED';
        return finish(status, `Sender is not a registered active user and ${domain || 'its domain'} is not an allowed domain`,
          {}, 202, { quarantined: status === 'QUARANTINED' });
      }
    }

    // ---- SPF/DKIM/DMARC (FR9) ----
    if (!force && config.auth_check_mode === 'QUARANTINE_FAIL') {
      const auth = parser.parseAuthResults(msg.headers);
      if (auth.failed.length) {
        return finish('QUARANTINED', `Email authentication failed: ${auth.failed.map((k) => `${k}=fail`).join(', ')}`, {}, 202, { quarantined: true });
      }
    }

    // ---- Attachments policy (FR9) ----
    const policy = applyAttachmentPolicy(msg.attachments, config);
    if (policy.violations.length && config.attachment_violation_action === 'QUARANTINE' && !force) {
      return finish('QUARANTINED', `Attachment policy: ${policy.violations.map((v) => `${v.filename} (${v.reason})`).join('; ')}`,
        {}, 202, { quarantined: true });
    }
    const strippedNote = policy.violations.length
      ? `\n\n[${policy.violations.length} attachment(s) removed by policy: ${policy.violations.map((v) => `${v.filename} – ${v.reason}`).join('; ')}]`
      : '';

    // ---- Thread detection (FR2) ----
    const match = matchThread(msg);
    for (const w of match.warnings) elog.warn('thread.warning', { message_id: mid, warning: w });

    const rawText = msg.text || parser.htmlToText(msg.html) || '';
    const cleaned = parser.stripQuotedReply(rawText).slice(0, 20000) || '(empty email body)';
    const author = user || getGuestUser();
    const ccAddresses = [...(msg.cc || []), ...(msg.to || [])]
      .map((a) => a.address).filter((a) => a !== from && !config.systemAddresses.has(a));

    // =============== UPDATE an existing incident (FR6) ===============
    if (match.kind === 'UPDATE') {
      let ticket = match.ticket;
      const closedOrStale = ticket.status === 'CLOSED'
        || (ticket.status === 'RESOLVED' && !withinReopenWindow(ticket, config.reopen_window_days));
      if (!closedOrStale) {
        let reopened = false;
        if (ticket.status === 'RESOLVED') {
          db.prepare("UPDATE tickets SET status = 'REOPENED', reopen_count = reopen_count + 1, updated_at = datetime('now') WHERE id = ?").run(ticket.id);
          ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
          reopenSla(ticket);
          ticketHistory(ticket.id, user?.id ?? null, 'STATUS_REOPENED', 'Reopened by customer reply via email');
          runWorkflows('ticket.status.REOPENED', ticket);
          reopened = true;
        }
        const external = !senderIsParticipant(ticket, from, user, config) ? 1 : 0;
        // First email on a portal-created ticket starts its email thread: from
        // now on agent updates are mailed back on it (see outbound.shouldSync).
        if (!ticket.thread_subject) {
          const requesterEmail = db.prepare('SELECT email FROM users WHERE id = ?').get(ticket.requester_id)?.email || null;
          db.prepare(`UPDATE tickets SET thread_subject = ?, caller_email = COALESCE(caller_email, ?),
            original_message_id = COALESCE(original_message_id, ?) WHERE id = ?`)
            .run(parser.cleanSubject(msg.subject) || ticket.title, requesterEmail, mid, ticket.id);
          ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
        }
        const info = db.prepare(`INSERT INTO ticket_comments
          (ticket_id, author_id, body, is_internal, source, sender_email, email_log_id, external_participant)
          VALUES (?,?,?,0,'EMAIL',?,?,?)`)
          .run(ticket.id, author.id, cleaned + strippedNote, from, logId, external);
        db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(ticket.id);
        ticketHistory(ticket.id, user?.id ?? null, 'COMMENT', `Comment added via email from ${from}${external ? ' (external participant)' : ''}`);
        // Link this message to the incident before anything else mails out on the
        // thread, so the catch-up below chains to the mail that added the newcomers.
        db.prepare('UPDATE email_message_log SET ticket_id = ? WHERE id = ?').run(ticket.id, logId);
        // Everyone the sender put in To/Cc joins the watch list: the new ones get
        // the conversation so far and stay on the chain from here on.
        if (!external) participants.syncFromInbound(ticket, msg, config, { actorId: user?.id ?? null, sender: from });
        const files = await saveAttachments(ticket.id, author.id, policy.keep);
        if (files.saved.length) ticketHistory(ticket.id, user?.id ?? null, 'ATTACHMENT', `Email attachment(s): ${files.saved.join(', ')}`);
        audit(user?.id ?? null, 'EMAIL_THREADED', 'ticket', ticket.id, `${ticket.ticket_number} via ${match.via}`);
        if (ticket.assigned_agent_id) {
          notifyUser(ticket.assigned_agent_id, ticket, reopened ? 'TICKET_REOPENED' : 'EMAIL_REPLY',
            `${reopened ? 'Customer reply reopened' : 'Customer replied by email on'} ticket ${ticket.ticket_number}.`);
        }
        const { onStatusChange } = require('./outbound');
        if (reopened) onStatusChange(ticket, 'REOPENED', null, null);
        closeLogRow(logId, { status: 'PROCESSED', ticketId: ticket.id, event: reopened ? 'REOPENED' : 'THREADED' });
        elog.inc('processed'); elog.inc(reopened ? 'reopened' : 'threaded');
        elog.info('inbound.threaded', { message_id: mid, ticket: ticket.ticket_number, via: match.via, reopened, external: !!external, comment_id: info.lastInsertRowid });
        return { http: 201, payload: { ok: true, threaded: true, reopened, external_participant: !!external, ticket_number: ticket.ticket_number, ticket_id: ticket.id, log_id: logId } };
      }
      // Closed, or resolved beyond the window → new linked incident (falls through)
      match.relatedTicket = ticket;
    }

    // =============== NEW incident (FR3/FR4/FR5) ===============
    // Someone writing from the shared mailbox may join an existing thread, but
    // the support mailbox must never raise incidents out of its own outgoing mail.
    if (!force && config.systemAddresses.has(from)) {
      return finish('IGNORED', 'Sent from the support mailbox and does not reference an existing incident', {}, 202, { ignored: true });
    }
    if (!force) {
      const recent = db.prepare(`SELECT COUNT(*) AS n FROM email_message_log
        WHERE direction = 'INBOUND' AND from_address = ? AND event_type IN ('CREATED','LINKED')
          AND created_at >= datetime('now', '-1 hour')`).get(from).n;
      if (recent >= config.rate_limit_per_hour) {
        notifyAdmins(`Email channel: ${from} exceeded ${config.rate_limit_per_hour} incidents/hour; message quarantined.`);
        return finish('QUARANTINED', `Rate limit: ${from} created ${recent} incidents in the last hour`, {}, 202, { quarantined: true });
      }
    }
    const classification = getClassifier().classify({ subject: parser.cleanSubject(msg.subject), body: cleaned });
    if (!classification.category_id) return finish('FAILED', 'No active categories configured', {}, 500, { error: 'No active categories configured' });
    const cleanedSubject = parser.cleanSubject(msg.subject);
    const title = (cleanedSubject || 'Email issue report').slice(0, 160);
    const number = nextTicketNumber();
    const related = match.relatedTicket || null;
    const description = related
      ? `${cleaned}${strippedNote}\n\n[Follow-up to ${related.ticket_number}, which was ${related.status.toLowerCase()}]`
      : cleaned + strippedNote;
    const info = db.prepare(`INSERT INTO tickets
      (ticket_number, requester_id, title, description, category_id, subcategory_id, priority_id, location_id, status,
       support_group_id, source, original_message_id, thread_subject, caller_email, caller_unverified, cc_list, related_ticket_id)
      VALUES (?,?,?,?,?,?,?,?,'NEW',?,'EMAIL',?,?,?,?,?,?)`)
      .run(number, author.id, title, description, classification.category_id, classification.subcategory_id,
        classification.priority_id || 3, user?.location_id || null, classification.assignment_group_id || null,
        mid, cleanedSubject || title, from, user ? 0 : 1, JSON.stringify([...new Set(ccAddresses)]), related?.id || null);
    let ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(info.lastInsertRowid);

    ticketHistory(ticket.id, user?.id ?? null, 'CREATED', `Ticket created from inbound email (${classification.reason})${user ? '' : ` — unverified sender ${from}`}`);
    if (!ticket.support_group_id) {
      const rule = applyAssignmentRules(ticket);
      if (rule) {
        db.prepare('UPDATE tickets SET support_group_id = ? WHERE id = ?').run(rule.target_group_id, ticket.id);
        ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
        ticketHistory(ticket.id, null, 'AUTO_ASSIGNED', `Rule "${rule.name}" routed the email ticket`);
      }
    }
    if (related) {
      ticketHistory(related.id, user?.id ?? null, 'EMAIL_LINKED', `Follow-up email opened ${number}`);
      ticketHistory(ticket.id, user?.id ?? null, 'EMAIL_LINKED', `Linked to earlier incident ${related.ticket_number}`);
    }
    applySla(ticket);
    runWorkflows('ticket.created', ticket);
    const files = await saveAttachments(ticket.id, author.id, policy.keep);
    if (files.saved.length) ticketHistory(ticket.id, user?.id ?? null, 'ATTACHMENT', `Email attachment(s): ${files.saved.join(', ')}`);
    closeLogRow(logId, { status: 'PROCESSED', ticketId: ticket.id, event: related ? 'LINKED' : 'CREATED' });
    audit(user?.id ?? null, 'EMAIL_TICKET_CREATED', 'ticket', ticket.id, `${number} from ${from}`);
    if (user) notifyUser(user.id, ticket, 'TICKET_CREATED', `Your email was converted to ticket ${number}. Reply to the acknowledgement email to add comments.`);
    if (!user) notifyAdmins(`Email channel: ${number} was raised by unverified sender ${from} — please review the caller.`);

    const { sendTicketEmail } = require('./outbound');
    const ack = sendTicketEmail(ticket.id, 'ACK');
    elog.inc('processed'); elog.inc(related ? 'linked' : 'created');
    elog.info('inbound.created', { message_id: mid, ticket: number, category_id: classification.category_id, group_id: ticket.support_group_id, linked_to: related?.ticket_number, ack: ack?.message_id });
    return {
      http: 201,
      payload: {
        ok: true, ticket_number: number, ticket_id: ticket.id, log_id: logId,
        category_id: classification.category_id, support_group_id: ticket.support_group_id,
        priority_id: ticket.priority_id, classification: classification.reason,
        linked_to: related?.ticket_number || null, ack_message_id: ack?.message_id || null,
        unverified_sender: !user,
      },
    };
  } catch (err) {
    closeLogRow(logId, { status: 'FAILED', reason: err.message });
    elog.inc('failed');
    elog.error('inbound.failed', { message_id: mid, error: err.message, stack: err.stack?.split('\n').slice(0, 3).join(' | ') });
    return { http: 500, payload: { error: `Inbound email processing failed: ${err.message}`, log_id: logId } };
  }
}

// Admin action: create a ticket by hand from a quarantined/ignored log row.
function createTicketFromLog(logId, { requester_id, category_id, priority_id, support_group_id }, actor) {
  const row = db.prepare('SELECT * FROM email_message_log WHERE id = ?').get(logId);
  if (!row || row.direction !== 'INBOUND') throw new Error('Inbound email not found');
  if (row.ticket_id) throw new Error('This email is already linked to a ticket');
  const requester = requester_id
    ? db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(requester_id)
    : db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(row.from_address);
  const author = requester || getGuestUser();
  const category = db.prepare('SELECT id FROM categories WHERE id = ? AND active = 1').get(category_id)
    || db.prepare('SELECT id FROM categories WHERE active = 1 ORDER BY id LIMIT 1').get();
  if (!category) throw new Error('Choose a valid category');
  const number = nextTicketNumber();
  const cleaned = parser.stripQuotedReply(row.body_text || '') || '(empty email body)';
  const subject = parser.cleanSubject(row.subject) || 'Email issue report';
  const info = db.prepare(`INSERT INTO tickets
    (ticket_number, requester_id, title, description, category_id, priority_id, location_id, status, support_group_id,
     source, original_message_id, thread_subject, caller_email, caller_unverified, cc_list)
    VALUES (?,?,?,?,?,?,?,'NEW',?,'EMAIL',?,?,?,?,?)`)
    .run(number, author.id, subject.slice(0, 160), cleaned.slice(0, 20000), category.id, Number(priority_id) || 3,
      requester?.location_id || null, support_group_id || null, row.message_id, subject, row.from_address,
      requester ? 0 : 1, JSON.stringify((row.cc_addresses || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)));
  let ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(info.lastInsertRowid);
  ticketHistory(ticket.id, actor?.id ?? null, 'CREATED', `Ticket created manually from quarantined email (${row.from_address})`);
  if (!ticket.support_group_id) {
    const rule = applyAssignmentRules(ticket);
    if (rule) {
      db.prepare('UPDATE tickets SET support_group_id = ? WHERE id = ?').run(rule.target_group_id, ticket.id);
      ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
    }
  }
  applySla(ticket);
  runWorkflows('ticket.created', ticket);
  closeLogRow(logId, { status: 'PROCESSED', reason: null, ticketId: ticket.id, event: 'CREATED' });
  audit(actor?.id ?? null, 'EMAIL_TICKET_CREATED', 'ticket', ticket.id, `${number} manually from email log #${logId}`);
  const { sendTicketEmail } = require('./outbound');
  sendTicketEmail(ticket.id, 'ACK');
  return ticket;
}

module.exports = { processInboundEmail, createTicketFromLog, getGuestUser, GUEST_EMAIL, BLOCKED_EXT };
