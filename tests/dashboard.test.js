// KPI & analytics dashboard test suite (GET /api/analytics/dashboard).
// Run: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
const TEST_DB = path.join(__dirname, 'test-dashboard.db');
for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
process.env.ITSM_DB_PATH = TEST_DB;
process.env.BACKUP_DIR = path.join(__dirname, 'test-backups');

const { seed, seedStandard, seedAdvanced } = require('../src/seed');
const { buildApp } = require('../src/app');
const { db } = require('../src/db');

let server;
let BASE;
const tokens = {};
let meta;

async function api(pathname, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data };
}

async function makeTicket(token, body) {
  const r = await api('/api/tickets', { method: 'POST', token, body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

before(async () => {
  seed(); seedStandard(); seedAdvanced();
  const app = buildApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  BASE = `http://127.0.0.1:${server.address().port}`;
  for (const [role, email] of Object.entries({
    employee: 'employee@itsm.local', agent: 'agent@itsm.local', lead: 'lead@itsm.local', admin: 'admin@itsm.local',
  })) {
    const r = await api('/api/auth/login', { method: 'POST', body: { email, password: 'Passw0rd!' } });
    assert.equal(r.status, 200, `login ${role}`);
    tokens[role] = r.data.token;
  }
  meta = (await api('/api/meta', { token: tokens.admin })).data;
});

after(() => server && server.close());

const cat = (name) => meta.categories.find((c) => c.name === name);
const sub = (catName, name) => meta.subcategories.find((s) => s.category_id === cat(catName).id && s.name === name);

let hw1; let hw2; let sw1;

test('DASH-1 IT roles only; employees are refused', async () => {
  const denied = await api('/api/analytics/dashboard', { token: tokens.employee });
  assert.equal(denied.status, 403);
  const ok = await api('/api/analytics/dashboard', { token: tokens.agent });
  assert.equal(ok.status, 200);
  for (const key of ['period', 'kpis', 'trend', 'byPriority', 'byStatus', 'topCategories',
    'topSubcategories', 'sla', 'recent', 'byGroup', 'snapshot', 'aging', 'ai']) {
    assert.ok(key in ok.data, `payload has ${key}`);
  }
  assert.equal(ok.data.period.days, 30, 'defaults to the last 30 days');
  assert.equal(ok.data.ai.enabled, false, 'no AI insights are fabricated');
  assert.deepEqual(ok.data.ai.insights, []);
});

test('DASH-2 counts, distributions and rankings reflect real tickets', async () => {
  const hwSub = meta.subcategories.find((s) => s.category_id === cat('Hardware').id);
  hw1 = await makeTicket(tokens.employee, {
    title: 'Laptop will not boot', description: 'Black screen on power up',
    category_id: cat('Hardware').id, subcategory_id: hwSub.id, priority_id: 1,
  });
  hw2 = await makeTicket(tokens.employee, {
    title: 'Battery drains fast', description: 'Dies in an hour',
    category_id: cat('Hardware').id, subcategory_id: hwSub.id, priority_id: 3,
  });
  sw1 = await makeTicket(tokens.employee, {
    title: 'Outlook crashes', description: 'On startup', category_id: cat('Software').id, priority_id: 2,
  });

  const r = await api('/api/analytics/dashboard', { token: tokens.admin });
  assert.equal(r.status, 200);
  const d = r.data;
  assert.equal(d.kpis.total.value, 3);
  assert.equal(d.kpis.resolved.value, 0);
  assert.equal(d.kpis.avg_resolution_minutes.value, null, 'no resolutions yet → null, not 0');
  assert.equal(d.kpis.csat.available, false, 'no ratings in the system yet');

  const p1 = d.byPriority.find((p) => p.code === 'P1');
  assert.equal(p1.n, 1);
  assert.equal(d.byPriority.length, meta.priorities.length, 'only configured priorities');
  assert.equal(d.byStatus.length, 7, 'all seven configured statuses');
  assert.equal(d.byStatus.reduce((s, x) => s + x.n, 0), 3);

  assert.equal(d.topCategories.items[0].name, 'Hardware');
  assert.equal(d.topCategories.items[0].n, 2);
  assert.equal(d.topSubcategories.items[0].id, hwSub.id);
  assert.equal(d.topSubcategories.items[0].n, 2);
  assert.equal(d.topSubcategories.untagged, 1, 'the software ticket has no subcategory');

  assert.equal(d.recent.length, 3);
  assert.equal(d.recent[0].ticket_number, sw1.ticket_number, 'newest first');
  assert.equal(d.snapshot.open_backlog, 3);
  assert.equal(d.snapshot.created_today, 3);
  assert.equal(d.aging.find((a) => a.bucket === '0-1').n, 3);

  const trendTotal = d.trend.points.reduce((s, p) => s + p.created, 0);
  assert.equal(trendTotal, 3, 'trend buckets sum to the total');
  assert.equal(d.trend.points.length, 30, 'zero-filled daily buckets');
});

test('DASH-3 filters narrow every section consistently', async () => {
  const r = await api(`/api/analytics/dashboard?category_id=${cat('Hardware').id}`, { token: tokens.admin });
  assert.equal(r.status, 200);
  assert.equal(r.data.kpis.total.value, 2);
  assert.equal(r.data.recent.length, 2);
  assert.equal(r.data.topCategories.items.length, 1);
  assert.equal(r.data.snapshot.open_backlog, 2);

  const p = await api('/api/analytics/dashboard?priority_id=2', { token: tokens.admin });
  assert.equal(p.data.kpis.total.value, 1);
  assert.equal(p.data.recent[0].ticket_number, sw1.ticket_number);

  const s = await api('/api/analytics/dashboard?status=CLOSED', { token: tokens.admin });
  assert.equal(s.data.kpis.total.value, 0);
  assert.equal(s.data.recent.length, 0);

  const bad = await api('/api/analytics/dashboard?status=BOGUS', { token: tokens.admin });
  assert.equal(bad.status, 400);
  const badDate = await api('/api/analytics/dashboard?from=2026-13-40', { token: tokens.admin });
  assert.equal(badDate.status, 400);
  const inverted = await api('/api/analytics/dashboard?from=2026-02-01&to=2026-01-01', { token: tokens.admin });
  assert.equal(inverted.status, 400);
});

test('DASH-4 resolution KPIs, previous-period comparison and SLA figures', async () => {
  // Resolve hw1 as an agent (take → in progress → resolved with note).
  await api(`/api/tickets/${hw1.id}/assign`, { method: 'POST', token: tokens.agent, body: { agent_id: null } });
  const assign = await api(`/api/tickets/${hw1.id}/assign`, { method: 'POST', token: tokens.admin,
    body: { agent_id: (await api('/api/auth/me', { token: tokens.agent })).data.id } });
  assert.equal(assign.status, 200);
  assert.equal((await api(`/api/tickets/${hw1.id}/status`, { method: 'POST', token: tokens.agent,
    body: { status: 'IN_PROGRESS' } })).status, 200);
  const resolved = await api(`/api/tickets/${hw1.id}/status`, { method: 'POST', token: tokens.agent,
    body: { status: 'RESOLVED', note: 'Replaced the SSD' } });
  assert.equal(resolved.status, 200);

  // Backdate a ticket into the previous period so the comparison is exercised.
  db.prepare("UPDATE tickets SET created_at = ? || ' 10:00:00' WHERE id = ?").run(daysAgo(40), hw2.id);

  const r = await api(`/api/analytics/dashboard?from=${daysAgo(29)}&to=${today()}`, { token: tokens.admin });
  const d = r.data;
  assert.equal(d.kpis.total.value, 2, 'two tickets created in the current window');
  assert.equal(d.kpis.total.previous, 1, 'one ticket in the previous window');
  assert.equal(d.kpis.total.change_pct, 100);
  assert.equal(d.kpis.resolved.value, 1);
  assert.ok(Number.isInteger(d.kpis.avg_resolution_minutes.value), 'MTTR computed from resolved_at');
  assert.equal(d.byStatus.find((s) => s.status === 'RESOLVED').n, 1);
  assert.equal(d.trend.points.reduce((s, p) => s + p.resolved, 0), 1);

  assert.equal(d.sla.available, true, 'SLA policies are active and tickets are tracked');
  assert.equal(d.sla.tracked, 2);
  assert.equal(d.sla.breached, 0);
  assert.equal(d.sla.compliance_pct, 100);
  assert.equal(d.sla.within + d.sla.breached + d.sla.at_risk, d.sla.tracked);

  // Restore the backdated ticket for later tests.
  db.prepare("UPDATE tickets SET created_at = datetime('now') WHERE id = ?").run(hw2.id);
});

test('DASH-5 CSAT switches on only when a real rating exists', async () => {
  const before = (await api('/api/analytics/dashboard', { token: tokens.admin })).data.kpis.csat;
  assert.equal(before.available, false);
  const rate = await api(`/api/tickets/${hw1.id}/rating`, { method: 'POST', token: tokens.employee,
    body: { score: 4, comment: 'Quick fix' } });
  assert.equal(rate.status, 201);
  const after = (await api('/api/analytics/dashboard', { token: tokens.admin })).data.kpis.csat;
  assert.equal(after.available, true);
  assert.equal(after.value, 4);
  assert.equal(after.responses, 1);
});

test('DASH-6 team scope for agents, open-by-group and today buckets', async () => {
  const agent = (await api('/api/auth/me', { token: tokens.agent })).data;
  const groups = meta.groups;
  const other = groups.find((g) => g.id !== agent.support_group_id);
  assert.ok(other, 'seed has more than one support group');
  // Move sw1 to another group: it must vanish from the agent's team-scoped view.
  const mv = await api(`/api/tickets/${sw1.id}/assign`, { method: 'POST', token: tokens.admin, body: { group_id: other.id } });
  assert.equal(mv.status, 200);
  // Seeded assignment rules route Hardware to a group; make hw2 untriaged explicitly.
  db.prepare('UPDATE tickets SET support_group_id = NULL, assigned_agent_id = NULL WHERE id = ?').run(hw2.id);

  const adminView = (await api('/api/analytics/dashboard', { token: tokens.admin })).data;
  const agentView = (await api('/api/analytics/dashboard', { token: tokens.agent })).data;
  assert.equal(adminView.filters.scope, 'all');
  assert.equal(agentView.filters.scope, 'team');
  assert.equal(adminView.kpis.total.value, 3);
  assert.equal(agentView.kpis.total.value, 2, 'agent does not see the other group\'s ticket');
  assert.ok(!agentView.recent.some((t) => t.id === sw1.id));

  const otherRow = adminView.byGroup.items.find((g) => g.id === other.id);
  assert.equal(otherRow.n, 1, 'open ticket counted under its real group');
  assert.ok(adminView.byGroup.items.every((g) => groups.some((m) => m.id === g.id)), 'only configured groups');
  assert.equal(adminView.byGroup.untriaged, 1, 'hw2 has no group');

  const single = (await api(`/api/analytics/dashboard?from=${today()}&to=${today()}`, { token: tokens.admin })).data;
  assert.equal(single.trend.bucket, 'hour');
  assert.equal(single.trend.points.length, 24);
});

test('RPT-1 /reports/insights: workload, groups, backlog, SLA by priority, service metrics', async () => {
  const denied = await api('/api/reports/insights', { token: tokens.employee });
  assert.equal(denied.status, 403);
  const r = await api('/api/reports/insights', { token: tokens.admin });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = r.data;
  for (const k of ['workload', 'groups', 'backlog', 'resolutionTrend', 'slaByPriority', 'slaTrend', 'service', 'recurring']) {
    assert.ok(k in d, `has ${k}`);
  }
  const agent = (await api('/api/auth/me', { token: tokens.agent })).data;
  const row = d.workload.agents.find((a) => a.id === agent.id);
  assert.ok(row, 'agent appears in workload');
  assert.equal(row.resolved, 1, 'hw1 resolved by the agent');
  assert.ok(Number.isInteger(row.avg_mttr_minutes));
  assert.equal(row.assigned, row.open + row.resolved, 'assigned = open + resolved');
  // hw2 was cleared in DASH-6 and sw1's group-only move also dropped its agent.
  assert.equal(d.workload.unassigned.assigned, 2, 'hw2 and sw1 are unassigned');
  assert.equal(d.workload.agents.reduce((s, a) => s + a.assigned, 0) + d.workload.unassigned.assigned, 3);

  assert.ok(d.groups.groups.every((g) => meta.groups.some((m) => m.id === g.id)), 'only configured groups');
  const totalByGroup = d.groups.groups.reduce((s, g) => s + g.total, 0) + d.groups.untriaged.total;
  assert.equal(totalByGroup, 3, 'every ticket lands in a real group or untriaged');

  assert.equal(d.backlog.points.length, 30);
  assert.equal(d.backlog.points.at(-1).open, 2, 'backlog today = the two open tickets');
  assert.equal(d.slaByPriority.length, meta.priorities.length);
  const p1 = d.slaByPriority.find((p) => p.code === 'P1');
  assert.equal(p1.tracked, 1);
  assert.equal(p1.met, 1);
  assert.equal(p1.compliance_pct, 100);
  assert.equal(d.service.fcr.resolved, 1);
  assert.ok(d.service.first_response_minutes != null, 'assignment recorded a first response');
  assert.equal(d.resolutionTrend.points.reduce((s, p) => s + p.resolved, 0), 1);
  assert.equal(d.slaTrend.points.reduce((s, p) => s + p.tracked, 0), 3, 'all three tickets have SLA records');

  const filtered = (await api(`/api/reports/insights?category_id=${cat('Software').id}`, { token: tokens.admin })).data;
  assert.equal(filtered.backlog.points.at(-1).open, 1);
  const bad = await api('/api/reports/insights?from=nope', { token: tokens.admin });
  assert.equal(bad.status, 400);
});

test('RPT-2 ticket list accepts a from/to window for the detailed report', async () => {
  const all = await api('/api/tickets?scope=team', { token: tokens.admin });
  assert.equal(all.data.length, 3);
  const none = await api('/api/tickets?scope=team&from=2000-01-01&to=2000-01-31', { token: tokens.admin });
  assert.equal(none.status, 200);
  assert.equal(none.data.length, 0);
  const win = await api(`/api/tickets?scope=team&from=${daysAgo(1)}&to=${today()}`, { token: tokens.admin });
  assert.equal(win.data.length, 3);
});

test('GEN-1 report catalog and JSON preview reflect real tickets', async () => {
  const denied = await api('/api/reports/catalog', { token: tokens.employee });
  assert.equal(denied.status, 403);
  const catRes = await api('/api/reports/catalog', { token: tokens.admin });
  assert.equal(catRes.status, 200);
  const keys = catRes.data.map((r) => r.key);
  for (const k of ['summary', 'status', 'priority', 'category', 'group', 'agent', 'sla', 'aging', 'daily', 'tickets', 'resolved', 'open']) {
    assert.ok(keys.includes(k), `catalog has ${k}`);
  }

  const sum = await api('/api/reports/generate?type=summary', { token: tokens.admin });
  assert.equal(sum.status, 200, JSON.stringify(sum.data));
  assert.equal(sum.data.title, 'Ticket summary');
  assert.equal(sum.data.summary.find((s) => s.label === 'Created').value, 3);
  assert.equal(sum.data.rows.find((r) => r.metric === 'Tickets resolved').value, 1);
  assert.equal(sum.data.filters.team, 'All teams');

  const st = await api('/api/reports/generate?type=status', { token: tokens.admin });
  assert.equal(st.data.rows.length, 7, 'one row per configured status');
  assert.equal(st.data.totals.n, 3);
  assert.equal(st.data.rows.find((r) => r.status === 'Resolved').n, 1);

  const res = await api('/api/reports/generate?type=resolved', { token: tokens.admin });
  assert.equal(res.data.row_count, 1);
  assert.equal(res.data.rows[0].ticket_number, hw1.ticket_number);
  assert.ok(res.data.rows[0].resolution_time.endsWith('min') || res.data.rows[0].resolution_time.endsWith('h'));

  const open = await api('/api/reports/generate?type=open', { token: tokens.admin });
  assert.equal(open.data.row_count, 2);

  const agent = await api('/api/reports/generate?type=agent', { token: tokens.admin });
  assert.equal(agent.data.totals.assigned, 3);

  const sla = await api('/api/reports/generate?type=sla', { token: tokens.admin });
  assert.equal(sla.data.totals.tracked, 3);

  const filtered = await api(`/api/reports/generate?type=tickets&category_id=${cat('Hardware').id}`, { token: tokens.admin });
  assert.equal(filtered.data.row_count, 2);
  assert.equal(filtered.data.filters.category, 'Hardware');

  const bad = await api('/api/reports/generate?type=nope', { token: tokens.admin });
  assert.equal(bad.status, 400);
  const badFmt = await api('/api/reports/generate?type=summary&format=docx', { token: tokens.admin });
  assert.equal(badFmt.status, 400);

  // Agents see their own team scope only.
  const agentView = await api('/api/reports/generate?type=tickets', { token: tokens.agent });
  assert.equal(agentView.data.filters.scope, 'Own team');
  assert.equal(agentView.data.row_count, 2, 'other group\'s ticket is excluded');
});

test('GEN-2 Excel, PDF and CSV exports are real files and are audited', async () => {
  const fetchRaw = async (fmt) => {
    const r = await fetch(`${BASE}/api/reports/generate?type=tickets&format=${fmt}`, { headers: { Authorization: `Bearer ${tokens.admin}` } });
    return { status: r.status, type: r.headers.get('content-type'), disp: r.headers.get('content-disposition'), buf: Buffer.from(await r.arrayBuffer()) };
  };
  const xlsx = await fetchRaw('xlsx');
  assert.equal(xlsx.status, 200);
  assert.ok(xlsx.type.includes('spreadsheetml'));
  assert.ok(/filename="tickets-report_.*\.xlsx"/.test(xlsx.disp));
  assert.equal(xlsx.buf.subarray(0, 2).toString(), 'PK', 'xlsx is a zip container');
  assert.ok(xlsx.buf.length > 5000);

  const pdf = await fetchRaw('pdf');
  assert.equal(pdf.status, 200);
  assert.equal(pdf.type, 'application/pdf');
  assert.equal(pdf.buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.buf.includes('%%EOF'));

  const csv = await fetchRaw('csv');
  assert.equal(csv.status, 200);
  const text = csv.buf.toString('utf8');
  assert.ok(text.includes('Ticket list'));
  assert.ok(text.includes(hw1.ticket_number));

  const audits = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'REPORT_EXPORTED'").get().n;
  assert.ok(audits >= 3, 'each export is written to the audit trail');

  // Summary (portrait, with totals) and aging (with the extra table) render too.
  for (const t of ['summary', 'aging', 'sla', 'daily']) {
    const r = await fetch(`${BASE}/api/reports/generate?type=${t}&format=pdf`, { headers: { Authorization: `Bearer ${tokens.admin}` } });
    assert.equal(r.status, 200, `${t} pdf`);
    const x = await fetch(`${BASE}/api/reports/generate?type=${t}&format=xlsx`, { headers: { Authorization: `Bearer ${tokens.admin}` } });
    assert.equal(x.status, 200, `${t} xlsx`);
  }
});

test('DASH-7 existing dashboard and ticket list keep working (regression)', async () => {
  const dash = await api('/api/reports/dashboard', { token: tokens.admin });
  assert.equal(dash.status, 200);
  assert.ok('mine' in dash.data && 'resolvedToday' in dash.data);
  const bySub = await api(`/api/tickets?scope=team&subcategory_id=${hw1.subcategory_id}`, { token: tokens.admin });
  assert.equal(bySub.status, 200);
  assert.equal(bySub.data.length, 2, 'new subcategory_id filter on the list endpoint');
});
