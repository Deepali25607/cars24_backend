// Email channel (S10 extension: two-way email ↔ incident sync) test suite.
// Runs the real Express app on an isolated SQLite DB. Inbound mail is fed as
// raw .eml fixtures through the token-secured relay endpoint (the same
// pipeline the IMAP listener uses); outbound mail is captured in
// services.outbox (test transport). Run: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
const TEST_DB = path.join(__dirname, 'test-email.db');
for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
process.env.ITSM_DB_PATH = TEST_DB;

const { seed, seedStandard, seedEmailChannel } = require('../src/seed');
const { buildApp } = require('../src/app');
const { db } = require('../src/db');
const { outbox, clearOutbox } = require('../src/services');
const { runEmailJobs, enqueue } = require('../src/email/queue');
const { updateConfig } = require('../src/email/config');
const parser = require('../src/email/parser');

const FIXTURES = path.join(__dirname, 'fixtures', 'email');
const MAILBOX = 'itsupport@cars24.com';

let server;
let BASE;
let apiToken;
const tokens = {};
const ctx = {}; // shared ids between tests (ticket numbers, message ids)

async function api(pathname, { method = 'GET', token, body, headers: extra } = {}) {
  const headers = { ...(extra || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data };
}
async function login(email, password = 'Passw0rd!') {
  const r = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return r.data.token;
}
function fixture(name, replacements = {}) {
  let eml = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  for (const [k, v] of Object.entries(replacements)) eml = eml.split(`{{${k}}}`).join(v);
  return eml;
}
// Feed one message through the relay endpoint, then drain the job queue so
// the acknowledgement / outbound mail lands in the outbox.
async function inbound(payload) {
  const r = await api('/api/integrations/inbound-email', { method: 'POST', headers: { 'X-Api-Token': apiToken }, body: payload });
  await runEmailJobs();
  return r;
}
const inboundEml = (name, repl) => inbound({ raw: fixture(name, repl) });
const ticketByNumber = (n) => db.prepare('SELECT * FROM tickets WHERE ticket_number = ?').get(n);
const nameOf = (table, id) => (id ? db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id)?.name : null);
const ticketCount = () => db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n;
const lastMail = () => outbox[outbox.length - 1];

before(async () => {
  seed();
  seedStandard();
  seedEmailChannel();
  updateConfig({ mailbox_address: MAILBOX, allowed_domains: 'cars24.com', portal_url: 'https://itsm.cars24.com', rate_limit_per_hour: 10 });
  const app = buildApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  BASE = `http://127.0.0.1:${server.address().port}`;
  tokens.admin = await login('admin@itsm.local');
  tokens.agent = await login('agent@itsm.local');
  tokens.employee = await login('employee@itsm.local');
  const t = await api('/api/integrations/tokens', { method: 'POST', token: tokens.admin, body: { name: 'Mail listener' } });
  apiToken = t.data.token;
});
after(() => new Promise((resolve) => server.close(resolve)));

// ---------------- 1–3: creation + classification + acknowledgement ----------------

test('EM-1 new hardware email → Hardware incident, Desktop Support, threaded ack with token appended', async () => {
  clearOutbox();
  const r = await inboundEml('01-new-hardware.eml');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.ticket_number, /^INC-\d{6}$/);
  const t = ticketByNumber(r.data.ticket_number);
  ctx.hw = t;
  assert.equal(nameOf('categories', t.category_id), 'Hardware');
  assert.equal(nameOf('support_groups', t.support_group_id), 'Desktop Support');
  assert.equal(t.source, 'EMAIL');
  assert.equal(t.original_message_id, '<hw-001@mail.cars24.com>');
  assert.equal(t.title, 'Laptop not charging');
  assert.equal(t.caller_email, 'employee@itsm.local');
  assert.equal(t.caller_unverified, 0);
  assert.deepEqual(JSON.parse(t.cc_list), ['manager@cars24.com']);
  // Description is the cleaned body: signature + disclaimer removed
  assert.match(t.description, /different socket/);
  assert.doesNotMatch(t.description, /DISCLAIMER|Senior Analyst/);

  // Acknowledgement (FR5)
  const ack = lastMail();
  assert.ok(ack, 'ack email queued and sent');
  assert.equal(ack.to, 'employee@itsm.local');
  assert.deepEqual(ack.cc, ['manager@cars24.com']);
  assert.equal(ack.subject, `RE: Laptop not charging [${t.ticket_number}]`);
  assert.equal(ack.inReplyTo, '<hw-001@mail.cars24.com>');
  assert.match(ack.references, /<hw-001@mail\.cars24\.com>/);
  assert.equal(ack.headers['Auto-Submitted'], 'auto-generated');
  assert.match(ack.text, new RegExp(`incident ${t.ticket_number} has been created`));
  assert.match(ack.text, /Category: Hardware/);
  assert.match(ack.text, /Assigned group: Desktop Support/);
  assert.match(ack.text, new RegExp(`https://itsm.cars24.com/tickets/${t.id}`));
  assert.match(ack.text, new RegExp(`Keep \\[${t.ticket_number}\\] in the subject line`));
  assert.match(ack.html, /<a href="https:\/\/itsm\.cars24\.com\/tickets\//);
  ctx.ackId = ack.messageId;
  assert.match(ctx.ackId, /^<itsm-.+@cars24\.com>$/);
  // Both directions logged
  const log = db.prepare('SELECT direction, processing_status, event_type FROM email_message_log WHERE ticket_id = ? ORDER BY id').all(t.id);
  assert.deepEqual(log, [
    { direction: 'INBOUND', processing_status: 'PROCESSED', event_type: 'CREATED' },
    { direction: 'OUTBOUND', processing_status: 'PROCESSED', event_type: 'ACK' },
  ]);
});

