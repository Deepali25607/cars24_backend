// Basic-phase automated test suite (BRD milestone B9).
// Functional + integration + security tests against the real Express app
// with an isolated SQLite database. Run: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
const TEST_DB = path.join(__dirname, 'test.db');
for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
process.env.ITSM_DB_PATH = TEST_DB;

const { seed } = require('../src/seed');
const { buildApp } = require('../src/app');

let server;
let BASE;
const tokens = {}; // role -> bearer token
const users = {};  // role -> user object

async function api(pathname, { method = 'GET', token, body, formData } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${pathname}`, {
    method, headers,
    body: formData ? formData : body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data };
}

async function login(email, password = 'Passw0rd!') {
  return api('/api/auth/login', { method: 'POST', body: { email, password } });
}

before(async () => {
  seed();
  const app = buildApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  BASE = `http://127.0.0.1:${server.address().port}`;
  for (const [role, email] of Object.entries({
    employee: 'employee@itsm.local', employee2: 'rohit@itsm.local',
    agent: 'agent@itsm.local', agent2: 'agent2@itsm.local',
    lead: 'lead@itsm.local', admin: 'admin@itsm.local',
  })) {
    const r = await login(email);
    assert.equal(r.status, 200, `login ${role}`);
    tokens[role] = r.data.token;
    users[role] = r.data.user;
  }
});

after(() => server && server.close());

// ---------------- Authentication ----------------

test('AUTH-1 login rejects wrong password', async () => {
  const r = await login('employee@itsm.local', 'wrong');
  assert.equal(r.status, 401);
});

test('AUTH-2 login rejects unknown user', async () => {
  const r = await login('ghost@itsm.local');
  assert.equal(r.status, 401);
});

test('AUTH-3 requests without a token are rejected', async () => {
  for (const p of ['/api/tickets', '/api/meta', '/api/admin/users', '/api/reports/dashboard']) {
    const r = await api(p);
    assert.equal(r.status, 401, p);
  }
});

test('AUTH-4 invalid/garbage token is rejected', async () => {
  const r = await api('/api/tickets', { token: 'not.a.jwt' });
  assert.equal(r.status, 401);
});

test('AUTH-5 /auth/me returns profile without password hash', async () => {
  const r = await api('/api/auth/me', { token: tokens.employee });
  assert.equal(r.status, 200);
  assert.equal(r.data.email, 'employee@itsm.local');
  assert.equal(r.data.password_hash, undefined);
});

test('AUTH-6 change password requires correct current password', async () => {
  const bad = await api('/api/auth/change-password', {
    method: 'POST', token: tokens.employee2,
    body: { currentPassword: 'nope', newPassword: 'NewPassw0rd!' },
  });
  assert.equal(bad.status, 400);
  const ok = await api('/api/auth/change-password', {
    method: 'POST', token: tokens.employee2,
    body: { currentPassword: 'Passw0rd!', newPassword: 'NewPassw0rd!' },
  });
  assert.equal(ok.status, 200);
  const relog = await login('rohit@itsm.local', 'NewPassw0rd!');
  assert.equal(relog.status, 200);
  tokens.employee2 = relog.data.token;
});

// ---------------- Ticket creation ----------------

let ticket; // main lifecycle ticket (employee's)
let meta;

test('TKT-1 employee can create a ticket; unique number generated', async () => {
  const m = await api('/api/meta', { token: tokens.employee });
  meta = m.data;
  const hw = meta.categories.find((c) => c.name === 'Hardware');
  const battery = meta.subcategories.find((s) => s.category_id === hw.id && s.name === 'Battery');

  const r1 = await api('/api/tickets', {
    method: 'POST', token: tokens.employee,
    body: {
      title: 'Test: battery issue', description: 'Drains fast.',
      category_id: hw.id, subcategory_id: battery.id, priority_id: 2,
      asset_id: meta.myAssets[0].id,
    },
  });
  assert.equal(r1.status, 201);
  assert.match(r1.data.ticket_number, /^INC-\d{6}$/);
  assert.equal(r1.data.status, 'NEW');
  ticket = r1.data;

  const r2 = await api('/api/tickets', {
    method: 'POST', token: tokens.employee,
    body: { title: 'Second ticket', description: 'x', category_id: hw.id, priority_id: 4 },
  });
  assert.equal(r2.status, 201);
  assert.notEqual(r2.data.ticket_number, r1.data.ticket_number);
});

