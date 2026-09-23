const { db } = require('./db');
const { aiStatus } = require('./ai');

// ================= KPI & Analytics dashboard (BRD 6.13 / 8.13) =================
// Single aggregation entry point behind GET /api/analytics/dashboard.
// Every figure is computed in SQL over the real ticket tables; nothing is
// estimated or fabricated. Sections that depend on data the deployment does
// not have yet (ratings, SLA measurements) report `available: false` so the
// UI can render an honest empty state.
//
// Scope follows the existing /reports/dashboard rule: ADMIN sees every ticket,
// AGENT / TEAM_LEAD see their own support group plus untriaged tickets.

const STATUSES = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING', 'RESOLVED', 'CLOSED', 'REOPENED'];
const OPEN_STATUSES = "('NEW','ASSIGNED','IN_PROGRESS','PENDING','REOPENED')";
const DAY_MS = 86400000;

const isoDay = (d) => d.toISOString().slice(0, 10);
const parseDay = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || isoDay(d) !== s ? null : d; // rejects 2026-13-40, 2026-02-30
};
const addDays = (d, n) => new Date(d.getTime() + n * DAY_MS);
const toId = (v) => (v === undefined || v === null || v === '' ? null : Number.isInteger(Number(v)) ? Number(v) : NaN);