test('EM-2 new software email → Software category', async () => {
  const r = await inboundEml('02-new-software.eml');
  assert.equal(r.status, 201);
  const t = ticketByNumber(r.data.ticket_number);
  ctx.sw = t;
  assert.equal(nameOf('categories', t.category_id), 'Software');
  assert.equal(t.title, 'Outlook keeps crashing on startup');
});

test('EM-3 unclassifiable email → General category, Service Desk Triage group', async () => {
  const r = await inboundEml('03-unclassifiable.eml');
  assert.equal(r.status, 201);
  const t = ticketByNumber(r.data.ticket_number);
  assert.equal(nameOf('categories', t.category_id), 'General');
  assert.equal(nameOf('support_groups', t.support_group_id), 'Service Desk Triage');
});

// ---------------- 4–6: replies into history ----------------

test('EM-4 reply with token in subject → comment on the right incident, no new ticket, quoted Outlook block stripped', async () => {
  const before = ticketCount();
  const r = await inboundEml('04-reply-with-token.eml', { INC: ctx.hw.ticket_number, ACK_ID: ctx.ackId });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.threaded, true);
  assert.equal(r.data.ticket_number, ctx.hw.ticket_number);
  assert.equal(ticketCount(), before);
  const c = db.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY id DESC LIMIT 1').get(ctx.hw.id);
  assert.equal(c.body, 'Also, the charger LED is now blinking orange.');
  assert.equal(c.source, 'EMAIL');
  assert.equal(c.sender_email, 'employee@itsm.local');
  assert.equal(c.is_internal, 0);
  assert.equal(c.external_participant, 0);
  // Employee sees it in the ticket UI payload
  const detail = await api(`/api/tickets/${ctx.hw.id}`, { token: tokens.employee });
  assert.ok(detail.data.comments.some((x) => x.body.includes('blinking orange') && x.source === 'EMAIL'));
});

test('EM-5 reply with token removed but valid In-Reply-To → matched by headers', async () => {
  const before = ticketCount();
  const r = await inboundEml('05-reply-header-only.eml', { INC: ctx.hw.ticket_number, ACK_ID: ctx.ackId });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.threaded, true);
  assert.equal(r.data.ticket_number, ctx.hw.ticket_number);
  assert.equal(ticketCount(), before);
});

test('EM-6 Gmail-style quote and "--" signature stripped from the reply body', async () => {
  const c = db.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY id DESC LIMIT 1').get(ctx.hw.id);
  assert.equal(c.body, 'It still does not charge after trying a different socket.');
  // raw email kept for audit
  const log = db.prepare("SELECT raw_source, body_text FROM email_message_log WHERE message_id = '<hw-003@mail.cars24.com>'").get();
  assert.match(log.raw_source, /Senior Analyst/);
  assert.match(log.body_text, /wrote:/);
});

// ---------------- 7–8: outbound sync ----------------