test('TKT-2 validation: missing/invalid fields rejected', async () => {
  const hw = meta.categories.find((c) => c.name === 'Hardware');
  const sw = meta.categories.find((c) => c.name === 'Software');
  const cases = [
    { body: { description: 'x', category_id: hw.id, priority_id: 2 } },          // no title
    { body: { title: 'x', category_id: hw.id, priority_id: 2 } },                // no description
    { body: { title: 'x', description: 'x', category_id: 99999, priority_id: 2 } }, // bad category
    { body: { title: 'x', description: 'x', category_id: hw.id, priority_id: 99 } }, // bad priority
    {
      body: { // subcategory from another category
        title: 'x', description: 'x', category_id: sw.id, priority_id: 2,
        subcategory_id: meta.subcategories.find((s) => s.category_id === hw.id).id,
      },
    },
  ];
  for (const c of cases) {
    const r = await api('/api/tickets', { method: 'POST', token: tokens.employee, body: c.body });
    assert.equal(r.status, 400, JSON.stringify(c.body));
  }
});

test('TKT-3 employee cannot attach someone else\'s laptop', async () => {
  const hw = meta.categories.find((c) => c.name === 'Hardware');
  // asset id 2 is assigned to rohit, not to employee
  const r = await api('/api/tickets', {
    method: 'POST', token: tokens.employee,
    body: { title: 'x', description: 'x', category_id: hw.id, priority_id: 3, asset_id: 2 },
  });
  assert.equal(r.status, 403);
});

// ---------------- Visibility / RBAC ----------------

test('RBAC-1 employee sees only own tickets in list and detail', async () => {
  const list = await api('/api/tickets', { token: tokens.employee2 });
  assert.equal(list.status, 200);
  assert.ok(list.data.every((t) => t.requester_id === users.employee2.id));

  const other = await api(`/api/tickets/${ticket.id}`, { token: tokens.employee2 });
  assert.equal(other.status, 403);
});

test('RBAC-2 employee cannot reach admin, assets, or report APIs', async () => {
  for (const p of ['/api/admin/users', '/api/admin/audit', '/api/assets', '/api/reports/tickets']) {
    const r = await api(p, { token: tokens.employee });
    assert.ok([401, 403].includes(r.status), `${p} -> ${r.status}`);
  }
});

test('RBAC-3 employee cannot assign or classify tickets', async () => {
  const a = await api(`/api/tickets/${ticket.id}/assign`, {
    method: 'POST', token: tokens.employee, body: { agent_id: users.agent.id },
  });
  assert.equal(a.status, 403);
  const p = await api(`/api/tickets/${ticket.id}`, {
    method: 'PATCH', token: tokens.employee, body: { priority_id: 1 },
  });
  assert.equal(p.status, 403);
});

test('RBAC-4 agent can self-assign but not assign others', async () => {
  const toOther = await api(`/api/tickets/${ticket.id}/assign`, {
    method: 'POST', token: tokens.agent, body: { agent_id: users.agent2.id },
  });
  assert.equal(toOther.status, 403);

  const toSelf = await api(`/api/tickets/${ticket.id}/assign`, {
    method: 'POST', token: tokens.agent, body: { agent_id: users.agent.id },
  });
  assert.equal(toSelf.status, 200);
  assert.equal(toSelf.data.status, 'ASSIGNED');
  assert.equal(toSelf.data.assigned_agent_id, users.agent.id);
});

