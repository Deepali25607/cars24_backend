// Security regression suite for the go-live hardening pass:
// cross-group access control, login lockout, forced password change, JWT
// revocation, and safe attachment serving.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.LOGIN_MAX_FAILS = '5';
const TEST_DB = path.join(__dirname, 'test-security.db');
for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
process.env.ITSM_DB_PATH = TEST_DB;

const { seed, seedStandard, seedAdvanced, seedEmailChannel } = require('../src/seed');
const { buildApp } = require('../src/app');

let server;
let BASE;
const tokens = {};
const users = {};
const meta = {};

async function api(pathname, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${pathname}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data, headers: res.headers };
}
const login = (email, password = 'Passw0rd!') => api('/api/auth/login', { method: 'POST', body: { email, password } });

let secTicketId; // a Security-team ticket a Desktop agent must not touch

before(async () => {
  seed(); seedStandard(); seedAdvanced(); seedEmailChannel();
  const app = buildApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  BASE = `http://127.0.0.1:${server.address().port}`;
  for (const [role, email] of Object.entries({
    employee: 'employee@itsm.local', agent: 'agent@itsm.local',
    lead: 'lead@itsm.local', admin: 'admin@itsm.local',
  })) {
    const r = await login(email);
    tokens[role] = r.data.token;
    users[role] = r.data.user;
  }
  const m = await api('/api/meta', { token: tokens.admin });
  meta.groups = m.data.groups;
  meta.categories = m.data.categories;

  // Employee raises a ticket; admin routes it to the Security Team (no agent).
  const sec = meta.groups.find((g) => g.name === 'Security Team');
  const created = await api('/api/tickets', {
    method: 'POST', token: tokens.employee,
    body: { title: 'Phishing report', description: 'Suspicious email received.', category_id: meta.categories[0].id, priority_id: 1 },
  });
  secTicketId = created.data.id;
  await api(`/api/tickets/${secTicketId}/assign`, { method: 'POST', token: tokens.admin, body: { group_id: sec.id } });
});

after(() => server && server.close());

// ---------------- Cross-group access control (report finding #2) ----------------

test('SEC-ACL-1 a Desktop agent cannot self-assign another team\'s ticket', async () => {
  const r = await api(`/api/tickets/${secTicketId}/assign`, {
    method: 'POST', token: tokens.agent, body: { agent_id: users.agent.id },
  });
  assert.equal(r.status, 403);
});

test('SEC-ACL-2 a Desktop agent cannot change status of another team\'s ticket', async () => {
  const r = await api(`/api/tickets/${secTicketId}/status`, {
    method: 'POST', token: tokens.agent, body: { status: 'IN_PROGRESS' },
  });
  assert.equal(r.status, 403);
});

test('SEC-ACL-3 a Desktop agent cannot re-classify another team\'s ticket', async () => {
  const r = await api(`/api/tickets/${secTicketId}`, {
    method: 'PATCH', token: tokens.agent, body: { priority_id: 2 },
  });
  assert.equal(r.status, 403);
});

test('SEC-ACL-4 AI endpoints do not leak another team\'s ticket to an agent', async () => {
  const sum = await api(`/api/ai/summary/${secTicketId}`, { token: tokens.agent });
  assert.equal(sum.status, 403);
  const asg = await api(`/api/ai/assignment/${secTicketId}`, { token: tokens.agent });
  assert.equal(asg.status, 403);
});

test('SEC-ACL-5 the email thread of another team\'s ticket is hidden from an agent', async () => {
  const r = await api(`/api/email/ticket/${secTicketId}`, { token: tokens.agent });
  assert.equal(r.status, 403);
});

test('SEC-ACL-6 admins and team leads retain cross-group oversight', async () => {
  assert.equal((await api(`/api/tickets/${secTicketId}`, { token: tokens.admin })).status, 200);
  assert.equal((await api(`/api/tickets/${secTicketId}`, { token: tokens.lead })).status, 200);
});

// ---------------- Auth hardening (report finding #3) ----------------

test('SEC-AUTH-1 repeated bad logins are locked out', async () => {
  const email = 'lockme@itsm.local';
  let last;
  for (let i = 0; i < 6; i += 1) last = await login(email, 'wrong');
  assert.equal(last.status, 429, 'should be locked after 5 failures');
});

test('SEC-AUTH-2 a user with a temp password must change it before using the app', async () => {
  const created = await api('/api/admin/users', {
    method: 'POST', token: tokens.admin,
    body: { email: 'temp.user@itsm.local', full_name: 'Temp User', role: 'EMPLOYEE' },
  });
  assert.equal(created.status, 201);
  const temp = created.data.temp_password;
  assert.ok(temp, 'a temp password is returned');
  const li = await login('temp.user@itsm.local', temp);
  assert.equal(li.status, 200);
  assert.equal(li.data.user.must_change_password, 1);
  // Any protected call is refused until the password is changed.
  const blocked = await api('/api/tickets', { token: li.data.token });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'PASSWORD_CHANGE_REQUIRED');
  // After changing it (fresh token returned), the app works.
  const ch = await api('/api/auth/change-password', {
    method: 'POST', token: li.data.token, body: { currentPassword: temp, newPassword: 'BrandNew#9' },
  });
  assert.equal(ch.status, 200);
  assert.ok(ch.data.token);
  assert.equal((await api('/api/tickets', { token: ch.data.token })).status, 200);
});

test('SEC-AUTH-3 logout revokes the JWT', async () => {
  const created = await api('/api/admin/users', {
    method: 'POST', token: tokens.admin,
    body: { email: 'revoke.me@itsm.local', full_name: 'Revoke Me', role: 'EMPLOYEE', password: 'InitialPass#1' },
  });
  assert.equal(created.status, 201);
  const li = await login('revoke.me@itsm.local', 'InitialPass#1');
  assert.equal(li.status, 200);
  const token = li.data.token;
  assert.equal((await api('/api/auth/me', { token })).status, 200);
  await api('/api/auth/logout', { method: 'POST', token });
  // The old token is now rejected.
  assert.equal((await api('/api/tickets', { token })).status, 401);
});

// ---------------- Safe attachment serving (report finding #1) ----------------

test('SEC-ATT-1 attachments are served as downloads with nosniff', async () => {
  // Employee uploads a small text file to their own ticket, then downloads it.
  const created = await api('/api/tickets', {
    method: 'POST', token: tokens.employee,
    body: { title: 'Attach test', description: 'x', category_id: meta.categories[0].id, priority_id: 3 },
  });
  const tid = created.data.id;
  const fd = new FormData();
  fd.append('file', new Blob(['hello'], { type: 'text/plain' }), 'note.txt');
  const up = await fetch(`${BASE}/api/tickets/${tid}/attachments`, {
    method: 'POST', headers: { Authorization: `Bearer ${tokens.employee}` }, body: fd,
  });
  assert.equal(up.status, 201);
  const attId = (await up.json()).id;
  const dl = await fetch(`${BASE}/api/tickets/${tid}/attachments/${attId}`, {
    headers: { Authorization: `Bearer ${tokens.employee}` },
  });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition') || '', /^attachment/);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
});
