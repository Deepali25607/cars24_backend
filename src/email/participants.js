const { db } = require('../db');
const { audit, ticketHistory, notifyUser } = require('../services');
const { getConfig } = require('./config');
const elog = require('./log');

// ================= Email participants (the ticket's CC watch list) =================
// tickets.cc_list holds everyone besides the caller who follows the incident's
// email thread. Any number of addresses can join, two ways:
//   1. a participant replies on the thread and types new addresses into To/Cc
//   2. an agent (or the caller) adds them from the portal
// Whoever is added receives the conversation so far in one catch-up mail on the
// original thread, is copied on every later thread mail, and the addition is
// written to ticket history + audit like any other change to the incident.

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

// Accepts an array, or one string holding several addresses separated by
// commas / semicolons / newlines, with or without a display name.
function parseAddressList(input) {
  const tokens = [];
  for (const chunk of Array.isArray(input) ? input : String(input ?? '').split(/[,;\n]+/)) {
    const s = String(chunk ?? '').trim();
    if (!s) continue;
    if (s.includes('<')) tokens.push(s);
    else tokens.push(...s.split(/\s+/));
  }
  const addresses = [];
  const invalid = [];
  for (const token of tokens) {
    const m = token.match(/<([^>]+)>/);
    const addr = (m ? m[1] : token).trim().toLowerCase().replace(/^mailto:/, '');
    if (!addr) continue;
    if (!EMAIL_RE.test(addr)) { if (!invalid.includes(token)) invalid.push(token); continue; }
    if (!addresses.includes(addr)) addresses.push(addr);
  }
  return { addresses, invalid };
}

function listParticipants(ticket) {
  try {
    const list = JSON.parse(ticket?.cc_list || '[]');
    return Array.isArray(list) ? list.map((s) => String(s).toLowerCase()).filter(Boolean) : [];
  } catch { return []; }
}

// Addresses that are on the thread by definition and never need to be repeated
// on the watch list: the support mailbox and the caller.
function alreadyOnThread(ticket, config) {
  const set = new Set([...config.systemAddresses]);
  if (ticket.caller_email) set.add(ticket.caller_email.toLowerCase());
  const requester = db.prepare('SELECT email FROM users WHERE id = ?').get(ticket.requester_id)?.email;
  if (requester) set.add(requester.toLowerCase());
  return set;
}

// The agent the system copies on every thread mail anyway (cc_assigned_agent):
// they join the list like anyone else, but there is no trail to catch them up on.
function alreadyReceivingThread(ticket) {
  const config = getConfig();
  if (!config.cc_assigned_agent || !ticket.assigned_agent_id) return new Set();
  const agent = db.prepare('SELECT email FROM users WHERE id = ? AND active = 1').get(ticket.assigned_agent_id);
  return new Set(agent?.email ? [agent.email.toLowerCase()] : []);
}