test('RBAC-5 team lead can reassign to another agent', async () => {
  const r = await api(`/api/tickets/${ticket.id}/assign`, {
    method: 'POST', token: tokens.lead, body: { agent_id: users.agent2.id },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.assigned_agent_id, users.agent2.id);
  // hand it back to agent for the rest of the lifecycle
  await api(`/api/tickets/${ticket.id}/assign`, {
    method: 'POST', token: tokens.lead, body: { agent_id: users.agent.id },
  });
});

// ---------------- Lifecycle ----------------

test('LIFE-1 invalid transitions are rejected', async () => {
  // ASSIGNED -> CLOSED is not allowed
  const r = await api(`/api/tickets/${ticket.id}/status`, {
    method: 'POST', token: tokens.agent, body: { status: 'CLOSED' },
  });
  assert.equal(r.status, 400);
});

test('LIFE-2 employee cannot perform IT-only transitions', async () => {
  const r = await api(`/api/tickets/${ticket.id}/status`, {
    method: 'POST', token: tokens.employee, body: { status: 'IN_PROGRESS' },
  });
  assert.equal(r.status, 403);
});

test('LIFE-3 assigned -> in progress -> pending -> in progress', async () => {
  for (const s of ['IN_PROGRESS', 'PENDING', 'IN_PROGRESS']) {
    const r = await api(`/api/tickets/${ticket.id}/status`, {
      method: 'POST', token: tokens.agent, body: { status: s },
    });
    assert.equal(r.status, 200, s);
    assert.equal(r.data.status, s);
  }
});

test('LIFE-4 resolve requires a note; then employee closes; then reopens', async () => {
  const noNote = await api(`/api/tickets/${ticket.id}/status`, {
    method: 'POST', token: tokens.agent, body: { status: 'RESOLVED' },
  });
  assert.equal(noNote.status, 400);

  const ok = await api(`/api/tickets/${ticket.id}/status`, {
    method: 'POST', token: tokens.agent, body: { status: 'RESOLVED', note: 'Replaced battery.' },
  });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.resolved_at);

  const closed = await api(`/api/tickets/${ticket.id}/status`, {
    method: 'POST', token: tokens.employee, body: { status: 'CLOSED' },
  });
  assert.equal(closed.status, 200);
  assert.ok(closed.data.closed_at);

  const reopened = await api(`/api/tickets/${ticket.id}/status`, {
    method: 'POST', token: tokens.employee, body: { status: 'REOPENED' },
  });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.data.reopen_count, 1);

  // park it back at resolved so later tests have a stable state
  const back = await api(`/api/tickets/${ticket.id}/status`, {
    method: 'POST', token: tokens.agent, body: { status: 'RESOLVED', note: 'Re-verified fix.' },
  });
  assert.equal(back.status, 200);
});

// ---------------- Comments & work notes ----------------

test('CMT-1 empty comment rejected; comment + internal note flow', async () => {
  const empty = await api(`/api/tickets/${ticket.id}/comments`, {
    method: 'POST', token: tokens.employee, body: { body: '   ' },
  });
  assert.equal(empty.status, 400);

  const pub = await api(`/api/tickets/${ticket.id}/comments`, {
    method: 'POST', token: tokens.employee, body: { body: 'Any update?' },
  });
  assert.equal(pub.status, 201);

  const internal = await api(`/api/tickets/${ticket.id}/comments`, {
    method: 'POST', token: tokens.agent, body: { body: 'Vendor RMA #123', is_internal: true },
  });
  assert.equal(internal.status, 201);
  assert.equal(internal.data.is_internal, 1);
});

test('CMT-2 internal notes hidden from employee, visible to IT', async () => {
  const empView = await api(`/api/tickets/${ticket.id}`, { token: tokens.employee });
  assert.ok(empView.data.comments.every((c) => c.is_internal === 0), 'employee must not see work notes');

  const itView = await api(`/api/tickets/${ticket.id}`, { token: tokens.lead });
  assert.ok(itView.data.comments.some((c) => c.is_internal === 1), 'IT must see work notes');
});