function pctChange(current, previous) {
  if (previous == null || current == null) return null;
  if (previous === 0) return current === 0 ? 0 : null; // no baseline → no meaningful %
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

// Parses and validates query params. Throws { status, message } on bad input.
function resolveFilters(user, query = {}) {
  const today = new Date(`${isoDay(new Date())}T00:00:00Z`);
  let from = parseDay(query.from);
  let to = parseDay(query.to);
  if ((query.from && !from) || (query.to && !to)) {
    throw Object.assign(new Error('Dates must be YYYY-MM-DD'), { status: 400 });
  }
  if (!to) to = today;
  if (!from) from = addDays(to, -29);
  if (from > to) throw Object.assign(new Error('"from" must not be after "to"'), { status: 400 });
  const days = Math.round((to - from) / DAY_MS) + 1;
  if (days > 730) throw Object.assign(new Error('Date range cannot exceed 2 years'), { status: 400 });

  const ids = {
    group_id: toId(query.group_id),
    category_id: toId(query.category_id),
    priority_id: toId(query.priority_id),
  };
  for (const [k, v] of Object.entries(ids)) {
    if (Number.isNaN(v)) throw Object.assign(new Error(`${k} must be a number`), { status: 400 });
  }
  const status = query.status ? String(query.status).toUpperCase() : null;
  if (status && !STATUSES.includes(status)) {
    throw Object.assign(new Error('Unknown status filter'), { status: 400 });
  }

  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  return {
    from: isoDay(from), to: isoDay(to), days,
    fromTs: `${isoDay(from)} 00:00:00`, toTsExcl: `${isoDay(addDays(to, 1))} 00:00:00`,
    prevFrom: isoDay(prevFrom), prevTo: isoDay(prevTo),
    prevFromTs: `${isoDay(prevFrom)} 00:00:00`, prevToTsExcl: `${isoDay(from)} 00:00:00`,
    bucket: days === 1 ? 'hour' : 'day',
    ...ids, status,
    scope: user.role === 'ADMIN' ? 'all' : 'team',
    gid: user.support_group_id ?? null,
  };
}

// WHERE fragments (all reference the tickets table as `t`).
function buildClauses(f) {
  const base = [];
  const params = {
    gid: f.gid, group_id: f.group_id, category_id: f.category_id,
    priority_id: f.priority_id, status: f.status,
    fromTs: f.fromTs, toTsExcl: f.toTsExcl, prevFromTs: f.prevFromTs, prevToTsExcl: f.prevToTsExcl,
  };
  if (f.scope === 'team') base.push('(t.support_group_id = @gid OR t.support_group_id IS NULL)');
  if (f.group_id != null) base.push('t.support_group_id = @group_id');
  if (f.category_id != null) base.push('t.category_id = @category_id');
  if (f.priority_id != null) base.push('t.priority_id = @priority_id');
  if (f.status) base.push('t.status = @status');
  const baseSql = base.length ? base.join(' AND ') : '1=1';
  return {
    params,
    base: baseSql,
    created: `${baseSql} AND t.created_at >= @fromTs AND t.created_at < @toTsExcl`,
    createdPrev: `${baseSql} AND t.created_at >= @prevFromTs AND t.created_at < @prevToTsExcl`,
    resolved: `${baseSql} AND t.resolved_at IS NOT NULL AND t.resolved_at >= @fromTs AND t.resolved_at < @toTsExcl`,
    resolvedPrev: `${baseSql} AND t.resolved_at IS NOT NULL AND t.resolved_at >= @prevFromTs AND t.resolved_at < @prevToTsExcl`,
  };
}

const count = (where, params) =>
  db.prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE ${where}`).get(params).n;

function kpis(c) {
  const total = count(c.created, c.params);
  const totalPrev = count(c.createdPrev, c.params);
  const resolved = count(c.resolved, c.params);
  const resolvedPrev = count(c.resolvedPrev, c.params);

  const mttr = (where) => db.prepare(`
    SELECT AVG((julianday(t.resolved_at) - julianday(t.created_at)) * 24 * 60) AS m
    FROM tickets t WHERE ${where}`).get(c.params).m;
  const avgRes = mttr(c.resolved);
  const avgResPrev = mttr(c.resolvedPrev);

  const csat = (fromTs, toTsExcl) => db.prepare(`
    SELECT COUNT(*) AS n, AVG(r.score) AS avg
    FROM ticket_ratings r JOIN tickets t ON t.id = r.ticket_id
    WHERE ${c.base} AND r.created_at >= @a AND r.created_at < @b`)
    .get({ ...c.params, a: fromTs, b: toTsExcl });
  const sat = csat(c.params.fromTs, c.params.toTsExcl);
  const satPrev = csat(c.params.prevFromTs, c.params.prevToTsExcl);
  const ratingsAllTime = db.prepare('SELECT COUNT(*) AS n FROM ticket_ratings').get().n;

  return {
    total: { value: total, previous: totalPrev, change_pct: pctChange(total, totalPrev) },
    resolved: { value: resolved, previous: resolvedPrev, change_pct: pctChange(resolved, resolvedPrev) },
    avg_resolution_minutes: {
      value: avgRes != null ? Math.round(avgRes) : null,
      previous: avgResPrev != null ? Math.round(avgResPrev) : null,
      change_pct: avgRes != null && avgResPrev != null ? pctChange(avgRes, avgResPrev) : null,
      sample: resolved,
    },
    csat: {
      available: ratingsAllTime > 0,
      value: sat.avg != null ? Math.round(sat.avg * 10) / 10 : null,
      responses: sat.n,
      previous: satPrev.avg != null ? Math.round(satPrev.avg * 10) / 10 : null,
      change_pct: sat.avg != null && satPrev.avg != null ? pctChange(sat.avg, satPrev.avg) : null,
    },
  };
}

// Time series with every bucket present (zeros filled) so charts never skip days.
function trend(c, f) {
  const fmt = f.bucket === 'hour' ? '%Y-%m-%d %H' : '%Y-%m-%d';
  const series = (col, where) => db.prepare(`
    SELECT strftime('${fmt}', t.${col}) AS k, COUNT(*) AS n,
      AVG((julianday(t.resolved_at) - julianday(t.created_at)) * 24 * 60) AS mttr
    FROM tickets t WHERE ${where} GROUP BY k`).all(c.params);
  const created = new Map(series('created_at', c.created).map((r) => [r.k, r]));
  const resolved = new Map(series('resolved_at', c.resolved).map((r) => [r.k, r]));
  const ratings = new Map(db.prepare(`
    SELECT strftime('${fmt}', r.created_at) AS k, AVG(r.score) AS avg
    FROM ticket_ratings r JOIN tickets t ON t.id = r.ticket_id
    WHERE ${c.base} AND r.created_at >= @fromTs AND r.created_at < @toTsExcl GROUP BY k`)
    .all(c.params).map((r) => [r.k, r.avg]));

  const points = [];
  if (f.bucket === 'hour') {
    for (let h = 0; h < 24; h++) {
      const k = `${f.from} ${String(h).padStart(2, '0')}`;
      points.push({ key: k, label: `${String(h).padStart(2, '0')}:00`, created: created.get(k)?.n || 0,
        resolved: resolved.get(k)?.n || 0, mttr: resolved.get(k)?.mttr ?? null, csat: ratings.get(k) ?? null });
    }
  } else {
    for (let d = new Date(`${f.from}T00:00:00Z`); isoDay(d) <= f.to; d = addDays(d, 1)) {
      const k = isoDay(d);
      points.push({ key: k, label: k, created: created.get(k)?.n || 0,
        resolved: resolved.get(k)?.n || 0, mttr: resolved.get(k)?.mttr ?? null, csat: ratings.get(k) ?? null });
    }
  }
  return { bucket: f.bucket, points };
}

function withPct(rows, key = 'n') {
  const total = rows.reduce((s, r) => s + r[key], 0);
  return rows.map((r) => ({ ...r, pct: total ? Math.round((r[key] / total) * 1000) / 10 : 0 }));
}

function byPriority(c) {
  return withPct(db.prepare(`
    SELECT p.id, p.code, p.label, COUNT(t.id) AS n
    FROM priorities p LEFT JOIN tickets t ON t.priority_id = p.id AND ${c.created}
    GROUP BY p.id ORDER BY p.sort`).all(c.params));
}

function byStatus(c) {
  const rows = db.prepare(`SELECT t.status, COUNT(*) AS n FROM tickets t WHERE ${c.created} GROUP BY t.status`).all(c.params);
  const map = new Map(rows.map((r) => [r.status, r.n]));
  return withPct(STATUSES.map((s) => ({ status: s, n: map.get(s) || 0 })));
}

function topCategories(c, limit = 5) {
  const rows = db.prepare(`
    SELECT c.id, c.name, COUNT(*) AS n
    FROM tickets t JOIN categories c ON c.id = t.category_id
    WHERE ${c.created} GROUP BY c.id ORDER BY n DESC, c.name ASC`).all(c.params);
  const top = rows.slice(0, limit);
  const others = rows.slice(limit).reduce((s, r) => s + r.n, 0);
  return { items: top, others, distinct: rows.length };
}

function topSubcategories(c, limit = 5) {
  const rows = db.prepare(`
    SELECT sc.id, sc.name, c.id AS category_id, c.name AS category_name, COUNT(*) AS n
    FROM tickets t
    JOIN subcategories sc ON sc.id = t.subcategory_id
    JOIN categories c ON c.id = t.category_id
    WHERE ${c.created} GROUP BY sc.id ORDER BY n DESC, sc.name ASC`).all(c.params);
  const top = rows.slice(0, limit);
  const others = rows.slice(limit).reduce((s, r) => s + r.n, 0);
  const untagged = db.prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE ${c.created} AND t.subcategory_id IS NULL`).get(c.params).n;
  return { items: top, others, untagged, distinct: rows.length };
}