test('EM-7 agent public comment → threaded email to caller with correct subject and headers', async () => {
  clearOutbox();
  const r = await api(`/api/tickets/${ctx.hw.id}/comments`, {
    method: 'POST', token: tokens.agent, body: { body: 'We are sending a replacement charger today.' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.emailed, true);
  await runEmailJobs();
  const m = lastMail();
  assert.ok(m, 'outbound comment email');
  assert.equal(m.to, 'employee@itsm.local');
  assert.deepEqual(m.cc, ['manager@cars24.com']);
  assert.equal(m.subject, `RE: Laptop not charging [${ctx.hw.ticket_number}]`);
  assert.equal(m.inReplyTo, '<hw-003@mail.cars24.com>', 'In-Reply-To = latest message in the thread');
  assert.match(m.references, /^<hw-001@mail\.cars24\.com> /, 'References starts at the thread root');
  assert.match(m.references, /<hw-003@mail\.cars24\.com>$/);
  assert.equal(m.headers['Auto-Submitted'], 'auto-replied');
  assert.equal(m.headers['X-ITSM-Incident'], ctx.hw.ticket_number);
  assert.match(m.text, /We are sending a replacement charger today\./);
  assert.match(m.html, /We are sending a replacement charger today\./);
  // The email carries the conversation so far: original request + earlier public comments
  assert.match(m.text, /Conversation so far/);
  assert.match(m.text, /Original request — .+ <employee@itsm\.local> · .* IST · via Email\nHi team,/);
  assert.match(m.text, /Also, the charger LED is now blinking orange\./);
  assert.match(m.text, /It still does not charge after trying a different socket\./);
  assert.equal((m.text.match(/We are sending a replacement charger today\./g) || []).length, 1, 'new comment is not repeated inside the history');
  assert.match(m.html, /Conversation so far/);
  assert.match(m.html, /blinking orange/);
  // Only the threaded email, not a second generic notification
  assert.equal(outbox.length, 1);
  // IT users can see the thread on the ticket
  const thread = await api(`/api/email/ticket/${ctx.hw.id}`, { token: tokens.agent });
  assert.equal(thread.status, 200);
  assert.ok(thread.data.some((x) => x.direction === 'OUTBOUND' && x.event_type === 'COMMENT'));
  const denied = await api(`/api/email/ticket/${ctx.hw.id}`, { token: tokens.employee });
  assert.equal(denied.status, 403);
});

test('EM-8 internal work note → NO email sent', async () => {
  clearOutbox();
  const r = await api(`/api/tickets/${ctx.hw.id}/comments`, {
    method: 'POST', token: tokens.agent, body: { body: 'Customer sounds annoyed, prioritise.', is_internal: true },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.is_internal, 1);
  assert.equal(r.data.emailed, false);
  await runEmailJobs();
  assert.equal(outbox.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM email_message_log WHERE ticket_id = ? AND direction = 'OUTBOUND' AND body_text LIKE '%annoyed%'").get(ctx.hw.id).n, 0);
});

test('EM-7b every action goes on the thread: assign, work started, details updated, pending, resolved', async () => {
  const subject = `RE: Laptop not charging [${ctx.hw.ticket_number}]`;
  clearOutbox();
  await api(`/api/tickets/${ctx.hw.id}/assign`, { method: 'POST', token: tokens.lead || tokens.agent, body: { agent_id: db.prepare("SELECT id FROM users WHERE email = 'agent@itsm.local'").get().id } });
  await runEmailJobs();
  const assigned = outbox.find((m) => m.to === 'employee@itsm.local');
  assert.ok(assigned, 'caller is told about the assignment on the thread');
  assert.equal(assigned.subject, subject);
  assert.match(assigned.text, /has been assigned: Assigned to .* \(Desktop Support\)/);
  // one chain per incident: the agent is CC'd on the caller's mail, never mailed separately
  assert.deepEqual(assigned.cc, ['manager@cars24.com', 'agent@itsm.local']);
  assert.equal(outbox.filter((m) => m.to === 'agent@itsm.local').length, 0, 'no standalone agent notification mail');
  assert.equal(outbox.length, 1);
  clearOutbox();
  await api(`/api/tickets/${ctx.hw.id}/status`, { method: 'POST', token: tokens.agent, body: { status: 'IN_PROGRESS' } });
  await runEmailJobs();
  assert.equal(outbox.filter((m) => m.to === 'employee@itsm.local').length, 1);
  assert.match(lastMail().text, /has started working on your incident/);
  assert.ok(lastMail().cc.includes('agent@itsm.local'), 'assigned agent stays in CC on later mails');
  clearOutbox();
  const hw = db.prepare("SELECT id FROM categories WHERE name = 'Hardware'").get().id;
  await api(`/api/tickets/${ctx.hw.id}`, { method: 'PATCH', token: tokens.agent, body: { category_id: hw, priority_id: 2 } });
  await runEmailJobs();
  assert.equal(outbox.filter((m) => m.to === 'employee@itsm.local').length, 1, 'one mail listing all changes');
  assert.match(lastMail().text, /updated the details of your incident .*: priority → P2/);
  assert.equal(lastMail().subject, subject);
  clearOutbox();
  await api(`/api/tickets/${ctx.hw.id}/status`, { method: 'POST', token: tokens.agent, body: { status: 'PENDING', note: 'Please confirm your desk number.' } });
  await runEmailJobs();
  assert.equal(outbox.length, 1);
  assert.match(lastMail().text, /on hold and awaiting your input/);
  assert.match(lastMail().text, /Please confirm your desk number\./);
  const res = await api(`/api/tickets/${ctx.hw.id}/status`, { method: 'POST', token: tokens.agent, body: { status: 'RESOLVED', note: 'Charger replaced.' } });
  assert.equal(res.status, 200);
  await runEmailJobs();
  assert.equal(outbox.length, 2);
  // Every outbound mail so far shares the subject and chains via In-Reply-To
  const thread = db.prepare("SELECT subject, in_reply_to FROM email_message_log WHERE ticket_id = ? AND direction = 'OUTBOUND' ORDER BY id").all(ctx.hw.id);
  assert.ok(thread.length >= 6);
  assert.ok(thread.every((m) => m.subject === subject));
  assert.ok(thread.slice(1).every((m) => m.in_reply_to));
  assert.match(lastMail().text, /has been resolved/);
  assert.match(lastMail().text, /Charger replaced\./);
  assert.equal(lastMail().subject, `RE: Laptop not charging [${ctx.hw.ticket_number}]`);
  // history in status mails includes public comments but never the internal note from EM-8
  assert.match(lastMail().text, /We are sending a replacement charger today\./);
  assert.doesNotMatch(lastMail().text, /annoyed/);
  assert.doesNotMatch(lastMail().html, /annoyed/);
});

// ---------------- 9: reopen window / new linked incident ----------------

test('EM-9a reply to a RESOLVED incident within the window → reopened, assignee notified, reopen email sent', async () => {
  clearOutbox();
  const before = ticketCount();
  const r = await inboundEml('13-html-only.eml', { INC: ctx.hw.ticket_number });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.reopened, true);
  assert.equal(ticketCount(), before);
  const t = ticketByNumber(ctx.hw.ticket_number);
  assert.equal(t.status, 'REOPENED');
  assert.equal(t.reopen_count, 1);
  // HTML-only body converted to text, script removed, quote stripped
  const c = db.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY id DESC LIMIT 1').get(t.id);
  assert.equal(c.body, 'The replacement charger works, thank you!\nYou can close this.');
  assert.doesNotMatch(c.body, /alert|xss|wrote:/);
  const agentId = db.prepare("SELECT id FROM users WHERE email = 'agent@itsm.local'").get().id;
  assert.ok(db.prepare("SELECT id FROM notifications WHERE user_id = ? AND ticket_id = ? AND type = 'TICKET_REOPENED'").get(agentId, t.id));
  // exactly one threaded mail to the caller (the agent's own notification mail is separate)
  const toCaller = outbox.filter((m) => m.to === 'employee@itsm.local');
  assert.equal(toCaller.length, 1);
  assert.match(toCaller[0].text, /has been reopened/);
  assert.equal(toCaller[0].subject, `RE: Laptop not charging [${t.ticket_number}]`);
  // resolve again for the next test
  await api(`/api/tickets/${t.id}/status`, { method: 'POST', token: tokens.agent, body: { status: 'IN_PROGRESS' } });
  await api(`/api/tickets/${t.id}/status`, { method: 'POST', token: tokens.agent, body: { status: 'RESOLVED', note: 'Confirmed working.' } });
  await runEmailJobs();
});

test('EM-9b reply to an incident RESOLVED longer than 7 days ago → new linked incident + new ack', async () => {
  db.prepare("UPDATE tickets SET resolved_at = datetime('now', '-8 days') WHERE id = ?").run(ctx.hw.id);
  clearOutbox();
  const before = ticketCount();
  const r = await inbound({
    message_id: '<hw-late@mail.cars24.com>', from_email: 'employee@itsm.local',
    subject: `RE: Laptop not charging [${ctx.hw.ticket_number}]`, body: 'It broke again after two weeks.',
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.threaded, undefined);
  assert.equal(r.data.linked_to, ctx.hw.ticket_number);
  assert.equal(ticketCount(), before + 1);
  const nt = ticketByNumber(r.data.ticket_number);
  assert.equal(nt.related_ticket_id, ctx.hw.id);
  assert.equal(ticketByNumber(ctx.hw.ticket_number).status, 'RESOLVED', 'old incident untouched');
  assert.equal(lastMail().subject, `RE: Laptop not charging [${nt.ticket_number}]`);
  assert.equal(lastMail().inReplyTo, '<hw-late@mail.cars24.com>');
  const detail = await api(`/api/tickets/${nt.id}`, { token: tokens.agent });
  assert.equal(detail.data.related_ticket.ticket_number, ctx.hw.ticket_number);
  ctx.linked = nt;
});

test('EM-9c reply to a CLOSED incident → new linked incident', async () => {
  await api(`/api/tickets/${ctx.hw.id}/status`, { method: 'POST', token: tokens.agent, body: { status: 'CLOSED' } });
  await runEmailJobs();
  const before = ticketCount();
  const r = await inbound({
    message_id: '<hw-closed@mail.cars24.com>', from_email: 'employee@itsm.local',
    subject: `RE: Laptop not charging [${ctx.hw.ticket_number}]`, body: 'One more thing.',
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.linked_to, ctx.hw.ticket_number);
  assert.equal(ticketCount(), before + 1);
  assert.equal(ticketByNumber(ctx.hw.ticket_number).status, 'CLOSED');
});

// ---------------- 10–11: loops, noise, idempotency ----------------

test('EM-10 out-of-office, own-mailbox and bounce messages are ignored — no ticket, no reply, no loop', async () => {
  clearOutbox();
  const before = ticketCount();
  const comments = db.prepare('SELECT COUNT(*) AS n FROM ticket_comments WHERE is_internal = 0').get().n;
  const ooo = await inboundEml('06-out-of-office.eml', { INC: ctx.sw.ticket_number, ACK_ID: ctx.ackId });
  assert.equal(ooo.status, 202);
  assert.equal(ooo.data.ignored, true);
  const self = await inboundEml('07-own-mailbox.eml', { INC: ctx.sw.ticket_number });
  assert.equal(self.status, 202);
  assert.equal(self.data.ignored, true);
  assert.match(self.data.reason, /support mailbox/);
  const ndr = await inboundEml('14-bounce.eml', { INC: ctx.hw.ticket_number, ACK_ID: ctx.ackId });
  assert.equal(ndr.status, 202);
  assert.equal(ndr.data.ignored, true);
  // bounce is logged against the matched incident (internal note only)
  const ndrLog = db.prepare("SELECT ticket_id, processing_status, event_type FROM email_message_log WHERE message_id = '<ndr-001@mail.cars24.com>'").get();
  assert.equal(ndrLog.ticket_id, ctx.hw.id);
  assert.equal(ndrLog.processing_status, 'IGNORED');
  assert.equal(ndrLog.event_type, 'BOUNCE');
  assert.equal(ticketCount(), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ticket_comments WHERE is_internal = 0').get().n, comments);
  assert.equal(outbox.length, 0);
  // subject-only detection also works ("Out of Office" without headers)
  const subj = await inbound({ message_id: '<ooo-2@x>', from_email: 'rohit@itsm.local', subject: 'Out of Office: hello', body: 'away' });
  assert.equal(subj.data.ignored, true);
});

test('EM-11 duplicate Message-ID is processed only once', async () => {
  const before = ticketCount();
  const r1 = await inbound({ message_id: '<dup-1@mail>', from_email: 'rohit@itsm.local', subject: 'Keyboard keys stuck', body: 'Several keys do not respond.' });
  assert.equal(r1.status, 201);
  const r2 = await inbound({ message_id: '<dup-1@mail>', from_email: 'rohit@itsm.local', subject: 'Keyboard keys stuck', body: 'Several keys do not respond.' });
  assert.equal(r2.status, 200);
  assert.equal(r2.data.duplicate, true);
  assert.equal(r2.data.ticket_id, ticketByNumber(r1.data.ticket_number).id);
  assert.equal(ticketCount(), before + 1);
  // durable queue also dedupes by Message-ID
  const j1 = enqueue('INBOUND', { raw: fixture('02-new-software.eml') }, { message_id: '<sw-001@mail.cars24.com>' });
  const j2 = enqueue('INBOUND', { raw: fixture('02-new-software.eml') }, { message_id: '<sw-001@mail.cars24.com>' });
  assert.equal(j1, j2);
  await runEmailJobs();
  assert.equal(ticketCount(), before + 1, 'job re-run of an already processed message creates nothing');
});

// ---------------- 12: security policies ----------------

test('EM-12a sender from a disallowed domain → quarantined (no ticket)', async () => {
  const before = ticketCount();
  const r = await inboundEml('11-disallowed-domain.eml');
  assert.equal(r.status, 202);
  assert.equal(r.data.ok, false);
  assert.equal(r.data.quarantined, true);
  assert.equal(ticketCount(), before);
  ctx.quarantinedLogId = r.data.log_id;
});

test('EM-12b blocked executable attachment → quarantined; STRIP mode keeps the mail and drops the file', async () => {
  const before = ticketCount();
  const r = await inboundEml('10-blocked-attachment.eml');
  assert.equal(r.status, 202);
  assert.equal(r.data.quarantined, true);
  assert.match(r.data.reason, /setup\.exe/);
  assert.equal(ticketCount(), before);
  updateConfig({ attachment_violation_action: 'STRIP' });
  const r2 = await inbound({
    message_id: '<exe-2@mail>', from_email: 'employee@itsm.local', subject: 'Install tool please', body: 'see attached',
    attachments: [
      { filename: 'run.bat', content_type: 'text/plain', content_base64: Buffer.from('echo hi').toString('base64') },
      { filename: 'notes.txt', content_type: 'text/plain', content_base64: Buffer.from('some notes').toString('base64') },
    ],
  });
  assert.equal(r2.status, 201);
  const t = ticketByNumber(r2.data.ticket_number);
  assert.match(t.description, /run\.bat – blocked file type/);
  const atts = db.prepare('SELECT original_name FROM ticket_attachments WHERE ticket_id = ?').all(t.id).map((a) => a.original_name);
  assert.deepEqual(atts, ['notes.txt']);
  updateConfig({ attachment_violation_action: 'QUARANTINE' });
});

test('EM-12c oversized attachment → quarantined per policy', async () => {
  updateConfig({ max_attachment_mb: 0 });
  const r = await inbound({
    message_id: '<big-1@mail>', from_email: 'employee@itsm.local', subject: 'Screenshot of error', body: 'attached',
    attachments: [{ filename: 'shot.png', content_type: 'image/png', content_base64: Buffer.alloc(2048, 1).toString('base64') }],
  });
  assert.equal(r.status, 202);
  assert.equal(r.data.quarantined, true);
  assert.match(r.data.reason, /exceeds 0 MB/);
  updateConfig({ max_attachment_mb: 10 });
});

test('EM-12d SPF/DKIM/DMARC failure → quarantined; rate limit → quarantined + admin alert', async () => {
  const r = await inbound({
    message_id: '<spoof-1@mail>', from_email: 'employee@itsm.local', subject: 'Laptop', body: 'x',
    headers: { 'Authentication-Results': 'mx.cars24.com; spf=fail smtp.mailfrom=evil.example; dkim=none; dmarc=fail' },
  });
  assert.equal(r.status, 202);
  assert.match(r.data.reason, /spf=fail, dmarc=fail/);

  updateConfig({ rate_limit_per_hour: 1 });
  const first = await inbound({ message_id: '<rl-1@mail>', from_email: 'lead@itsm.local', subject: 'Mouse broken', body: 'x' });
  assert.equal(first.status, 201);
  const second = await inbound({ message_id: '<rl-2@mail>', from_email: 'lead@itsm.local', subject: 'Monitor flickering', body: 'x' });
  assert.equal(second.status, 202);
  assert.match(second.data.reason, /Rate limit/);
  const adminId = db.prepare("SELECT id FROM users WHERE email = 'admin@itsm.local'").get().id;
  assert.ok(db.prepare("SELECT id FROM notifications WHERE user_id = ? AND type = 'EMAIL_CHANNEL_ALERT' AND message LIKE '%lead@itsm.local%'").get(adminId));
  updateConfig({ rate_limit_per_hour: 10 });
});

// ---------------- 13–14: subject handling ----------------

test('EM-13 "RE: RE: FW:" prefixes and multiple tokens → last token wins; new mail gets a clean title', async () => {
  const before = ticketCount();
  const r = await inboundEml('08-multi-token-prefixes.eml', { INC: ctx.sw.ticket_number });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.threaded, true);
  assert.equal(r.data.ticket_number, ctx.sw.ticket_number);
  assert.equal(ticketCount(), before);
  const fresh = await inbound({ message_id: '<pfx-1@mail>', from_email: 'employee@itsm.local', subject: 'FW: Fwd: AW: Projector not working in room 4', body: 'The projector shows no signal.' });
  assert.equal(fresh.status, 201);
  const t = ticketByNumber(fresh.data.ticket_number);
  assert.equal(t.title, 'Projector not working in room 4');
  assert.equal(t.thread_subject, 'Projector not working in room 4');
  assert.equal(nameOf('categories', t.category_id), 'Hardware');
  // dead token → treated as new and logged
  const dead = await inbound({ message_id: '<dead-1@mail>', from_email: 'employee@itsm.local', subject: 'RE: something [INC-999999]', body: 'hello, my keyboard is broken' });
  assert.equal(dead.status, 201);
  assert.equal(dead.data.threaded, undefined);
  assert.equal(ticketByNumber(dead.data.ticket_number).title, 'something');
});

test('EM-14 non-English RFC 2047 encoded subject and base64 UTF-8 body handled', async () => {
  const subject = 'लैपटॉप चार्ज नहीं हो रहा – laptop';
  const body = 'मेरा लैपटॉप चार्ज नहीं हो रहा है। कृपया मदद करें।';
  const r = await inboundEml('09-encoded-subject.eml', {
    SUBJECT_ENCODED: `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    BODY_B64: Buffer.from(body, 'utf8').toString('base64'),
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const t = ticketByNumber(r.data.ticket_number);
  assert.equal(t.title, subject);
  assert.equal(t.description, body);
  assert.equal(nameOf('categories', t.category_id), 'Hardware');
  assert.equal(lastMail().subject, `RE: ${subject} [${t.ticket_number}]`);
  const html = lastMail().html;
  assert.match(html, /लैपटॉप/);
});

// ---------------- Guest callers, external participants ----------------

test('EM-15 unknown sender on an allowed domain → guest incident flagged for review, ack to the sender', async () => {
  clearOutbox();
  const r = await inboundEml('12-guest-allowed-domain.eml');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.unverified_sender, true);
  const t = ticketByNumber(r.data.ticket_number);
  assert.equal(t.caller_unverified, 1);
  assert.equal(t.caller_email, 'newjoiner@cars24.com');
  assert.equal(nameOf('categories', t.category_id), 'Network');
  const requester = db.prepare('SELECT email, active FROM users WHERE id = ?').get(t.requester_id);
  assert.equal(requester.email, 'email-guest@system.local');
  assert.equal(requester.active, 0, 'guest account cannot log in');
  assert.equal(lastMail().to, 'newjoiner@cars24.com');
  assert.match(lastMail().text, /Hello newjoiner@cars24\.com/);
  ctx.guest = t;
  // reply from someone who is neither caller nor CC → flagged external
  const ext = await inbound({ message_id: '<ext-r@mail>', from_email: 'rohit@itsm.local', subject: `RE: VPN access for new joiner [${t.ticket_number}]`, body: 'I can vouch for them.' });
  assert.equal(ext.data.external_participant, true);
  const c = db.prepare('SELECT external_participant FROM ticket_comments WHERE ticket_id = ? ORDER BY id DESC LIMIT 1').get(t.id);
  assert.equal(c.external_participant, 1);
});

// ---------------- Admin API ----------------

test('EM-16 admin API: config, rules, templates, log filters; employees forbidden', async () => {
  const denied = await api('/api/email/config', { token: tokens.employee });
  assert.equal(denied.status, 403);
  const cfg = await api('/api/email/config', { token: tokens.admin });
  assert.equal(cfg.status, 200);
  assert.deepEqual(cfg.data.allowedDomains, ['cars24.com']);
  const bad = await api('/api/email/config', { method: 'PUT', token: tokens.admin, body: { unknown_sender_action: 'NOPE' } });
  assert.equal(bad.status, 400);
  const upd = await api('/api/email/config', { method: 'PUT', token: tokens.admin, body: { reopen_window_days: 14, allowed_domains: 'cars24.com, partner.example' } });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.reopen_window_days, 14);
  assert.deepEqual(upd.data.allowedDomains, ['cars24.com', 'partner.example']);
  updateConfig({ reopen_window_days: 7, allowed_domains: 'cars24.com' });

  // rules
  const hw = db.prepare("SELECT id FROM categories WHERE name = 'Hardware'").get().id;
  const created = await api('/api/email/rules', { method: 'POST', token: tokens.admin, body: { keyword: 'smart board', category_id: hw, weight: 3 } });
  assert.equal(created.status, 201);
  const test1 = await api('/api/email/rules/test', { method: 'POST', token: tokens.admin, body: { subject: 'Smart board frozen', body: '' } });
  assert.equal(test1.data.category_name, 'Hardware');
  const edited = await api(`/api/email/rules/${created.data.id}`, { method: 'PUT', token: tokens.admin, body: { is_active: 0 } });
  assert.equal(edited.data.is_active, 0);
  const test2 = await api('/api/email/rules/test', { method: 'POST', token: tokens.admin, body: { subject: 'Smart board frozen', body: '' } });
  assert.equal(test2.data.category_name, 'General');
  const del = await api(`/api/email/rules/${created.data.id}`, { method: 'DELETE', token: tokens.admin });
  assert.equal(del.status, 200);

  // templates
  const tpl = await api('/api/email/templates', { token: tokens.admin });
  assert.equal(tpl.data.templates.length, 10);
  assert.deepEqual(tpl.data.templates.map((t) => t.event_type).sort(),
    ['ACK', 'ASSIGNED', 'CLOSED', 'COMMENT', 'IN_PROGRESS', 'NOTIFY', 'ON_HOLD', 'REOPENED', 'RESOLVED', 'UPDATED']);
  assert.ok(tpl.data.placeholders.includes('incident_number'));
  const put = await api('/api/email/templates/ACK', { method: 'PUT', token: tokens.admin, body: { body_text_template: 'Hi {{caller_name}}, {{incident_number}} created. {{portal_link}}' } });
  assert.equal(put.status, 200);
  const preview = await api('/api/email/templates/ACK/preview', { method: 'POST', token: tokens.admin });
  assert.match(preview.data.text, /Hi Priya Sharma, INC-001234 created\./);
  clearOutbox();
  await inbound({ message_id: '<tpl-1@mail>', from_email: 'rohit@itsm.local', subject: 'Headset not detected', body: 'x' });
  assert.match(lastMail().text, /^Hi Rohit/);
  const reset = await api('/api/email/templates/ACK/reset', { method: 'POST', token: tokens.admin });
  assert.match(reset.data.body_text_template, /submitted successfully/);

  // log + filters
  const q = await api('/api/email/log?status=QUARANTINED', { token: tokens.admin });
  assert.ok(q.data.length >= 3);
  assert.ok(q.data.every((x) => x.processing_status === 'QUARANTINED'));
  const out = await api(`/api/email/log?direction=OUTBOUND&ticket_id=${ctx.hw.id}`, { token: tokens.admin });
  assert.ok(out.data.length >= 3 && out.data.every((x) => x.direction === 'OUTBOUND'));
  const one = await api(`/api/email/log/${ctx.quarantinedLogId}`, { token: tokens.admin });
  assert.equal(one.status, 200);
  assert.equal(one.data.raw_headers['message-id'], '<ext-001@unknown-domain.example>');
  assert.equal(one.data.raw_source, undefined);
  const status = await api('/api/email/status', { token: tokens.admin });
  assert.ok(status.data.metrics.created >= 5);
  assert.ok(status.data.metrics.quarantined >= 3);
});

test('EM-17 quarantine actions: reprocess creates the ticket, create-manually, discard, dead-letter retry/discard', async () => {
  const before = ticketCount();
  const re = await api(`/api/email/log/${ctx.quarantinedLogId}/reprocess`, { method: 'POST', token: tokens.admin });
  assert.equal(re.status, 201, JSON.stringify(re.data));
  assert.equal(ticketCount(), before + 1);
  const t = ticketByNumber(re.data.ticket_number);
  assert.equal(t.caller_email, 'someone@unknown-domain.example');
  assert.equal(t.caller_unverified, 1);
  const again = await api(`/api/email/log/${ctx.quarantinedLogId}/reprocess`, { method: 'POST', token: tokens.admin });
  assert.equal(again.status, 400);

  // manual create from the blocked-attachment message
  const exeLog = db.prepare("SELECT id FROM email_message_log WHERE message_id = '<exe-001@mail.cars24.com>'").get();
  const sw = db.prepare("SELECT id FROM categories WHERE name = 'Software'").get().id;
  const manual = await api(`/api/email/log/${exeLog.id}/create-ticket`, { method: 'POST', token: tokens.admin, body: { category_id: sw, priority_id: 4 } });
  assert.equal(manual.status, 201, JSON.stringify(manual.data));
  assert.equal(manual.data.category_id, sw);
  assert.equal(manual.data.priority_id, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ticket_attachments WHERE ticket_id = ?').get(manual.data.id).n, 0, 'blocked file never saved');

  // discard
  const big = db.prepare("SELECT id FROM email_message_log WHERE message_id = '<big-1@mail>'").get();
  const disc = await api(`/api/email/log/${big.id}/discard`, { method: 'POST', token: tokens.admin });
  assert.equal(disc.status, 200);
  assert.equal(db.prepare('SELECT processing_status FROM email_message_log WHERE id = ?').get(big.id).processing_status, 'DISCARDED');

  // dead-letter: an outbound job whose log row vanished fails permanently
  const jobId = enqueue('OUTBOUND', { logId: 999999 }, { maxAttempts: 1 });
  await runEmailJobs();
  const dead = await api('/api/email/jobs?status=DEAD', { token: tokens.admin });
  assert.ok(dead.data.some((j) => j.id === jobId));
  const retry = await api(`/api/email/jobs/${jobId}/retry`, { method: 'POST', token: tokens.admin });
  assert.equal(retry.data.status, 'QUEUED');
  await runEmailJobs();
  const gone = await api(`/api/email/jobs/${jobId}/discard`, { method: 'POST', token: tokens.admin });
  assert.equal(gone.status, 200);
  assert.equal(db.prepare('SELECT status FROM email_jobs WHERE id = ?').get(jobId).status, 'DISCARDED');
});

test('EM-18 portal tickets: generic notifications until an email arrives, then the thread is synced both ways', async () => {
  clearOutbox();
  const created = await api('/api/tickets', {
    method: 'POST', token: tokens.employee,
    body: { title: 'Portal ticket', description: 'via portal', category_id: 1, priority_id: 3 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.source, 'PORTAL');
  const c = await api(`/api/tickets/${created.data.id}/comments`, { method: 'POST', token: tokens.agent, body: { body: 'Looking into it.' } });
  assert.equal(c.data.emailed, false);
  await runEmailJobs();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_message_log WHERE ticket_id = ?').get(created.data.id).n, 0);
  assert.ok(outbox.some((m) => m.to === 'employee@itsm.local' && /New comment/.test(m.subject)), 'generic notification still sent');

  // The requester emails the desk quoting the ticket number → comment + thread starts
  clearOutbox();
  const r = await inbound({
    message_id: '<portal-reply-1@mail>', from_email: 'employee@itsm.local',
    subject: `RE: Portal ticket [${created.data.ticket_number}]`, body: 'Any update on this?',
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.threaded, true);
  const t = ticketByNumber(created.data.ticket_number);
  assert.equal(t.source, 'PORTAL', 'origin is preserved');
  assert.equal(t.thread_subject, 'Portal ticket');
  assert.equal(t.caller_email, 'employee@itsm.local');
  assert.equal(outbox.length, 0, 'an update to an existing ticket sends no acknowledgement');
  const detail = await api(`/api/tickets/${t.id}`, { token: tokens.agent });
  assert.ok(detail.data.comments.some((x) => x.body === 'Any update on this?' && x.source === 'EMAIL'));
  assert.ok(detail.data.history.some((h) => h.action === 'COMMENT' && /via email/.test(h.detail)));

  // From now on agent updates go back on that thread, and only there
  const c2 = await api(`/api/tickets/${t.id}/comments`, { method: 'POST', token: tokens.agent, body: { body: 'Yes, licence approved today.' } });
  assert.equal(c2.data.emailed, true);
  await runEmailJobs();
  assert.equal(outbox.length, 1, 'threaded mail only, no duplicate generic notification');
  assert.equal(outbox[0].subject, `RE: Portal ticket [${t.ticket_number}]`);
  assert.equal(outbox[0].inReplyTo, '<portal-reply-1@mail>');
  assert.match(outbox[0].text, /licence approved today/);
  const note = await api(`/api/tickets/${t.id}/comments`, { method: 'POST', token: tokens.agent, body: { body: 'internal', is_internal: true } });
  assert.equal(note.data.emailed, false);
  await runEmailJobs();
  assert.equal(outbox.length, 1);
});

test('EM-20 mail without a Message-ID still yields one chain: replies reference our last real id', async () => {
  clearOutbox();
  const r = await inbound({ from_email: 'rohit@itsm.local', subject: 'Webcam not detected', body: 'Teams cannot see my webcam.' });
  assert.equal(r.status, 201);
  const ack = lastMail();
  assert.equal(ack.inReplyTo, undefined, 'nothing real to reply to yet');
  assert.equal(ack.references, undefined);
  const t = ticketByNumber(r.data.ticket_number);
  clearOutbox();
  await api(`/api/tickets/${t.id}/comments`, { method: 'POST', token: tokens.agent, body: { body: 'Please update the camera driver.' } });
  await runEmailJobs();
  const m = lastMail();
  assert.equal(m.inReplyTo, ack.messageId, 'chains to the acknowledgement, not to a synthetic id');
  assert.equal(m.references, ack.messageId);
  assert.doesNotMatch(String(m.references), /itsm-noid|itsm-raw/);
  // a second no-id customer reply still keeps the chain on our real ids
  await inbound({ from_email: 'rohit@itsm.local', subject: `RE: Webcam not detected [${t.ticket_number}]`, body: 'Driver updated, still nothing.' });
  clearOutbox();
  await api(`/api/tickets/${t.id}/status`, { method: 'POST', token: tokens.agent, body: { status: 'IN_PROGRESS' } });
  await runEmailJobs();
  const started = lastMail();
  assert.equal(started.inReplyTo, m.messageId);
  await api(`/api/tickets/${t.id}/status`, { method: 'POST', token: tokens.agent, body: { status: 'PENDING', note: 'Booking a hardware check.' } });
  await runEmailJobs();
  assert.equal(lastMail().inReplyTo, started.messageId);
  assert.equal(lastMail().references, `${ack.messageId} ${m.messageId} ${started.messageId}`);
});

test('EM-19 parser unit checks: prefixes, tokens, quote stripping variants, references truncation', () => {
  assert.equal(parser.cleanSubject('AW: SV: Re[2]: Drucker kaputt [INC-001001]'), 'Drucker kaputt');
  assert.deepEqual(parser.extractTokens('[inc-000012] and INC-000013 and INC000014'), ['INC-000012', 'INC-000013', 'INC-000014']);
  assert.equal(parser.stripQuotedReply('Fixed now.\n\nFrom: IT Support\nSent: Monday\nTo: me\nSubject: x\n\nold text'), 'Fixed now.');
  assert.equal(parser.stripQuotedReply('Merci.\n\nLe lun. 21 sept. 2026 à 10:00, IT <it@x> a écrit :\n> bonjour'), 'Merci.');
  assert.equal(parser.stripQuotedReply('Thanks'), 'Thanks', 'one-word replies survive signature stripping');
  assert.equal(parser.stripQuotedReply('Done.\nSent from my iPhone'), 'Done.');
  assert.equal(parser.htmlToText('<p>Hi<br>there</p><ul><li>one</li></ul>&amp;'), 'Hi\nthere\n• one\n&');
  assert.doesNotMatch(parser.sanitizeHtml('<p onclick="x()">a</p><script>bad()</script><img src="javascript:1">'), /script|onclick|javascript/);
  const { buildThreadHeaders } = require('../src/email/outbound');
  const h = buildThreadHeaders(ctx.hw.id);
  assert.equal(h.references[0], '<hw-001@mail.cars24.com>');
  assert.ok(h.references.join(' ').length <= 998);
});