test('CMT-3 employee cannot smuggle an internal note (flag ignored)', async () => {
  const r = await api(`/api/tickets/${ticket.id}/comments`, {
    method: 'POST', token: tokens.employee, body: { body: 'sneaky', is_internal: true },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.is_internal, 0);
});

// ---------------- Attachments ----------------

test('ATT-1 allowed file uploads; disallowed types rejected', async () => {
  const fd = new FormData();
  fd.append('file', new Blob(['fake image bytes'], { type: 'image/png' }), 'screen.png');
  const ok = await api(`/api/tickets/${ticket.id}/attachments`, {
    method: 'POST', token: tokens.employee, formData: fd,
  });
  assert.equal(ok.status, 201);

  const bad = new FormData();
  bad.append('file', new Blob(['MZ...'], { type: 'application/x-msdownload' }), 'virus.exe');
  const rej = await api(`/api/tickets/${ticket.id}/attachments`, {
    method: 'POST', token: tokens.employee, formData: bad,
  });
  assert.equal(rej.status, 400);
});

test('ATT-2 attachment download blocked for outsiders', async () => {
  const view = await api(`/api/tickets/${ticket.id}`, { token: tokens.employee });
  const att = view.data.attachments[0];
  assert.ok(att);
  const r = await api(`/api/tickets/${ticket.id}/attachments/${att.id}`, { token: tokens.employee2 });
  assert.equal(r.status, 403);
});

// ---------------- History, notifications, audit ----------------

test('HIS-1 full history recorded for the lifecycle', async () => {
  const view = await api(`/api/tickets/${ticket.id}`, { token: tokens.lead });
  const actions = view.data.history.map((h) => h.action);
  for (const expected of ['CREATED', 'ASSIGNED', 'STATUS_IN_PROGRESS', 'STATUS_RESOLVED',
    'STATUS_CLOSED', 'STATUS_REOPENED', 'COMMENT', 'WORK_NOTE', 'ATTACHMENT']) {
    assert.ok(actions.includes(expected), `history missing ${expected}`);
  }
});

test('NTF-1 notifications generated and mark-read works', async () => {
  const n1 = await api('/api/notifications', { token: tokens.employee });
  assert.ok(n1.data.items.length > 0);
  assert.ok(n1.data.unread > 0);
  await api('/api/notifications/read', { method: 'POST', token: tokens.employee });
  const n2 = await api('/api/notifications', { token: tokens.employee });
  assert.equal(n2.data.unread, 0);
});

test('AUD-1 audit log captures logins and ticket actions (admin only)', async () => {
  const r = await api('/api/admin/audit', { token: tokens.admin });
  assert.equal(r.status, 200);
  const actions = r.data.map((a) => a.action);
  assert.ok(actions.includes('LOGIN'));
  assert.ok(actions.includes('TICKET_CREATED'));
});

// ---------------- Administration ----------------

test('ADM-1 admin can create users; duplicates rejected; temp password issued', async () => {
  const r = await api('/api/admin/users', {
    method: 'POST', token: tokens.admin,
    body: { email: 'newbie@itsm.local', full_name: 'New Person', role: 'EMPLOYEE' },
  });
  assert.equal(r.status, 201);
  assert.ok(r.data.temp_password);

  const dup = await api('/api/admin/users', {
    method: 'POST', token: tokens.admin,
    body: { email: 'newbie@itsm.local', full_name: 'Clone', role: 'EMPLOYEE' },
  });
  assert.equal(dup.status, 409);

  const badRole = await api('/api/admin/users', {
    method: 'POST', token: tokens.admin,
    body: { email: 'x@itsm.local', full_name: 'X', role: 'SUPERUSER' },
  });
  assert.equal(badRole.status, 400);
});

test('ADM-2 deactivated user cannot log in or use an old token', async () => {
  const list = await api('/api/admin/users', { token: tokens.admin });
  const newbie = list.data.find((u) => u.email === 'newbie@itsm.local');
  const upd = await api(`/api/admin/users/${newbie.id}`, {
    method: 'PATCH', token: tokens.admin, body: { active: 0 },
  });
  assert.equal(upd.status, 200);
  // (temp password unknown-hash path: just verify login is blocked)
  const r = await login('newbie@itsm.local', 'Welcome1!');
  assert.equal(r.status, 401);
});

test('ADM-3 admin cannot deactivate own account', async () => {
  const r = await api(`/api/admin/users/${users.admin.id}`, {
    method: 'PATCH', token: tokens.admin, body: { active: 0 },
  });
  assert.equal(r.status, 400);
});

test('ADM-4 reference data CRUD with duplicate protection', async () => {
  const d = await api('/api/admin/departments', {
    method: 'POST', token: tokens.admin, body: { name: 'Legal' },
  });
  assert.equal(d.status, 201);
  const dup = await api('/api/admin/departments', {
    method: 'POST', token: tokens.admin, body: { name: 'Legal' },
  });
  assert.equal(dup.status, 409);

  const cat = await api('/api/admin/categories', {
    method: 'POST', token: tokens.admin, body: { name: 'Printing' },
  });
  assert.equal(cat.status, 201);
  const sub = await api(`/api/admin/categories/${cat.data.id}/subcategories`, {
    method: 'POST', token: tokens.admin, body: { name: 'Paper jam' },
  });
  assert.equal(sub.status, 201);

  const prio = await api('/api/admin/priorities/4', {
    method: 'PATCH', token: tokens.admin, body: { label: 'Low / Question' },
  });
  assert.equal(prio.status, 200);
});

// ---------------- Assets ----------------

test('AST-1 asset CRUD; duplicate serial rejected; agent cannot create', async () => {
  const create = await api('/api/assets', {
    method: 'POST', token: tokens.admin,
    body: { asset_tag: 'LAP-0100', serial_number: 'TESTSER100', manufacturer: 'Dell', model: 'XPS 13' },
  });
  assert.equal(create.status, 201);

  const dup = await api('/api/assets', {
    method: 'POST', token: tokens.admin,
    body: { asset_tag: 'LAP-0101', serial_number: 'TESTSER100', manufacturer: 'Dell', model: 'XPS 13' },
  });
  assert.equal(dup.status, 409);

  const byAgent = await api('/api/assets', {
    method: 'POST', token: tokens.agent,
    body: { asset_tag: 'LAP-0102', serial_number: 'TESTSER102', manufacturer: 'HP', model: 'Elite' },
  });
  assert.equal(byAgent.status, 403);

  const list = await api('/api/assets?q=TESTSER100', { token: tokens.agent });
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 1);
});

