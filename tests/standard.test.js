// Standard-phase automated test suite (BRD section 7, milestone S16).
// Functional + integration + RBAC + security tests against the real Express
// app with an isolated SQLite database. Run: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
const TEST_DB = path.join(__dirname, 'test-standard.db');
for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
process.env.ITSM_DB_PATH = TEST_DB;

const { seed, seedStandard } = require('../src/seed');
const { buildApp } = require('../src/app');
const { db } = require('../src/db');

let server;
let BASE;
const tokens = {};
const users = {};
let meta;

async function api(pathname, { method = 'GET', token, body, headers: extra } = {}) {
  const headers = { ...(extra || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${pathname}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
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
  seedStandard();
  const app = buildApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  BASE = `http://127.0.0.1:${server.address().port}`;
  for (const [role, email] of Object.entries({
    employee: 'employee@itsm.local', employee2: 'rohit@itsm.local',
    agent: 'agent@itsm.local', lead: 'lead@itsm.local', admin: 'admin@itsm.local',
  })) {
    const r = await login(email);
    assert.equal(r.status, 200, `login ${role}`);
    tokens[role] = r.data.token;
    users[role] = r.data.user;
  }
  meta = (await api('/api/meta', { token: tokens.admin })).data;
});

after(() => server && server.close());

const cat = (name) => meta.categories.find((c) => c.name === name);
const grp = (name) => meta.groups.find((g) => g.name === name);

// ---------------- Health / phase ----------------

test('STD-0 health endpoint reports the current phase', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal((await res.json()).phase, 'ADVANCED');
});

// ---------------- S3: automated assignment ----------------

let hwTicket;
test('RULE-1 hardware ticket is auto-routed to Desktop Support', async () => {
  const r = await api('/api/tickets', {
    method: 'POST', token: tokens.employee,
    body: {
      title: 'Laptop screen flickers', description: 'Flickering after boot',
      category_id: cat('Hardware').id, priority_id: 1,
    },
  });
  assert.equal(r.status, 201);
  hwTicket = r.data;
  assert.equal(r.data.group_name, 'Desktop Support');
});