// Add one or many addresses to the watch list.
// opts: { actorId, actorName, via: 'portal'|'email', startThread, catchUp }
// Returns { ticket, added: [], skipped: [{address, reason}], invalid: [] }.
function addParticipants(ticketId, input, opts = {}) {
  const { actorId = null, actorName = null, via = 'portal', startThread = false, catchUp = true } = opts;
  let ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!ticket) throw new Error('Ticket not found');
  const config = getConfig();
  const { addresses, invalid } = parseAddressList(input);
  const list = listParticipants(ticket);
  const onThread = alreadyOnThread(ticket, config);
  const added = [];
  const skipped = invalid.map((address) => ({ address, reason: 'not a valid email address' }));

  for (const address of addresses) {
    if (list.includes(address)) { skipped.push({ address, reason: 'already on the CC list' }); continue; }
    if (onThread.has(address)) { skipped.push({ address, reason: 'already on the thread' }); continue; }
    list.push(address);
    added.push(address);
  }
  if (!added.length) return { ticket, added, skipped, invalid };

  db.prepare("UPDATE tickets SET cc_list = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(list), ticket.id);
  // A portal ticket gets its mail thread the moment somebody is put on copy, so
  // the catch-up and every later update are real messages on one chain. Only
  // with the channel on: a thread nothing can send on would silence the generic
  // notification mail the caller otherwise gets (services.notifyUser).
  if (startThread && !ticket.thread_subject && config.enabled) {
    const requesterEmail = db.prepare('SELECT email FROM users WHERE id = ?').get(ticket.requester_id)?.email || null;
    db.prepare('UPDATE tickets SET thread_subject = ?, caller_email = COALESCE(caller_email, ?) WHERE id = ?')
      .run(ticket.title, requesterEmail, ticket.id);
  }
  ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);

  const plural = added.length > 1;
  const how = via === 'email' ? 'on the email thread' : `by ${actorName || 'the service desk'}`;
  ticketHistory(ticket.id, actorId, 'EMAIL_CC_ADDED',
    `${added.join(', ')} ${plural ? 'were' : 'was'} added to the CC list ${how} — the conversation so far was sent and they stay on the thread`);
  audit(actorId, 'TICKET_CC_ADDED', 'ticket', ticket.id, `${ticket.ticket_number}: +${added.join(', ')} (${via})`);

  // One in-app notification, to each newcomer who is an ITSM user. The agent
  // working the ticket learns of the addition from the history entry above and
  // from the CC line of the next thread mail — notifying them here would be a
  // second message about one event.
  for (const address of added) {
    const u = db.prepare('SELECT id FROM users WHERE email = ? AND active = 1').get(address);
    if (u && u.id !== actorId) {
      notifyUser(u.id, ticket, 'TICKET_CC_ADDED', `You were added to the email thread of ticket ${ticket.ticket_number}.`);
    }
  }

  let mail = null;
  if (catchUp) {
    // The assigned agent is copied on the chain already — record them on the
    // list, but do not mail them a "you have been added" catch-up.
    const receiving = alreadyReceivingThread(ticket);
    const { sendThreadCatchUp } = require('./outbound');
    mail = sendThreadCatchUp(ticket.id, added.filter((a) => !receiving.has(a)), { actor_name: actorName, via });
  }
  elog.info('participants.added', {
    ticket: ticket.ticket_number, added, via, catch_up: mail?.message_id || null,
  });
  return { ticket, added, skipped, invalid, mail };
}

// Take one or many addresses off the watch list; they stop receiving thread mail.
function removeParticipants(ticketId, input, opts = {}) {
  const { actorId = null, actorName = null } = opts;
  let ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!ticket) throw new Error('Ticket not found');
  const { addresses } = parseAddressList(input);
  const list = listParticipants(ticket);
  const removed = addresses.filter((a) => list.includes(a));
  if (!removed.length) return { ticket, removed: [] };
  const next = list.filter((a) => !removed.includes(a));
  db.prepare("UPDATE tickets SET cc_list = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(next), ticket.id);
  ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
  ticketHistory(ticket.id, actorId, 'EMAIL_CC_REMOVED',
    `${removed.join(', ')} ${removed.length > 1 ? 'were' : 'was'} removed from the CC list by ${actorName || 'the service desk'}`);
  audit(actorId, 'TICKET_CC_REMOVED', 'ticket', ticket.id, `${ticket.ticket_number}: -${removed.join(', ')}`);
  elog.info('participants.removed', { ticket: ticket.ticket_number, removed });
  return { ticket, removed };
}

// An inbound reply on the thread: everybody in To/Cc joins the watch list —
// colleagues, managers and IT staff alike — so what the mail headers say and
// what the ticket says are the same thing. Anyone can be taken off again from
// the ticket's Email participants card.
function syncFromInbound(ticket, msg, config, { actorId = null, sender = null } = {}) {
  const candidates = [];
  for (const a of [...(msg.cc || []), ...(msg.to || [])]) {
    const address = String(a?.address || '').trim().toLowerCase();
    if (!address || address === sender) continue;
    if (config.systemAddresses.has(address)) continue;
    candidates.push(address);
  }
  if (!candidates.length) return { ticket, added: [], skipped: [], invalid: [] };
  return addParticipants(ticket.id, candidates, { actorId, via: 'email' });
}

module.exports = {
  parseAddressList, listParticipants, addParticipants, removeParticipants,
  syncFromInbound,
};