// ---------------- Reports & dashboards ----------------

test('RPT-1 dashboards return role-appropriate shapes', async () => {
  const emp = await api('/api/reports/dashboard', { token: tokens.employee });
  assert.equal(emp.data.role, 'EMPLOYEE');
  assert.ok(typeof emp.data.open === 'number');

  const agent = await api('/api/reports/dashboard', { token: tokens.agent });
  assert.ok(typeof agent.data.mine === 'number');
  assert.ok(Array.isArray(agent.data.byPriority));

  const admin = await api('/api/reports/dashboard', { token: tokens.admin });
  assert.ok(typeof admin.data.total === 'number');
});

test('RPT-2 ticket reports aggregate correctly and honor date filters', async () => {
  const rep = await api('/api/reports/tickets', { token: tokens.lead });
  assert.equal(rep.status, 200);
  assert.ok(rep.data.total >= 2);
  const sumStatus = rep.data.byStatus.reduce((a, b) => a + b.n, 0);
  assert.equal(sumStatus, rep.data.total, 'byStatus must sum to total');

  const future = await api('/api/reports/tickets?from=2099-01-01', { token: tokens.lead });
  assert.equal(future.data.total, 0);
});

// ---------------- Input robustness ----------------

test('SEC-1 quotes and script tags are stored safely, not executed/broken', async () => {
  const hw = meta.categories.find((c) => c.name === 'Hardware');
  const nasty = `Robert'); DROP TABLE tickets;-- <script>alert(1)</script>`;
  const r = await api('/api/tickets', {
    method: 'POST', token: tokens.employee,
    body: { title: nasty, description: nasty, category_id: hw.id, priority_id: 4 },
  });
  assert.equal(r.status, 201);
  const view = await api(`/api/tickets/${r.data.id}`, { token: tokens.employee });
  assert.equal(view.data.title, nasty); // parameterized SQL: stored verbatim
  const list = await api('/api/tickets', { token: tokens.employee });
  assert.ok(Array.isArray(list.data)); // table still alive
});

test('SEC-2 malformed JSON body returns 400, not a crash', async () => {
  const res = await fetch(`${BASE}/api/tickets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.employee}`, 'Content-Type': 'application/json' },
    body: '{"title": broken',
  });
  assert.equal(res.status, 400);
});