// SLA compliance for tickets created in the period. Definitions match
// /reports/standard: breached = resolution SLA missed; at risk = still open,
// not breached, warning already issued; within = everything else tracked.
function sla(c) {
  const policies = db.prepare('SELECT COUNT(*) AS n FROM sla_policies WHERE active = 1').get().n;
  const row = db.prepare(`
    SELECT COUNT(*) AS tracked,
      SUM(CASE WHEN s.resolution_breached = 1 THEN 1 ELSE 0 END) AS breached,
      SUM(CASE WHEN s.resolution_breached = 0 AND s.completed_at IS NULL AND s.warning_sent = 1
               AND t.status IN ${OPEN_STATUSES} THEN 1 ELSE 0 END) AS at_risk
    FROM ticket_sla s JOIN tickets t ON t.id = s.ticket_id WHERE ${c.created}`).get(c.params);
  const tracked = row.tracked || 0;
  const breached = row.breached || 0;
  const atRisk = row.at_risk || 0;
  const available = policies > 0 && tracked > 0;
  return {
    available,
    policies_active: policies,
    tracked, breached, at_risk: atRisk,
    within: Math.max(0, tracked - breached - atRisk),
    compliance_pct: tracked ? Math.round(((tracked - breached) / tracked) * 100) : null,
    message: policies === 0
      ? 'SLA analytics will be available once SLA configuration and measurement data are enabled.'
      : tracked === 0 ? 'No SLA data is currently available for the selected filters.' : null,
  };
}