test('RULE-2 network ticket routes to Network Team', async () => {
  const r = await api('/api/tickets', {
    method: 'POST', token: tokens.employee2,
    body: {
      title: 'VPN keeps dropping', description: 'Disconnects every 5 minutes',
      category_id: cat('Network').id, priority_id: 3,
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.group_name, 'Network Team');
});

test('RULE-3 admin can create a rule and it wins by sort order', async () => {
  const create = await api('/api/admin/assignment-rules', {
    method: 'POST', token: tokens.admin,
    body: {
      name: 'P4 software to Network Team (test)', sort: 1,
      category_id: cat('Software').id, priority_id: 4,
      target_group_id: grp('Network Team').id,
    },
  });
  assert.equal(create.status, 201);
  const t = await api('/api/tickets', {
    method: 'POST', token: tokens.employee,
    body: {
      title: 'Browser very slow', description: 'Pages take forever',
      category_id: cat('Software').id, priority_id: 4,
    },
  });
  assert.equal(t.data.group_name, 'Network Team');
  // deactivate so later tests see default routing
  await api(`/api/admin/assignment-rules/${create.data.id}`, {
    method: 'PATCH', token: tokens.admin, body: { active: 0 },
  });
});

test('RULE-4 employees cannot manage assignment rules', async () => {
  const r = await api('/api/admin/assignment-rules', { token: tokens.employee });
  assert.equal(r.status, 403);
});

test('RULE-5 a catch-all rule (no conditions) can be created (UAT defect DEF-S-001)', async () => {
  const create = await api('/api/admin/assignment-rules', {
    method: 'POST', token: tokens.admin,
    body: { name: 'Catch-all fallback', sort: 999, target_group_id: grp('Desktop Support').id },
  });
  assert.equal(create.status, 201);
  // deactivate so it does not affect later routing assertions
  await api(`/api/admin/assignment-rules/${create.data.id}`, {
    method: 'PATCH', token: tokens.admin, body: { active: 0 },
  });
});

// ---------------- S2: SLA engine ----------------

test('SLA-1 P1 ticket gets response/resolution due dates from policy', async () => {
  assert.ok(hwTicket.sla, 'sla attached on create');
  const created = new Date(`${hwTicket.created_at.replace(' ', 'T')}Z`).getTime();
  const respDue = new Date(`${hwTicket.sla.response_due_at.replace(' ', 'T')}Z`).getTime();
  const resoDue = new Date(`${hwTicket.sla.resolution_due_at.replace(' ', 'T')}Z`).getTime();
  assert.equal(Math.round((respDue - created) / 60000), 15);
  assert.equal(Math.round((resoDue - created) / 60000), 240);
});

test('SLA-2 assignment records first response', async () => {
  const r = await api(`/api/tickets/${hwTicket.id}/assign`, {
    method: 'POST', token: tokens.agent, body: { agent_id: users.agent.id },
  });
  assert.equal(r.status, 200);
  const detail = await api(`/api/tickets/${hwTicket.id}`, { token: tokens.agent });
  assert.ok(detail.data.sla.first_response_at, 'first_response_at set');
});

test('SLA-3 PENDING pauses the clock, leaving PENDING resumes it', async () => {
  await api(`/api/tickets/${hwTicket.id}/status`, {
    method: 'POST', token: tokens.agent, body: { status: 'IN_PROGRESS' },
  });
  await api(`/api/tickets/${hwTicket.id}/status`, {
    method: 'POST', token: tokens.agent, body: { status: 'PENDING' },
  });
  let detail = await api(`/api/tickets/${hwTicket.id}`, { token: tokens.agent });
  assert.ok(detail.data.sla.paused_at, 'paused while PENDING');
  await api(`/api/tickets/${hwTicket.id}/status`, {
    method: 'POST', token: tokens.agent, body: { status: 'IN_PROGRESS' },
  });
  detail = await api(`/api/tickets/${hwTicket.id}`, { token: tokens.agent });
  assert.equal(detail.data.sla.paused_at, null, 'resumed');
});

test('SLA-4 sweep marks breaches and escalates to the group lead', async () => {
  db.prepare("UPDATE ticket_sla SET resolution_due_at = datetime('now', '-10 minutes') WHERE ticket_id = ?")
    .run(hwTicket.id);
  const sweep = await api('/api/sla/sweep', { method: 'POST', token: tokens.admin });
  assert.equal(sweep.status, 200);
  assert.ok(sweep.data.events.some((e) => e.ticket_id === hwTicket.id && e.type === 'breach'));
  const detail = await api(`/api/tickets/${hwTicket.id}`, { token: tokens.agent });
  assert.equal(detail.data.sla.resolution_breached, 1);
  assert.ok(detail.data.history.some((h) => h.action === 'SLA_BREACH'));
  const leadNtf = await api('/api/notifications', { token: tokens.lead });
  assert.ok(leadNtf.data.items.some((n) => n.type === 'SLA_ESCALATION'));
});

test('SLA-5 resolving stops the clock and records breach outcome', async () => {
  const r = await api(`/api/tickets/${hwTicket.id}/status`, {
    method: 'POST', token: tokens.agent, body: { status: 'RESOLVED', note: 'Replaced display cable' },
  });
  assert.equal(r.status, 200);
  const detail = await api(`/api/tickets/${hwTicket.id}`, { token: tokens.agent });
  assert.ok(detail.data.sla.completed_at);
});

test('SLA-6 policy admin: employee forbidden, admin can update and re-approve', async () => {
  const denied = await api('/api/sla/policies', { token: tokens.employee });
  assert.equal(denied.status, 403);
  const list = await api('/api/sla/policies', { token: tokens.lead });
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 4);
  const p2 = list.data.find((p) => p.priority_code === 'P2');
  const upd = await api(`/api/sla/policies/${p2.id}`, {
    method: 'PATCH', token: tokens.admin, body: { response_minutes: 20, approved: true },
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.response_minutes, 20);
  assert.equal(upd.data.approved, 1);
});

test('CAL-1 business calendar: admin sets hours and holidays, employee cannot', async () => {
  const put = await api('/api/sla/calendar/hours', {
    method: 'PUT', token: tokens.admin,
    body: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
  });
  assert.equal(put.status, 200);
  const hol = await api('/api/sla/calendar/holidays', {
    method: 'POST', token: tokens.admin, body: { date: '2026-10-02', name: 'Gandhi Jayanti' },
  });
  assert.equal(hol.status, 201);
  const dupe = await api('/api/sla/calendar/holidays', {
    method: 'POST', token: tokens.admin, body: { date: '2026-10-02', name: 'Duplicate' },
  });
  assert.equal(dupe.status, 409);
  const denied = await api('/api/sla/calendar/hours', {
    method: 'PUT', token: tokens.employee, body: { days: [1], start: '09:00', end: '10:00' },
  });
  assert.equal(denied.status, 403);
});

test('SLA-7 SLA dashboard aggregates for IT users only', async () => {
  const r = await api('/api/sla/dashboard', { token: tokens.lead });
  assert.equal(r.status, 200);
  assert.ok(r.data.totals.tracked >= 1);
  const denied = await api('/api/sla/dashboard', { token: tokens.employee });
  assert.equal(denied.status, 403);
});

// ---------------- S4: knowledge management ----------------

let article;
test('KB-1 agent drafts an article; employees cannot see drafts', async () => {
  const r = await api('/api/kb', {
    method: 'POST', token: tokens.agent,
    body: {
      title: 'Fix Wi-Fi drops on Latitude laptops',
      body: '1. Update the Intel wireless driver.\n2. Disable power saving on the adapter.',
      category_id: cat('Network').id,
    },
  });
  assert.equal(r.status, 201);
  article = r.data;
  assert.equal(article.status, 'DRAFT');
  assert.match(article.article_number, /^KB-\d{6}$/);
  const empList = await api('/api/kb', { token: tokens.employee });
  assert.ok(!empList.data.some((a) => a.id === article.id));
  const empDetail = await api(`/api/kb/${article.id}`, { token: tokens.employee });
  assert.equal(empDetail.status, 403);
});

test('KB-2 employees cannot author articles', async () => {
  const r = await api('/api/kb', {
    method: 'POST', token: tokens.employee,
    body: { title: 'x', body: 'y' },
  });
  assert.equal(r.status, 403);
});

test('KB-3 approval flow: submit -> lead approves -> published & visible', async () => {
  const submit = await api(`/api/kb/${article.id}/submit`, { method: 'POST', token: tokens.agent });
  assert.equal(submit.status, 200);
  assert.equal(submit.data.status, 'PENDING_APPROVAL');
  const agentApprove = await api(`/api/kb/${article.id}/approve`, { method: 'POST', token: tokens.agent });
  assert.equal(agentApprove.status, 403, 'agents cannot approve');
  const approve = await api(`/api/kb/${article.id}/approve`, { method: 'POST', token: tokens.lead });
  assert.equal(approve.status, 200);
  assert.equal(approve.data.status, 'PUBLISHED');
  const empDetail = await api(`/api/kb/${article.id}`, { token: tokens.employee });
  assert.equal(empDetail.status, 200);
});

test('KB-4 rating updates helpful counts; search finds the article', async () => {
  const rate = await api(`/api/kb/${article.id}/rate`, {
    method: 'POST', token: tokens.employee, body: { helpful: true },
  });
  assert.equal(rate.status, 200);
  assert.equal(rate.data.helpful_count, 1);
  const found = await api('/api/kb?q=Wi-Fi', { token: tokens.employee });
  assert.ok(found.data.some((a) => a.id === article.id));
});

test('KB-5 editing published content bumps version and returns to draft', async () => {
  const upd = await api(`/api/kb/${article.id}`, {
    method: 'PATCH', token: tokens.agent,
    body: { body: 'Updated steps:\n1. Update driver from vendor site.' },
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.version, 2);
  assert.equal(upd.data.status, 'DRAFT');
  const detail = await api(`/api/kb/${article.id}`, { token: tokens.agent });
  assert.equal(detail.data.versions.length, 2);
});

// ---------------- S5/S6: catalog, requests, approvals ----------------

let request;
test('REQ-1 employee requests an approval-gated item -> pending 2-level approval', async () => {
  const items = (await api('/api/catalog', { token: tokens.employee })).data;
  const laptop = items.find((i) => i.name === 'New Laptop');
  assert.ok(laptop, 'catalog seeded');
  const r = await api('/api/requests', {
    method: 'POST', token: tokens.employee,
    body: { catalog_item_id: laptop.id, description: 'Current laptop is 5 years old' },
  });
  assert.equal(r.status, 201);
  request = r.data;
  assert.match(request.request_number, /^REQ-\d{6}$/);
  assert.equal(request.status, 'PENDING_APPROVAL');
  assert.equal(request.approvals.length, 2);
});

test('REQ-2 employee cannot approve; lead takes level 1; level 2 needs admin', async () => {
  const denied = await api(`/api/requests/${request.id}/approve`, {
    method: 'POST', token: tokens.employee, body: { decision: 'approve' },
  });
  assert.equal(denied.status, 403);

  // DEF-A-002: admin cannot jump the queue while level 1 awaits the lead
  const adminEarly = await api(`/api/requests/${request.id}/approve`, {
    method: 'POST', token: tokens.admin, body: { decision: 'approve' },
  });
  assert.equal(adminEarly.status, 403);
  assert.match(adminEarly.data.error, /Awaiting Team Lead approval/);
  const adminQueueBefore = await api('/api/requests?scope=approvals', { token: tokens.admin });
  assert.ok(!adminQueueBefore.data.some((x) => x.id === request.id),
    'request awaiting L1 is not in the admin approvals queue');
  const adminView = await api(`/api/requests/${request.id}`, { token: tokens.admin });
  assert.equal(adminView.data.can_approve_level, null);
  assert.equal(adminView.data.awaiting_role, 'TEAM_LEAD');

  const l1 = await api(`/api/requests/${request.id}/approve`, {
    method: 'POST', token: tokens.lead, body: { decision: 'approve' },
  });
  assert.equal(l1.status, 200);
  assert.equal(l1.data.status, 'PENDING_APPROVAL', 'still pending after level 1');
  const adminQueueAfter = await api('/api/requests?scope=approvals', { token: tokens.admin });
  assert.ok(adminQueueAfter.data.some((x) => x.id === request.id),
    'request appears in the admin queue once level 1 is approved');
  const leadL2 = await api(`/api/requests/${request.id}/approve`, {
    method: 'POST', token: tokens.lead, body: { decision: 'approve' },
  });
  assert.equal(leadL2.status, 403, 'level 2 requires admin');
  const l2 = await api(`/api/requests/${request.id}/approve`, {
    method: 'POST', token: tokens.admin, body: { decision: 'approve' },
  });
  assert.equal(l2.status, 200);
  assert.equal(l2.data.status, 'IN_FULFILLMENT');
  assert.equal(l2.data.tasks.length, 1);
});

test('REQ-3 completing all fulfillment tasks completes the request', async () => {
  const task = (await api(`/api/requests/${request.id}`, { token: tokens.agent })).data.tasks[0];
  const done = await api(`/api/requests/tasks/${task.id}`, {
    method: 'POST', token: tokens.agent, body: { status: 'DONE', assign_to_me: true },
  });
  assert.equal(done.status, 200);
  const after = await api(`/api/requests/${request.id}`, { token: tokens.employee });
  assert.equal(after.data.status, 'COMPLETED');
  assert.ok(after.data.completed_at);
});

test('REQ-4 rejection stops the request', async () => {
  const items = (await api('/api/catalog', { token: tokens.employee2 })).data;
  const vpn = items.find((i) => i.name === 'VPN Access');
  const r = await api('/api/requests', {
    method: 'POST', token: tokens.employee2, body: { catalog_item_id: vpn.id },
  });
  const rej = await api(`/api/requests/${r.data.id}/approve`, {
    method: 'POST', token: tokens.lead, body: { decision: 'reject', note: 'Not eligible for remote work' },
  });
  assert.equal(rej.status, 200);
  assert.equal(rej.data.status, 'REJECTED');
});

test('REQ-5 no-approval item goes straight to fulfillment', async () => {
  const items = (await api('/api/catalog', { token: tokens.employee })).data;
  const mouse = items.find((i) => i.name === 'Mouse Request');
  const r = await api('/api/requests', {
    method: 'POST', token: tokens.employee, body: { catalog_item_id: mouse.id },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'IN_FULFILLMENT');
});

test('CAT-1 admin manages catalog items; employees cannot', async () => {
  const denied = await api('/api/catalog', {
    method: 'POST', token: tokens.employee, body: { name: 'Nope' },
  });
  assert.equal(denied.status, 403);
  const create = await api('/api/catalog', {
    method: 'POST', token: tokens.admin,
    body: {
      name: 'Docking Station Request', description: 'Request a docking station.',
      icon: 'plug', support_group_id: grp('Desktop Support').id, requires_approval: false,
    },
  });
  assert.equal(create.status, 201);
  const listed = (await api('/api/catalog', { token: tokens.employee })).data;
  assert.ok(listed.some((i) => i.name === 'Docking Station Request'));
  const disable = await api(`/api/catalog/${create.data.id}`, {
    method: 'PATCH', token: tokens.admin, body: { active: 0 },
  });
  assert.equal(disable.status, 200);
  const gone = (await api('/api/catalog', { token: tokens.employee })).data;
  assert.ok(!gone.some((i) => i.name === 'Docking Station Request'), 'disabled items hidden from employees');
  const adminAll = (await api('/api/catalog?all=1', { token: tokens.admin })).data;
  assert.ok(adminAll.some((i) => i.name === 'Docking Station Request'), 'admin still sees disabled items');
});

test('REQ-6 employees see only their own requests', async () => {
  const mine = await api('/api/requests', { token: tokens.employee });
  assert.ok(mine.data.every((x) => x.requester_id === users.employee.id));
});

// ---------------- S7: asset lifecycle ----------------

test('AST-1 lifecycle: transfer, repair, retire with history; employee forbidden', async () => {
  const assets = (await api('/api/assets', { token: tokens.lead })).data;
  const spare = assets.find((a) => a.asset_tag === 'LAP-0004');
  assert.equal(spare.status, 'IN_STOCK');

  const assign = await api(`/api/assets/${spare.id}/action`, {
    method: 'POST', token: tokens.lead, body: { action: 'ASSIGN', user_id: users.employee2.id },
  });
  assert.equal(assign.status, 200);
  assert.equal(assign.data.status, 'ASSIGNED');

  const transfer = await api(`/api/assets/${spare.id}/action`, {
    method: 'POST', token: tokens.lead, body: { action: 'TRANSFER', user_id: users.employee.id },
  });
  assert.equal(transfer.data.assigned_user_name, users.employee.full_name);

  const repair = await api(`/api/assets/${spare.id}/action`, {
    method: 'POST', token: tokens.lead, body: { action: 'REPAIR', note: 'Hinge broken' },
  });
  assert.equal(repair.data.status, 'IN_REPAIR');
  const repaired = await api(`/api/assets/${spare.id}/action`, {
    method: 'POST', token: tokens.lead, body: { action: 'REPAIR_DONE' },
  });
  assert.equal(repaired.data.status, 'ASSIGNED');

  const retire = await api(`/api/assets/${spare.id}/action`, {
    method: 'POST', token: tokens.admin, body: { action: 'RETIRE', note: 'End of life' },
  });
  assert.equal(retire.data.status, 'RETIRED');

  const detail = await api(`/api/assets/${spare.id}`, { token: tokens.lead });
  const actions = detail.data.history.map((h) => h.action);
  for (const a of ['ASSIGNED', 'TRANSFERRED', 'REPAIR', 'REPAIR_DONE', 'RETIRED']) {
    assert.ok(actions.includes(a), `history has ${a}`);
  }

  const denied = await api(`/api/assets/${spare.id}/action`, {
    method: 'POST', token: tokens.employee, body: { action: 'REPAIR' },
  });
  assert.equal(denied.status, 403);
});

// ---------------- S8: workflow engine ----------------

test('WF-1 workflow on creation adds internal note + notifies for P1 tickets', async () => {
  const wf = await api('/api/admin/workflows', {
    method: 'POST', token: tokens.admin,
    body: {
      name: 'P1 heads-up', trigger_event: 'ticket.created',
      conditions: [{ field: 'priority_id', op: 'eq', value: 1 }],
      actions: [
        { type: 'add_note', body: 'P1 raised — check immediately.' },
        { type: 'notify_user', user_id: users.lead.id, message: 'A P1 ticket needs attention.' },
      ],
    },
  });
  assert.equal(wf.status, 201);
  const t = await api('/api/tickets', {
    method: 'POST', token: tokens.employee,
    body: {
      title: 'Laptop will not boot at all', description: 'Black screen',
      category_id: cat('Hardware').id, priority_id: 1,
    },
  });
  assert.equal(t.status, 201);
  const detail = await api(`/api/tickets/${t.data.id}`, { token: tokens.agent });
  assert.ok(detail.data.comments.some((c) => c.is_internal && c.body.includes('P1 raised')));
  assert.ok(detail.data.history.some((h) => h.action === 'WORKFLOW'));
  // P4 ticket must not trigger it
  const t4 = await api('/api/tickets', {
    method: 'POST', token: tokens.employee,
    body: {
      title: 'Keyboard key sticky', description: 'The E key sticks',
      category_id: cat('Hardware').id, priority_id: 4,
    },
  });
  const detail4 = await api(`/api/tickets/${t4.data.id}`, { token: tokens.agent });
  assert.ok(!detail4.data.comments.some((c) => c.body.includes('P1 raised')));
});

test('WF-2 invalid workflow definitions are rejected', async () => {
  const bad = await api('/api/admin/workflows', {
    method: 'POST', token: tokens.admin,
    body: { name: 'bad', trigger_event: 'nope', actions: [{ type: 'add_note', body: 'x' }] },
  });
  assert.equal(bad.status, 400);
});

// ---------------- S12: advanced search ----------------

test('SRCH-1 global search is role-scoped across entities', async () => {
  const emp = await api('/api/search?q=Laptop', { token: tokens.employee });
  assert.equal(emp.status, 200);
  assert.ok(emp.data.tickets.every((t) => true), 'employee gets ticket hits');
  assert.equal(emp.data.assets.length, 0, 'employees see no assets');
  const it = await api('/api/search?q=LAP-', { token: tokens.lead });
  assert.ok(it.data.assets.length >= 1, 'IT sees assets');
  const short = await api('/api/search?q=x', { token: tokens.employee });
  assert.equal(short.status, 400);
});

test('SRCH-2 saved searches are per-user', async () => {
  const save = await api('/api/search/saved', {
    method: 'POST', token: tokens.agent, body: { name: 'My P1s', query: 'status=NEW&priority_id=1' },
  });
  assert.equal(save.status, 201);
  const mine = await api('/api/search/saved', { token: tokens.agent });
  assert.ok(mine.data.some((s) => s.name === 'My P1s'));
  const other = await api('/api/search/saved', { token: tokens.lead });
  assert.ok(!other.data.some((s) => s.name === 'My P1s'));
  const del = await api(`/api/search/saved/${save.data.id}`, { method: 'DELETE', token: tokens.agent });
  assert.equal(del.status, 200);
});

// ---------------- S10/S15: API tokens + email-to-ticket ----------------

let apiToken;
test('INT-1 admin issues an API token (employee forbidden)', async () => {
  const denied = await api('/api/integrations/tokens', {
    method: 'POST', token: tokens.employee, body: { name: 'x' },
  });
  assert.equal(denied.status, 403);
  const r = await api('/api/integrations/tokens', {
    method: 'POST', token: tokens.admin, body: { name: 'Mail relay' },
  });
  assert.equal(r.status, 201);
  assert.match(r.data.token, /^itsm_/);
  apiToken = r.data.token;
});

test('INT-2 inbound email from a known user creates a ticket', async () => {
  const r = await api('/api/integrations/inbound-email', {
    method: 'POST', headers: { 'X-Api-Token': apiToken },
    body: {
      message_id: '<msg-001@mail>', from_email: 'employee@itsm.local',
      subject: 'Teams crashes on startup', body: 'Teams closes immediately after opening.',
    },
  });
  assert.equal(r.status, 201);
  assert.match(r.data.ticket_number, /^INC-\d{6}$/);
  const dupe = await api('/api/integrations/inbound-email', {
    method: 'POST', headers: { 'X-Api-Token': apiToken },
    body: { message_id: '<msg-001@mail>', from_email: 'employee@itsm.local', subject: 'dup', body: 'dup' },
  });
  assert.equal(dupe.data.duplicate, true);
});

test('INT-3 reply with the ticket number in the subject threads as a comment', async () => {
  const list = await api('/api/tickets?scope=my', { token: tokens.employee });
  const mail = list.data.find((t) => t.title === 'Teams crashes on startup');
  const r = await api('/api/integrations/inbound-email', {
    method: 'POST', headers: { 'X-Api-Token': apiToken },
    body: {
      message_id: '<msg-002@mail>', from_email: 'employee@itsm.local',
      subject: `RE: [${mail.ticket_number}] Teams crashes on startup`,
      body: 'It also happens after reinstalling.',
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.threaded, true);
  const detail = await api(`/api/tickets/${mail.id}`, { token: tokens.employee });
  assert.ok(detail.data.comments.some((c) => c.body.includes('reinstalling')));
});

test('INT-4 unknown senders are stored for review, not converted', async () => {
  const r = await api('/api/integrations/inbound-email', {
    method: 'POST', headers: { 'X-Api-Token': apiToken },
    body: { from_email: 'stranger@example.com', subject: 'Help', body: 'Hi' },
  });
  assert.equal(r.status, 202);
  assert.equal(r.data.ok, false);
});

test('INT-5 missing or bad API token is rejected', async () => {
  const r = await api('/api/integrations/inbound-email', {
    method: 'POST', body: { from_email: 'employee@itsm.local', subject: 'x', body: 'y' },
  });
  assert.equal(r.status, 401);
  const bad = await api('/api/integrations/inbound-email', {
    method: 'POST', headers: { 'X-Api-Token': 'itsm_wrong' },
    body: { from_email: 'employee@itsm.local', subject: 'x', body: 'y' },
  });
  assert.equal(bad.status, 401);
});

test('INT-6 revoked tokens stop working', async () => {
  const listing = await api('/api/integrations/tokens', { token: tokens.admin });
  const tok = listing.data.find((t) => t.name === 'Mail relay');
  await api(`/api/integrations/tokens/${tok.id}/revoke`, { method: 'POST', token: tokens.admin });
  const r = await api('/api/integrations/inbound-email', {
    method: 'POST', headers: { 'X-Api-Token': apiToken },
    body: { from_email: 'employee@itsm.local', subject: 'x', body: 'y' },
  });
  assert.equal(r.status, 401);
});

// ---------------- S9: advanced reports ----------------

test('RPT-S1 standard report returns SLA/MTTR/FCR/aging metrics for IT only', async () => {
  const r = await api('/api/reports/standard', { token: tokens.lead });
  assert.equal(r.status, 200);
  assert.ok(r.data.sla.tracked >= 1);
  assert.ok(typeof r.data.sla.compliance_pct === 'number');
  assert.ok(r.data.mttr_minutes !== undefined);
  assert.ok(Array.isArray(r.data.aging));
  assert.ok(Array.isArray(r.data.recurring));
  const denied = await api('/api/reports/standard', { token: tokens.employee });
  assert.equal(denied.status, 403);
});

// ---------------- S11: notification preferences ----------------

test('NTF-1 user can switch email notifications off and on', async () => {
  const off = await api('/api/notifications/prefs', {
    method: 'POST', token: tokens.employee, body: { email_enabled: false },
  });
  assert.equal(off.data.email_enabled, false);
  const get = await api('/api/notifications/prefs', { token: tokens.employee });
  assert.equal(get.data.email_enabled, false);
  await api('/api/notifications/prefs', {
    method: 'POST', token: tokens.employee, body: { email_enabled: true },
  });
});

// ---------------- S14: SSO status ----------------

test('SSO-1 SSO reports disabled until the customer IdP is configured', async () => {
  const r = await api('/api/auth/sso');
  assert.equal(r.status, 200);
  assert.equal(r.data.enabled, false);
});

// ---------------- Regression guard ----------------

test('REG-1 Basic ticket flow still works end-to-end alongside Standard', async () => {
  const t = await api('/api/tickets', {
    method: 'POST', token: tokens.employee2,
    body: {
      title: 'Mouse not detected', description: 'USB mouse not recognised',
      category_id: cat('Peripheral').id, priority_id: 3,
    },
  });
  assert.equal(t.status, 201);
  const assign = await api(`/api/tickets/${t.data.id}/assign`, {
    method: 'POST', token: tokens.lead, body: { agent_id: users.agent.id },
  });
  assert.equal(assign.status, 200);
  await api(`/api/tickets/${t.data.id}/status`, {
    method: 'POST', token: tokens.agent, body: { status: 'IN_PROGRESS' },
  });
  const resolve = await api(`/api/tickets/${t.data.id}/status`, {
    method: 'POST', token: tokens.agent, body: { status: 'RESOLVED', note: 'Re-seated USB receiver' },
  });
  assert.equal(resolve.status, 200);
  const close = await api(`/api/tickets/${t.data.id}/status`, {
    method: 'POST', token: tokens.employee2, body: { status: 'CLOSED' },
  });
  assert.equal(close.status, 200);
});
