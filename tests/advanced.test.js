// Advanced-phase automated test suite (BRD section 8, milestone A12).
// Run: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
const TEST_DB = path.join(__dirname, 'test-advanced.db');
for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
process.env.ITSM_DB_PATH = TEST_DB;
const BACKUP_DIR = path.join(__dirname, 'test-backups');
process.env.BACKUP_DIR = BACKUP_DIR;
fs.rmSync(BACKUP_DIR, { recursive: true, force: true });

const { seed, seedStandard, seedAdvanced } = require('../src/seed');
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

async function makeTicket(token, body) {
  const r = await api('/api/tickets', { method: 'POST', token, body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

before(async () => {
  seed();
  seedStandard();
  seedAdvanced();
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

// ---------------- Phase ----------------

test('ADV-0 health endpoint reports ADVANCED phase', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal((await res.json()).phase, 'ADVANCED');
});

// ---------------- A1: CMDB ----------------

let serviceCi;
test('CMDB-1 laptop CIs are auto-created from the asset repository', async () => {
  const r = await api('/api/cmdb?type=LAPTOP', { token: tokens.agent });
  assert.equal(r.status, 200);
  assert.ok(r.data.length >= 4, 'one CI per seeded laptop');
  assert.ok(r.data.every((c) => /^CI-\d{6}$/.test(c.ci_number)));
  assert.ok(r.data.some((c) => c.asset_tag === 'LAP-0001'));
  const denied = await api('/api/cmdb', { token: tokens.employee });
  assert.equal(denied.status, 403, 'employees have no CMDB access');
});

test('CMDB-2 CI creation, relationships and impact view', async () => {
  const create = await api('/api/cmdb', {
    method: 'POST', token: tokens.lead,
    body: { name: 'HR Portal', ci_type: 'APPLICATION', description: 'Internal HR app' },
  });
  assert.equal(create.status, 201);
  serviceCi = create.data;

  const agentDenied = await api('/api/cmdb', {
    method: 'POST', token: tokens.agent, body: { name: 'x', ci_type: 'SERVER' },
  });
  assert.equal(agentDenied.status, 403, 'agents cannot create CIs');

  const laptops = (await api('/api/cmdb?type=LAPTOP', { token: tokens.lead })).data;
  const rel = await api(`/api/cmdb/${serviceCi.id}/relationships`, {
    method: 'POST', token: tokens.lead,
    body: { child_id: laptops[0].id, relation_type: 'USED_BY' },
  });
  assert.equal(rel.status, 201);

  const detail = await api(`/api/cmdb/${serviceCi.id}`, { token: tokens.agent });
  assert.equal(detail.status, 200);
  assert.ok(detail.data.downstream.some((d) => d.id === laptops[0].id));
  const laptopDetail = await api(`/api/cmdb/${laptops[0].id}`, { token: tokens.agent });
  assert.ok(laptopDetail.data.upstream.some((u) => u.id === serviceCi.id));
});

// ---------------- A2: Problem Management ----------------

let problem;
test('PRB-1 problem creation with linked incidents', async () => {
  const t1 = await makeTicket(tokens.employee, {
    title: 'Wi-Fi drops every hour', description: 'Recurring wifi disconnects',
    category_id: cat('Network').id, priority_id: 3,
  });
  const t2 = await makeTicket(tokens.employee2, {
    title: 'Wi-Fi disconnecting in meetings', description: 'Same wifi problem',
    category_id: cat('Network').id, priority_id: 3,
  });
  const r = await api('/api/problems', {
    method: 'POST', token: tokens.lead,
    body: {
      title: 'Recurring Wi-Fi drops on Latitude fleet',
      description: 'Multiple laptops disconnect from corporate Wi-Fi.',
      category_id: cat('Network').id, ticket_ids: [t1.id, t2.id],
    },
  });
  assert.equal(r.status, 201);
  problem = r.data;
  assert.match(problem.problem_number, /^PRB-\d{6}$/);
  assert.equal(problem.tickets.length, 2);
  const denied = await api('/api/problems', { token: tokens.employee });
  assert.equal(denied.status, 403);
});

test('PRB-2 RCA flow enforces root cause and permanent fix', async () => {
  const noRca = await api(`/api/problems/${problem.id}/status`, {
    method: 'POST', token: tokens.lead, body: { status: 'ROOT_CAUSE_ANALYSIS' },
  });
  assert.equal(noRca.status, 200);
  const kePremature = await api(`/api/problems/${problem.id}/status`, {
    method: 'POST', token: tokens.lead, body: { status: 'KNOWN_ERROR' },
  });
  assert.equal(kePremature.status, 400, 'known error requires a root cause');
  const ke = await api(`/api/problems/${problem.id}/status`, {
    method: 'POST', token: tokens.lead,
    body: { status: 'KNOWN_ERROR', root_cause: 'Faulty wireless driver 22.180', workaround: 'Roll back to driver 22.150' },
  });
  assert.equal(ke.status, 200);
  const resolvePremature = await api(`/api/problems/${problem.id}/status`, {
    method: 'POST', token: tokens.lead, body: { status: 'RESOLVED' },
  });
  assert.equal(resolvePremature.status, 400, 'resolving requires a permanent fix');
  const resolved = await api(`/api/problems/${problem.id}/status`, {
    method: 'POST', token: tokens.lead,
    body: { status: 'RESOLVED', permanent_fix: 'Deploy driver 22.200 fleet-wide via update ring' },
  });
  assert.equal(resolved.status, 200);
  const closed = await api(`/api/problems/${problem.id}/status`, {
    method: 'POST', token: tokens.lead, body: { status: 'CLOSED' },
  });
  assert.equal(closed.status, 200);
  assert.ok(closed.data.closed_at);
});

test('PRB-3 problem tasks lifecycle', async () => {
  const p = await api('/api/problems', {
    method: 'POST', token: tokens.agent,
    body: { title: 'Battery drain cluster', description: 'Several battery complaints' },
  });
  const task = await api(`/api/problems/${p.data.id}/tasks`, {
    method: 'POST', token: tokens.agent, body: { title: 'Collect battery reports from affected laptops' },
  });
  assert.equal(task.status, 201);
  const done = await api(`/api/problems/tasks/${task.data.tasks[0].id}`, {
    method: 'POST', token: tokens.agent, body: { status: 'DONE' },
  });
  assert.equal(done.status, 200);
  assert.equal(done.data.tasks[0].status, 'DONE');
});

// ---------------- A3: Change Management ----------------

let change;
test('CHG-1 normal change needs plans, then two-level CAB approval', async () => {
  const r = await api('/api/changes', {
    method: 'POST', token: tokens.agent,
    body: {
      title: 'Deploy wireless driver 22.200', description: 'Fleet-wide driver update to fix Wi-Fi drops',
      change_type: 'NORMAL', risk: 'MEDIUM',
      planned_start: '2026-09-01 20:00:00', planned_end: '2026-09-01 22:00:00',
      ci_ids: serviceCi ? [serviceCi.id] : [],
    },
  });
  assert.equal(r.status, 201);
  change = r.data;
  assert.match(change.change_number, /^CHG-\d{6}$/);

  const noPlans = await api(`/api/changes/${change.id}/submit`, { method: 'POST', token: tokens.agent });
  assert.equal(noPlans.status, 400, 'submission requires implementation + backout plans');

  await api(`/api/changes/${change.id}`, {
    method: 'PATCH', token: tokens.agent,
    body: {
      implementation_plan: '1. Pilot ring 2. Broad ring 3. Verify',
      backout_plan: 'Redeploy driver 22.150 via rollback package',
    },
  });
  const submit = await api(`/api/changes/${change.id}/submit`, { method: 'POST', token: tokens.agent });
  assert.equal(submit.status, 200);
  assert.equal(submit.data.status, 'PENDING_APPROVAL');
  assert.equal(submit.data.approvals.length, 2);

  // DEF-A-002: admin cannot take the Team Lead step while it is pending
  const adminEarly = await api(`/api/changes/${change.id}/approve`, {
    method: 'POST', token: tokens.admin, body: { decision: 'approve' },
  });
  assert.equal(adminEarly.status, 403);
  assert.match(adminEarly.data.error, /Awaiting Team Lead approval/);

  const l1 = await api(`/api/changes/${change.id}/approve`, {
    method: 'POST', token: tokens.lead, body: { decision: 'approve' },
  });
  assert.equal(l1.data.status, 'PENDING_APPROVAL');
  const leadL2 = await api(`/api/changes/${change.id}/approve`, {
    method: 'POST', token: tokens.lead, body: { decision: 'approve' },
  });
  assert.equal(leadL2.status, 403, 'level 2 needs an administrator');
  const l2 = await api(`/api/changes/${change.id}/approve`, {
    method: 'POST', token: tokens.admin, body: { decision: 'approve' },
  });
  assert.equal(l2.data.status, 'APPROVED');
});

test('CHG-2 lifecycle to completion with mandatory PIR content', async () => {
  await api(`/api/changes/${change.id}/status`, { method: 'POST', token: tokens.lead, body: { status: 'SCHEDULED' } });
  await api(`/api/changes/${change.id}/status`, { method: 'POST', token: tokens.lead, body: { status: 'IN_PROGRESS' } });
  const done = await api(`/api/changes/${change.id}/status`, {
    method: 'POST', token: tokens.lead, body: { status: 'COMPLETED' },
  });
  assert.equal(done.data.status, 'COMPLETED');
  const badPir = await api(`/api/changes/${change.id}/pir`, {
    method: 'POST', token: tokens.lead, body: { outcome: 'SUCCESSFUL' },
  });
  assert.equal(badPir.status, 400, 'PIR notes required');
  const pir = await api(`/api/changes/${change.id}/pir`, {
    method: 'POST', token: tokens.lead,
    body: { outcome: 'SUCCESSFUL', notes: 'Deployed cleanly; no rollbacks; incident volume dropped.' },
  });
  assert.equal(pir.status, 200);
  assert.equal(pir.data.pir_outcome, 'SUCCESSFUL');
});

test('CHG-3 standard changes auto-approve; emergency changes need admin only', async () => {
  const std = await api('/api/changes', {
    method: 'POST', token: tokens.lead,
    body: {
      title: 'Monthly patch cycle', description: 'Routine pre-approved patching',
      change_type: 'STANDARD',
      implementation_plan: 'Standard patch runbook', backout_plan: 'Uninstall KB',
    },
  });
  const stdSubmit = await api(`/api/changes/${std.data.id}/submit`, { method: 'POST', token: tokens.lead });
  assert.equal(stdSubmit.data.status, 'APPROVED', 'standard changes are pre-approved');

  const emg = await api('/api/changes', {
    method: 'POST', token: tokens.lead,
    body: {
      title: 'Emergency firewall rule', description: 'Block active exploit',
      change_type: 'EMERGENCY', risk: 'HIGH',
      implementation_plan: 'Apply rule', backout_plan: 'Remove rule',
    },
  });
  const emgSubmit = await api(`/api/changes/${emg.data.id}/submit`, { method: 'POST', token: tokens.lead });
  assert.equal(emgSubmit.data.approvals.length, 1);
  assert.equal(emgSubmit.data.approvals[0].approver_role, 'ADMIN');
});

test('CHG-4 change calendar lists scheduled work in the window', async () => {
  const r = await api('/api/changes/calendar?from=2026-08-22&days=30', { token: tokens.agent });
  assert.equal(r.status, 200);
  assert.ok(r.data.some((c) => c.id === change.id));
});

// ---------------- A4: Major Incident Management ----------------

let majorTicket;
test('MI-1 declare major incident: P1 escalation, commander, leadership notified', async () => {
  majorTicket = await makeTicket(tokens.employee, {
    title: 'Office Wi-Fi completely down', description: 'Nobody in Noida HQ can connect',
    category_id: cat('Network').id, priority_id: 3,
  });
  const agentDenied = await api(`/api/major/${majorTicket.id}/declare`, {
    method: 'POST', token: tokens.agent, body: {},
  });
  assert.equal(agentDenied.status, 403, 'agents cannot declare major incidents');

  const r = await api(`/api/major/${majorTicket.id}/declare`, {
    method: 'POST', token: tokens.lead,
    body: { commander_id: users.lead.id, bridge: 'https://meet.example.com/mi-bridge' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.is_major, 1);
  assert.equal(r.data.priority_code, 'P1', 'priority escalated');
  assert.equal(r.data.commander_name, users.lead.full_name);

  const adminNtf = await api('/api/notifications', { token: tokens.admin });
  assert.ok(adminNtf.data.items.some((n) => n.type === 'MAJOR_INCIDENT'));
});

test('MI-2 stakeholder updates, incident linking and post-incident review', async () => {
  const upd = await api(`/api/major/${majorTicket.id}/update`, {
    method: 'POST', token: tokens.agent,
    body: { message: 'Network team engaged; core switch suspected.' },
  });
  assert.equal(upd.status, 201);
  assert.equal(upd.data.updates.length, 1);

  const other = await makeTicket(tokens.employee2, {
    title: 'Cannot reach internet from desk', description: 'Related to the outage',
    category_id: cat('Network').id, priority_id: 3,
  });
  const link = await api(`/api/major/${majorTicket.id}/link`, {
    method: 'POST', token: tokens.agent, body: { ticket_id: other.id },
  });
  assert.equal(link.status, 201);
  assert.ok(link.data.linked.some((l) => l.id === other.id));

  const review = await api(`/api/major/${majorTicket.id}/review`, {
    method: 'POST', token: tokens.lead,
    body: { message: 'Root cause: switch firmware. Replaced. Monitoring added.' },
  });
  assert.equal(review.status, 201);
  assert.ok(review.data.updates.some((u) => u.update_type === 'REVIEW'));

  const list = await api('/api/major', { token: tokens.agent });
  assert.ok(list.data.some((m) => m.id === majorTicket.id));
});

// ---------------- A5: AI capabilities (builtin engine) ----------------

test('AI-1 classification matches the BRD 8.8 example (battery draining)', async () => {
  const r = await api('/api/ai/classify', {
    method: 'POST', token: tokens.employee,
    body: { title: 'My laptop battery is draining within one hour', description: 'Battery dies fast' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.category?.name, 'Hardware');
  assert.equal(r.data.subcategory?.name, 'Battery');
  assert.equal(r.data.assignment_group?.name, 'Desktop Support');
});

test('AI-2 resolution recommendation surfaces knowledge and history', async () => {
  const art = await api('/api/kb', {
    method: 'POST', token: tokens.agent,
    body: {
      title: 'Fix laptop battery drain',
      body: 'Check battery health, close background processes, check power configuration, update BIOS.',
      category_id: cat('Hardware').id,
    },
  });
  await api(`/api/kb/${art.data.id}/submit`, { method: 'POST', token: tokens.agent });
  await api(`/api/kb/${art.data.id}/approve`, { method: 'POST', token: tokens.lead });

  const r = await api('/api/ai/recommend', {
    method: 'POST', token: tokens.agent,
    body: { text: 'battery draining very fast on laptop' },
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.articles.some((a) => a.id === art.data.id), 'finds the KB article');
  assert.ok(Array.isArray(r.data.suggested_steps) && r.data.suggested_steps.length > 0);
  const denied = await api('/api/ai/recommend', {
    method: 'POST', token: tokens.employee, body: { text: 'x y z' },
  });
  assert.equal(denied.status, 403);
});

test('AI-3 ticket summary for requester and IT; strangers denied', async () => {
  const r = await api(`/api/ai/summary/${majorTicket.id}`, { token: tokens.employee });
  assert.equal(r.status, 200);
  assert.ok(r.data.issue.includes('Office Wi-Fi completely down'));
  assert.ok(r.data.actions.length > 0);
  assert.equal(r.data.engine, 'builtin');
  const denied = await api(`/api/ai/summary/${majorTicket.id}`, { token: tokens.employee2 });
  assert.equal(denied.status, 403);
});

test('AI-4 chatbot troubleshoots and offers a ticket draft', async () => {
  const hello = await api('/api/ai/chat', {
    method: 'POST', token: tokens.employee, body: { messages: [{ role: 'user', text: 'hi' }] },
  });
  assert.match(hello.data.reply, /IT Support Assistant/);

  const slow = await api('/api/ai/chat', {
    method: 'POST', token: tokens.employee,
    body: { messages: [{ role: 'user', text: 'My laptop is very slow and keeps freezing' }] },
  });
  assert.equal(slow.status, 200);
  assert.match(slow.data.reply, /create an IT ticket/i);
  assert.ok(slow.data.ticket_draft.category_id, 'draft carries a category');
  assert.ok(slow.data.ticket_draft.title.length > 0);
});

test('AI-5 assignment recommendations are ranked with reasons', async () => {
  const r = await api(`/api/ai/assignment/${majorTicket.id}`, { token: tokens.lead });
  assert.equal(r.status, 200);
  assert.ok(r.data.recommendations.length >= 1);
  assert.ok(r.data.recommendations[0].reasons.length > 0);
  const denied = await api(`/api/ai/assignment/${majorTicket.id}`, { token: tokens.employee });
  assert.equal(denied.status, 403);
});

test('AI-6 AI status reports the builtin engine until a provider is approved', async () => {
  const r = await api('/api/ai/status', { token: tokens.employee });
  assert.equal(r.data.mode, 'builtin');
});

// ---------------- A7: Predictive SLA ----------------

test('PRED-1 breach probability and recommendations for an open ticket', async () => {
  const t = await makeTicket(tokens.employee, {
    title: 'Teams crashing on every call', description: 'Crash crash crash',
    category_id: cat('Software').id, priority_id: 2,
  });
  const r = await api(`/api/ai/sla-prediction/${t.id}`, { token: tokens.lead });
  assert.equal(r.status, 200);
  assert.ok(r.data.breach_probability >= 0 && r.data.breach_probability <= 100);

  // Push the due date close and re-check that risk rises
  db.prepare("UPDATE ticket_sla SET resolution_due_at = datetime('now', '+5 minutes'), warning_sent = 1 WHERE ticket_id = ?")
    .run(t.id);
  const hot = await api(`/api/ai/sla-prediction/${t.id}`, { token: tokens.lead });
  assert.ok(hot.data.breach_probability >= 60, `expected high risk, got ${hot.data.breach_probability}`);
  assert.ok(hot.data.recommendations.length > 0);

  const risk = await api('/api/analytics/sla-risk', { token: tokens.lead });
  assert.equal(risk.status, 200);
  assert.ok(risk.data.some((x) => x.id === t.id));
});

// ---------------- A8: analytics + satisfaction ----------------

test('RATE-1 requester rates a resolved ticket; others cannot', async () => {
  const t = await makeTicket(tokens.employee, {
    title: 'Mouse broken', description: 'left click dead',
    category_id: cat('Peripheral').id, priority_id: 4,
  });
  await api(`/api/tickets/${t.id}/assign`, { method: 'POST', token: tokens.lead, body: { agent_id: users.agent.id } });
  await api(`/api/tickets/${t.id}/status`, { method: 'POST', token: tokens.agent, body: { status: 'IN_PROGRESS' } });
  await api(`/api/tickets/${t.id}/status`, {
    method: 'POST', token: tokens.agent, body: { status: 'RESOLVED', note: 'Replaced mouse' },
  });
  const early = await api(`/api/tickets/${majorTicket.id}/rating`, {
    method: 'POST', token: tokens.employee, body: { score: 5 },
  });
  assert.equal(early.status, 400, 'cannot rate an unresolved ticket');
  const other = await api(`/api/tickets/${t.id}/rating`, {
    method: 'POST', token: tokens.employee2, body: { score: 5 },
  });
  assert.equal(other.status, 403, 'only the requester can rate');
  const ok = await api(`/api/tickets/${t.id}/rating`, {
    method: 'POST', token: tokens.employee, body: { score: 5, comment: 'Quick fix, thanks!' },
  });
  assert.equal(ok.status, 201);
  const detail = await api(`/api/tickets/${t.id}`, { token: tokens.employee });
  assert.equal(detail.data.rating.score, 5);
});

test('ANL-1 advanced analytics dashboard payload (IT only)', async () => {
  const r = await api('/api/analytics/advanced', { token: tokens.lead });
  assert.equal(r.status, 200);
  assert.equal(r.data.forecast.length, 7);
  assert.ok(Array.isArray(r.data.workload) && r.data.workload.length > 0);
  assert.ok(Array.isArray(r.data.teams));
  assert.ok(r.data.satisfaction.responses >= 1, 'CSAT includes the RATE-1 rating');
  assert.ok(Array.isArray(r.data.resolutionTrend));
  const denied = await api('/api/analytics/advanced', { token: tokens.employee });
  assert.equal(denied.status, 403);
});

// ---------------- A9: event/monitoring integration ----------------

test('EVT-1 monitoring events create incidents and dedupe repeats', async () => {
  const tok = await api('/api/integrations/tokens', {
    method: 'POST', token: tokens.admin, body: { name: 'Monitoring' },
  });
  const headers = { 'X-Api-Token': tok.data.token };

  const first = await api('/api/integrations/event', {
    method: 'POST', headers,
    body: {
      dedupe_key: 'disk-alert-noida-fs01', source: 'Zabbix', severity: 'high',
      subject: 'Disk usage above 90% on FS01', body: 'Volume D: at 93%',
    },
  });
  assert.equal(first.status, 201);
  assert.match(first.data.ticket_number, /^INC-\d{6}$/);

  const repeat = await api('/api/integrations/event', {
    method: 'POST', headers,
    body: {
      dedupe_key: 'disk-alert-noida-fs01', source: 'Zabbix', severity: 'high',
      subject: 'Disk usage above 90% on FS01', body: 'Volume D: at 95%',
    },
  });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.data.deduped, true);
  assert.equal(repeat.data.ticket_number, first.data.ticket_number);

  const noToken = await api('/api/integrations/event', {
    method: 'POST', body: { subject: 'x' },
  });
  assert.equal(noToken.status, 401);
});

// ---------------- A10: enterprise automation trigger ----------------

test('WFA-1 SLA breach fires ticket.sla_breach workflows', async () => {
  await api('/api/admin/workflows', {
    method: 'POST', token: tokens.admin,
    body: {
      name: 'Breach note', trigger_event: 'ticket.sla_breach',
      conditions: [],
      actions: [{ type: 'add_note', body: 'SLA breached — automation fired.' }],
    },
  });
  const t = await makeTicket(tokens.employee, {
    title: 'VPN completely broken', description: 'cannot connect at all',
    category_id: cat('Network').id, priority_id: 2,
  });
  db.prepare("UPDATE ticket_sla SET resolution_due_at = datetime('now', '-5 minutes') WHERE ticket_id = ?").run(t.id);
  await api('/api/sla/sweep', { method: 'POST', token: tokens.admin });
  const detail = await api(`/api/tickets/${t.id}`, { token: tokens.admin });
  assert.equal(detail.status, 200);
  assert.ok(detail.data.comments.some((c) => c.is_internal && c.body.includes('automation fired')),
    'breach workflow added the note');
});

// ---------------- BRD 6.14: automated backup ----------------

test('BKP-1 admin can run and list database backups; employees cannot', async () => {
  const denied = await api('/api/admin/backups', { method: 'POST', token: tokens.employee });
  assert.equal(denied.status, 403);
  const run = await api('/api/admin/backups', { method: 'POST', token: tokens.admin });
  assert.equal(run.status, 201, JSON.stringify(run.data));
  assert.match(run.data.file, /^itsm-.*\.db$/);
  assert.ok(run.data.size_bytes > 0);
  assert.ok(fs.existsSync(path.join(BACKUP_DIR, run.data.file)), 'backup file exists on disk');
  const list = await api('/api/admin/backups', { token: tokens.admin });
  assert.ok(list.data.some((b) => b.file === run.data.file));
});

// ---------------- S10 closeout: mailbox poller status ----------------

test('MBX-1 mailbox poller reports idle until customer credentials are set', async () => {
  const r = await api('/api/integrations/mailbox', { token: tokens.admin });
  assert.equal(r.status, 200);
  assert.equal(r.data.polling_enabled, false);
  const denied = await api('/api/integrations/mailbox', { token: tokens.employee });
  assert.equal(denied.status, 403);
});

// ---------------- Regression guard ----------------

test('REG-A1 core ticket flow still works with Advanced hooks active', async () => {
  const t = await makeTicket(tokens.employee2, {
    title: 'Keyboard layout wrong', description: 'Types wrong characters',
    category_id: cat('Hardware').id, priority_id: 4,
  });
  await api(`/api/tickets/${t.id}/assign`, { method: 'POST', token: tokens.lead, body: { agent_id: users.agent.id } });
  await api(`/api/tickets/${t.id}/status`, { method: 'POST', token: tokens.agent, body: { status: 'IN_PROGRESS' } });
  const resolve = await api(`/api/tickets/${t.id}/status`, {
    method: 'POST', token: tokens.agent, body: { status: 'RESOLVED', note: 'Fixed layout settings' },
  });
  assert.equal(resolve.status, 200);
  const close = await api(`/api/tickets/${t.id}/status`, {
    method: 'POST', token: tokens.employee2, body: { status: 'CLOSED' },
  });
  assert.equal(close.status, 200);
});