function recent(c, limit = 8) {
  return db.prepare(`
    SELECT t.id, t.ticket_number, t.title, t.status, t.created_at, t.updated_at,
      p.code AS priority_code, p.label AS priority_label,
      ag.full_name AS agent_name, g.name AS group_name
    FROM tickets t
    JOIN priorities p ON p.id = t.priority_id
    LEFT JOIN users ag ON ag.id = t.assigned_agent_id
    LEFT JOIN support_groups g ON g.id = t.support_group_id
    WHERE ${c.created} ORDER BY t.created_at DESC, t.id DESC LIMIT @limit`).all({ ...c.params, limit });
}

// Open (unresolved) tickets in the period, per support group. Only groups
// that exist in the system appear; untriaged tickets are reported separately.
function byGroup(c) {
  const rows = db.prepare(`
    SELECT g.id, g.name, COUNT(t.id) AS n
    FROM support_groups g
    LEFT JOIN tickets t ON t.support_group_id = g.id AND ${c.created} AND t.status IN ${OPEN_STATUSES}
    WHERE g.active = 1 GROUP BY g.id ORDER BY n DESC, g.name ASC`).all(c.params);
  const untriaged = db.prepare(`
    SELECT COUNT(*) AS n FROM tickets t
    WHERE ${c.created} AND t.status IN ${OPEN_STATUSES} AND t.support_group_id IS NULL`).get(c.params).n;
  return { items: rows, untriaged };
}

// "Right now" figures: honour group/category/priority/status filters and role
// scope but not the date range, since a backlog is a point-in-time measure.
function snapshot(c) {
  const p = c.params;
  const today = isoDay(new Date());
  return {
    as_of: today,
    created_today: count(`${c.base} AND date(t.created_at) = @today`, { ...p, today }),
    resolved_today: count(`${c.base} AND date(t.resolved_at) = @today`, { ...p, today }),
    open_backlog: count(`${c.base} AND t.status IN ${OPEN_STATUSES}`, p),
    pending: count(`${c.base} AND t.status = 'PENDING'`, p),
    unassigned: count(`${c.base} AND t.assigned_agent_id IS NULL AND t.status IN ('NEW','REOPENED')`, p),
    reopened: count(`${c.base} AND t.status = 'REOPENED'`, p),
  };
}

function aging(c) {
  const rows = db.prepare(`
    SELECT CASE
        WHEN julianday('now') - julianday(t.created_at) <= 1 THEN '0-1'
        WHEN julianday('now') - julianday(t.created_at) <= 3 THEN '1-3'
        WHEN julianday('now') - julianday(t.created_at) <= 7 THEN '3-7'
        ELSE '7+' END AS bucket, COUNT(*) AS n
    FROM tickets t WHERE ${c.base} AND t.status IN ${OPEN_STATUSES} GROUP BY bucket`).all(c.params);
  const map = new Map(rows.map((r) => [r.bucket, r.n]));
  return [
    { bucket: '0-1', label: '0–1 day', n: map.get('0-1') || 0 },
    { bucket: '1-3', label: '1–3 days', n: map.get('1-3') || 0 },
    { bucket: '3-7', label: '3–7 days', n: map.get('3-7') || 0 },
    { bucket: '7+', label: 'More than 7 days', n: map.get('7+') || 0 },
  ];
}

// AI insights contract. Insight objects, when a generator is connected, take
// the shape { type, severity: 'info'|'warning'|'critical', title, detail,
// ticket_id?, category_id?, group_id? }. Nothing is generated today: the
// dashboard only ever renders insights that a real provider produced.
function aiInsights() {
  const status = aiStatus();
  return {
    enabled: false,
    provider_mode: status.mode,
    insights: [],
    message: 'AI insights will appear here once the AI insights service is connected and approved.',
  };
}

function dashboardAnalytics(user, query) {
  const f = resolveFilters(user, query);
  const c = buildClauses(f);
  return {
    generated_at: new Date().toISOString(),
    period: { from: f.from, to: f.to, days: f.days, prev_from: f.prevFrom, prev_to: f.prevTo, bucket: f.bucket },
    filters: { group_id: f.group_id, category_id: f.category_id, priority_id: f.priority_id, status: f.status, scope: f.scope },
    kpis: kpis(c),
    trend: trend(c, f),
    byPriority: byPriority(c),
    byStatus: byStatus(c),
    topCategories: topCategories(c),
    topSubcategories: topSubcategories(c),
    sla: sla(c),
    recent: recent(c),
    byGroup: byGroup(c),
    snapshot: snapshot(c),
    aging: aging(c),
    ai: aiInsights(),
  };
}

// ================= Reports page insights (GET /reports/insights) =================
// Deeper operational/service metrics for the Reports workspace, using the same
// filters and role scope as the dashboard. Metric definitions intentionally
// mirror /reports/standard (MTTR, first response, FCR, SLA compliance).

function agentWorkload(c) {
  const rows = db.prepare(`
    SELECT u.id, u.full_name AS agent, COUNT(t.id) AS assigned,
      SUM(CASE WHEN t.status IN ${OPEN_STATUSES} THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN t.status IN ('RESOLVED','CLOSED') THEN 1 ELSE 0 END) AS resolved,
      ROUND(AVG(CASE WHEN t.resolved_at IS NOT NULL
        THEN (julianday(t.resolved_at) - julianday(t.created_at)) * 24 * 60 END)) AS avg_mttr_minutes
    FROM tickets t JOIN users u ON u.id = t.assigned_agent_id
    WHERE ${c.created} GROUP BY u.id ORDER BY assigned DESC, u.full_name ASC`).all(c.params);
  const unassigned = db.prepare(`
    SELECT COUNT(*) AS assigned,
      SUM(CASE WHEN t.status IN ${OPEN_STATUSES} THEN 1 ELSE 0 END) AS open
    FROM tickets t WHERE ${c.created} AND t.assigned_agent_id IS NULL`).get(c.params);
  return { agents: rows, unassigned: { assigned: unassigned.assigned || 0, open: unassigned.open || 0 } };
}

function groupPerformance(c) {
  const rows = db.prepare(`
    SELECT g.id, g.name AS grp, COUNT(t.id) AS total,
      SUM(CASE WHEN t.status IN ${OPEN_STATUSES} THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN t.status IN ('RESOLVED','CLOSED') THEN 1 ELSE 0 END) AS resolved,
      SUM(CASE WHEN s.resolution_breached = 1 THEN 1 ELSE 0 END) AS breached
    FROM support_groups g
    LEFT JOIN tickets t ON t.support_group_id = g.id AND ${c.created}
    LEFT JOIN ticket_sla s ON s.ticket_id = t.id
    WHERE g.active = 1 GROUP BY g.id ORDER BY total DESC, g.name ASC`).all(c.params);
  const untriaged = db.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN t.status IN ${OPEN_STATUSES} THEN 1 ELSE 0 END) AS open
    FROM tickets t WHERE ${c.created} AND t.support_group_id IS NULL`).get(c.params);
  return { groups: rows, untriaged: { total: untriaged.total || 0, open: untriaged.open || 0 } };
}

// Open backlog at the end of each day in the range (tickets created before the
// cut-off and not yet resolved by then). A currently reopened ticket counts as
// open for every day since its creation.
function backlogSeries(c, f) {
  const stmt = db.prepare(`
    SELECT COUNT(*) AS n FROM tickets t
    WHERE ${c.base} AND t.created_at < @cut
      AND (t.resolved_at IS NULL OR t.resolved_at >= @cut OR t.status = 'REOPENED')`);
  const points = [];
  const step = f.days > 120 ? 7 : 1;
  for (let d = new Date(`${f.from}T00:00:00Z`); isoDay(d) <= f.to; d = addDays(d, step)) {
    const end = addDays(d, step - 1) > new Date(`${f.to}T00:00:00Z`) ? new Date(`${f.to}T00:00:00Z`) : addDays(d, step - 1);
    const cut = `${isoDay(addDays(end, 1))} 00:00:00`;
    points.push({ key: isoDay(end), label: isoDay(end), open: stmt.get({ ...c.params, cut }).n });
  }
  return { bucket: step === 1 ? 'day' : 'week', points };
}

// Average resolution time per bucket for tickets resolved in the range.
function resolutionTrend(c, f) {
  const weekly = f.days > 60;
  const fmt = weekly ? '%Y-%W' : '%Y-%m-%d';
  const rows = db.prepare(`
    SELECT strftime('${fmt}', t.resolved_at) AS k, COUNT(*) AS resolved,
      ROUND(AVG((julianday(t.resolved_at) - julianday(t.created_at)) * 24 * 60)) AS mttr_minutes
    FROM tickets t WHERE ${c.resolved} GROUP BY k ORDER BY k`).all(c.params);
  const map = new Map(rows.map((r) => [r.k, r]));
  const points = [];
  if (weekly) {
    const seen = new Set();
    for (let d = new Date(`${f.from}T00:00:00Z`); isoDay(d) <= f.to; d = addDays(d, 1)) {
      const k = weekKey(d);
      if (seen.has(k)) continue;
      seen.add(k);
      points.push({ key: k, label: isoDay(d), resolved: map.get(k)?.resolved || 0, mttr_minutes: map.get(k)?.mttr_minutes ?? null });
    }
  } else {
    for (let d = new Date(`${f.from}T00:00:00Z`); isoDay(d) <= f.to; d = addDays(d, 1)) {
      const k = isoDay(d);
      points.push({ key: k, label: k, resolved: map.get(k)?.resolved || 0, mttr_minutes: map.get(k)?.mttr_minutes ?? null });
    }
  }
  return { bucket: weekly ? 'week' : 'day', points };
}

// SQLite's %W (Monday-based week number) reproduced in JS for bucket labelling.
function weekKey(d) {
  const year = d.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const dayOfYear = Math.floor((d - jan1) / DAY_MS);
  const jan1Dow = (jan1.getUTCDay() + 6) % 7; // Monday = 0
  const week = Math.floor((dayOfYear + jan1Dow) / 7);
  return `${year}-${String(week).padStart(2, '0')}`;
}

function slaByPriority(c) {
  return db.prepare(`
    SELECT p.id, p.code, p.label, COUNT(s.id) AS tracked,
      SUM(CASE WHEN s.resolution_breached = 1 THEN 1 ELSE 0 END) AS breached,
      SUM(CASE WHEN s.resolution_breached = 0 AND s.completed_at IS NULL AND s.warning_sent = 1
               AND t.status IN ${OPEN_STATUSES} THEN 1 ELSE 0 END) AS at_risk,
      SUM(CASE WHEN s.completed_at IS NOT NULL AND s.resolution_breached = 0 THEN 1 ELSE 0 END) AS met
    FROM priorities p
    LEFT JOIN tickets t ON t.priority_id = p.id AND ${c.created}
    LEFT JOIN ticket_sla s ON s.ticket_id = t.id
    GROUP BY p.id ORDER BY p.sort`).all(c.params).map((r) => ({
    ...r,
    breached: r.breached || 0, at_risk: r.at_risk || 0, met: r.met || 0,
    within: Math.max(0, (r.tracked || 0) - (r.breached || 0) - (r.at_risk || 0)),
    compliance_pct: r.tracked ? Math.round(((r.tracked - (r.breached || 0)) / r.tracked) * 100) : null,
  }));
}

// SLA compliance over time (by ticket creation bucket).
function slaTrend(c, f) {
  const weekly = f.days > 31;
  const fmt = weekly ? '%Y-%W' : '%Y-%m-%d';
  const rows = db.prepare(`
    SELECT strftime('${fmt}', t.created_at) AS k, COUNT(*) AS tracked,
      SUM(CASE WHEN s.resolution_breached = 1 THEN 1 ELSE 0 END) AS breached
    FROM ticket_sla s JOIN tickets t ON t.id = s.ticket_id
    WHERE ${c.created} GROUP BY k ORDER BY k`).all(c.params);
  const map = new Map(rows.map((r) => [r.k, r]));
  const points = [];
  const seen = new Set();
  for (let d = new Date(`${f.from}T00:00:00Z`); isoDay(d) <= f.to; d = addDays(d, 1)) {
    const k = weekly ? weekKey(d) : isoDay(d);
    if (seen.has(k)) continue;
    seen.add(k);
    const r = map.get(k);
    points.push({
      key: k, label: isoDay(d), tracked: r?.tracked || 0, breached: r?.breached || 0,
      compliance_pct: r?.tracked ? Math.round(((r.tracked - (r.breached || 0)) / r.tracked) * 100) : null,
    });
  }
  return { bucket: weekly ? 'week' : 'day', points };
}

function serviceMetrics(c) {
  const frt = db.prepare(`
    SELECT AVG((julianday(s.first_response_at) - julianday(t.created_at)) * 24 * 60) AS minutes,
      COUNT(s.first_response_at) AS sample
    FROM ticket_sla s JOIN tickets t ON t.id = s.ticket_id
    WHERE ${c.created} AND s.first_response_at IS NOT NULL`).get(c.params);
  const responseBreached = db.prepare(`
    SELECT COUNT(*) AS n FROM ticket_sla s JOIN tickets t ON t.id = s.ticket_id
    WHERE ${c.created} AND s.response_breached = 1`).get(c.params).n;
  const fcr = db.prepare(`
    SELECT COUNT(*) AS resolved,
      SUM(CASE WHEN NOT EXISTS (
        SELECT 1 FROM ticket_history h WHERE h.ticket_id = t.id AND h.action = 'REASSIGNED'
      ) THEN 1 ELSE 0 END) AS first_contact
    FROM tickets t WHERE ${c.resolved}`).get(c.params);
  return {
    first_response_minutes: frt.minutes != null ? Math.round(frt.minutes) : null,
    first_response_sample: frt.sample || 0,
    response_breached: responseBreached,
    fcr: {
      resolved: fcr.resolved || 0, first_contact: fcr.first_contact || 0,
      pct: fcr.resolved ? Math.round(((fcr.first_contact || 0) / fcr.resolved) * 100) : null,
    },
  };
}

function recurringIssues(c, limit = 8) {
  return db.prepare(`
    SELECT c.id AS category_id, c.name AS category, sc.id AS subcategory_id,
      COALESCE(sc.name, '(no subcategory)') AS subcategory, COUNT(*) AS n
    FROM tickets t
    JOIN categories c ON c.id = t.category_id
    LEFT JOIN subcategories sc ON sc.id = t.subcategory_id
    WHERE ${c.created} GROUP BY c.id, sc.id HAVING COUNT(*) >= 2
    ORDER BY n DESC, category ASC LIMIT @limit`).all({ ...c.params, limit });
}

function reportInsights(user, query) {
  const f = resolveFilters(user, query);
  const c = buildClauses(f);
  return {
    generated_at: new Date().toISOString(),
    period: { from: f.from, to: f.to, days: f.days },
    filters: { group_id: f.group_id, category_id: f.category_id, priority_id: f.priority_id, status: f.status, scope: f.scope },
    workload: agentWorkload(c),
    groups: groupPerformance(c),
    backlog: backlogSeries(c, f),
    resolutionTrend: resolutionTrend(c, f),
    slaByPriority: slaByPriority(c),
    slaTrend: slaTrend(c, f),
    service: serviceMetrics(c),
    recurring: recurringIssues(c),
    // Full category ranking (the dashboard payload carries only the top 5).
    categories: db.prepare(`
      SELECT c.id, c.name, COUNT(*) AS n FROM tickets t JOIN categories c ON c.id = t.category_id
      WHERE ${c.created} GROUP BY c.id ORDER BY n DESC, c.name ASC`).all(c.params),
  };
}

module.exports = {
  dashboardAnalytics, reportInsights, resolveFilters, STATUSES, OPEN_STATUSES,
  // building blocks reused by the report generator (src/reportBuilder.js)
  buildClauses, kpis, trend, byStatus, byPriority, sla, aging, agentWorkload, groupPerformance,
  backlogSeries, slaByPriority, serviceMetrics, isoDay,
};
