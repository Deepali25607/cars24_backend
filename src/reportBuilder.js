const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { db } = require('./db');
const D = require('./dashboard');

// ================= Report generator (GET /reports/generate) =================
// A registry of report definitions. Each builds { summary, columns, rows } from
// the same filtered ticket set used across the app (period + team/priority/
// category/status, role-scoped). The same result is rendered as JSON (preview),
// CSV, Excel (.xlsx via exceljs) or PDF (via pdfkit). Nothing is estimated —
// every cell is a SQL aggregate over real tickets.

const STATUS_LABEL = {
  NEW: 'New', ASSIGNED: 'Assigned', IN_PROGRESS: 'In progress', PENDING: 'Pending',
  RESOLVED: 'Resolved', CLOSED: 'Closed', REOPENED: 'Reopened',
};
const OPEN = D.OPEN_STATUSES;

const fmtMin = (m) => (m == null ? '—' : m >= 1440 ? `${(m / 1440).toFixed(1)} d` : m >= 60 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m)} min`);
const pctOf = (n, t) => (t ? `${Math.round((n / t) * 1000) / 10}%` : '—');
const dt = (s) => (s ? s.slice(0, 16) : '');
const mttr = 'ROUND(AVG(CASE WHEN t.resolved_at IS NOT NULL THEN (julianday(t.resolved_at) - julianday(t.created_at)) * 24 * 60 END))';

// ---------- shared ticket-level row query ----------
const TICKET_SQL = `
  SELECT t.id, t.ticket_number, t.title, t.status, t.created_at, t.resolved_at, t.closed_at, t.reopen_count,
    req.full_name AS requester, ag.full_name AS agent, c.name AS category, sc.name AS subcategory,
    p.code AS priority, g.name AS support_group,
    CASE WHEN t.resolved_at IS NOT NULL THEN ROUND((julianday(t.resolved_at) - julianday(t.created_at)) * 24 * 60) END AS resolution_minutes,
    ROUND(julianday('now') - julianday(t.created_at), 1) AS age_days,
    s.resolution_breached AS sla_breached, s.resolution_due_at AS sla_due
  FROM tickets t
  JOIN users req ON req.id = t.requester_id
  LEFT JOIN users ag ON ag.id = t.assigned_agent_id
  JOIN categories c ON c.id = t.category_id
  LEFT JOIN subcategories sc ON sc.id = t.subcategory_id
  JOIN priorities p ON p.id = t.priority_id
  LEFT JOIN support_groups g ON g.id = t.support_group_id
  LEFT JOIN ticket_sla s ON s.ticket_id = t.id`;
const MAX_DETAIL_ROWS = 5000;
const ticketRows = (where, params, order = 't.created_at DESC') =>
  db.prepare(`${TICKET_SQL} WHERE ${where} ORDER BY ${order} LIMIT ${MAX_DETAIL_ROWS}`).all(params);

const TICKET_COLS = [
  { key: 'ticket_number', label: 'Ticket' }, { key: 'title', label: 'Short description', wide: true },
  { key: 'requester', label: 'Requester' }, { key: 'category', label: 'Category' }, { key: 'subcategory', label: 'Subcategory' },
  { key: 'priority', label: 'Priority' }, { key: 'status', label: 'Status' }, { key: 'agent', label: 'Assigned to' },
  { key: 'support_group', label: 'Support group' }, { key: 'created_at', label: 'Created (UTC)' },
];
const mapTicket = (r) => ({
  ...r, status: STATUS_LABEL[r.status] || r.status, agent: r.agent || 'Unassigned', support_group: r.support_group || '—',
  subcategory: r.subcategory || '—', created_at: dt(r.created_at), resolved_at: dt(r.resolved_at), closed_at: dt(r.closed_at),
  resolution_time: fmtMin(r.resolution_minutes), sla: r.sla_breached ? 'Breached' : r.sla_due ? 'Within SLA' : '—',
});

const count = (where, params) => db.prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE ${where}`).get(params).n;

// ---------- report registry ----------
const REPORTS = {
  summary: {
    title: 'Ticket summary', group: 'Summary',
    description: 'Headline numbers for the period: created, resolved, open, response and resolution times, SLA.',
    build(c) {
      const k = D.kpis(c); const s = D.sla(c); const svc = D.serviceMetrics(c);
      const closed = count(`${c.base} AND t.closed_at IS NOT NULL AND t.closed_at >= @fromTs AND t.closed_at < @toTsExcl`, c.params);
      const openNow = count(`${c.created} AND t.status IN ${OPEN}`, c.params);
      const unassigned = count(`${c.created} AND t.assigned_agent_id IS NULL AND t.status IN ${OPEN}`, c.params);
      const reopened = count(`${c.created} AND t.reopen_count > 0`, c.params);
      const rows = [
        ['Tickets created', k.total.value], ['Tickets resolved', k.resolved.value], ['Tickets closed', closed],
        ['Still open (of those created)', openNow], ['Unassigned and open', unassigned], ['Reopened at least once', reopened],
        ['Average resolution time', fmtMin(k.avg_resolution_minutes.value)],
        ['Average first response', fmtMin(svc.first_response_minutes)],
        ['First-contact resolution', svc.fcr.pct != null ? `${svc.fcr.pct}%` : '—'],
        ['SLA compliance', s.available ? `${s.compliance_pct}%` : 'No SLA data'],
        ['SLA breaches (resolution)', s.available ? s.breached : '—'],
        ['SLA breaches (response)', s.available ? svc.response_breached : '—'],
        ['Previous period: tickets created', k.total.previous], ['Previous period: tickets resolved', k.resolved.previous],
      ].map(([metric, value]) => ({ metric, value }));
      return {
        summary: [
          { label: 'Created', value: k.total.value }, { label: 'Resolved', value: k.resolved.value },
          { label: 'Still open', value: openNow }, { label: 'Avg resolution', value: fmtMin(k.avg_resolution_minutes.value) },
        ],
        columns: [{ key: 'metric', label: 'Metric', wide: true }, { key: 'value', label: 'Value', align: 'right' }],
        rows,
      };
    },
  },
  status: {
    title: 'Tickets by status', group: 'Breakdowns', description: 'How many tickets created in the period sit in each status today.',
    build(c) {
      const rows = D.byStatus(c);
      const total = rows.reduce((s, r) => s + r.n, 0);
      return {
        summary: [{ label: 'Tickets', value: total }, { label: 'Open', value: rows.filter((r) => !['RESOLVED', 'CLOSED'].includes(r.status)).reduce((s, r) => s + r.n, 0) }],
        columns: [{ key: 'status', label: 'Status', wide: true }, { key: 'n', label: 'Tickets', align: 'right' }, { key: 'pct', label: '% of total', align: 'right' }],
        rows: rows.map((r) => ({ status: STATUS_LABEL[r.status], n: r.n, pct: pctOf(r.n, total) })),
        totals: { status: 'Total', n: total, pct: total ? '100%' : '—' },
      };
    },
  },
  priority: {
    title: 'Tickets by priority', group: 'Breakdowns', description: 'Volume, open/resolved split and resolution time per priority.',
    build(c) {
      const rows = db.prepare(`
        SELECT p.code, p.label, COUNT(t.id) AS n,
          SUM(CASE WHEN t.status IN ${OPEN} THEN 1 ELSE 0 END) AS open,
          SUM(CASE WHEN t.status IN ('RESOLVED','CLOSED') THEN 1 ELSE 0 END) AS resolved, ${mttr} AS avg_min
        FROM priorities p LEFT JOIN tickets t ON t.priority_id = p.id AND ${c.created}
        GROUP BY p.id ORDER BY p.sort`).all(c.params);
      const total = rows.reduce((s, r) => s + r.n, 0);
      return {
        summary: [{ label: 'Tickets', value: total }, { label: 'P1 critical', value: rows.find((r) => r.code === 'P1')?.n ?? 0 }],
        columns: [{ key: 'priority', label: 'Priority', wide: true }, { key: 'n', label: 'Tickets', align: 'right' }, { key: 'pct', label: '% of total', align: 'right' },
          { key: 'open', label: 'Open', align: 'right' }, { key: 'resolved', label: 'Resolved', align: 'right' }, { key: 'avg', label: 'Avg resolution', align: 'right' }],
        rows: rows.map((r) => ({ priority: `${r.code} — ${r.label}`, n: r.n, pct: pctOf(r.n, total), open: r.open || 0, resolved: r.resolved || 0, avg: fmtMin(r.avg_min) })),
        totals: { priority: 'Total', n: total, pct: total ? '100%' : '—', open: rows.reduce((s, r) => s + (r.open || 0), 0), resolved: rows.reduce((s, r) => s + (r.resolved || 0), 0), avg: '' },
      };
    },
  },
  category: {
    title: 'Tickets by category', group: 'Breakdowns', description: 'Which categories generate the most tickets, with open/resolved split.',
    build(c) {
      const rows = db.prepare(`
        SELECT c.name AS category, COUNT(*) AS n,
          SUM(CASE WHEN t.status IN ${OPEN} THEN 1 ELSE 0 END) AS open,
          SUM(CASE WHEN t.status IN ('RESOLVED','CLOSED') THEN 1 ELSE 0 END) AS resolved, ${mttr} AS avg_min
        FROM tickets t JOIN categories c ON c.id = t.category_id WHERE ${c.created}
        GROUP BY c.id ORDER BY n DESC, c.name`).all(c.params);
      const total = rows.reduce((s, r) => s + r.n, 0);
      return {
        summary: [{ label: 'Tickets', value: total }, { label: 'Categories', value: rows.length }, { label: 'Top category', value: rows[0]?.category || '—' }],
        columns: [{ key: 'category', label: 'Category', wide: true }, { key: 'n', label: 'Tickets', align: 'right' }, { key: 'pct', label: '% of total', align: 'right' },
          { key: 'open', label: 'Open', align: 'right' }, { key: 'resolved', label: 'Resolved', align: 'right' }, { key: 'avg', label: 'Avg resolution', align: 'right' }],
        rows: rows.map((r) => ({ ...r, pct: pctOf(r.n, total), avg: fmtMin(r.avg_min) })),
        totals: { category: 'Total', n: total, pct: total ? '100%' : '—', open: rows.reduce((s, r) => s + r.open, 0), resolved: rows.reduce((s, r) => s + r.resolved, 0), avg: '' },
      };
    },
  },
  subcategory: {
    title: 'Tickets by subcategory', group: 'Breakdowns', description: 'Category / subcategory pairs ranked by ticket count.',
    build(c) {
      const rows = db.prepare(`
        SELECT c.name AS category, COALESCE(sc.name, '(no subcategory)') AS subcategory, COUNT(*) AS n,
          SUM(CASE WHEN t.status IN ${OPEN} THEN 1 ELSE 0 END) AS open,
          SUM(CASE WHEN t.status IN ('RESOLVED','CLOSED') THEN 1 ELSE 0 END) AS resolved
        FROM tickets t JOIN categories c ON c.id = t.category_id LEFT JOIN subcategories sc ON sc.id = t.subcategory_id
        WHERE ${c.created} GROUP BY c.id, sc.id ORDER BY n DESC, c.name, subcategory`).all(c.params);
      const total = rows.reduce((s, r) => s + r.n, 0);
      return {
        summary: [{ label: 'Tickets', value: total }, { label: 'Subcategories', value: rows.length }],
        columns: [{ key: 'category', label: 'Category' }, { key: 'subcategory', label: 'Subcategory', wide: true }, { key: 'n', label: 'Tickets', align: 'right' },
          { key: 'pct', label: '% of total', align: 'right' }, { key: 'open', label: 'Open', align: 'right' }, { key: 'resolved', label: 'Resolved', align: 'right' }],
        rows: rows.map((r) => ({ ...r, pct: pctOf(r.n, total) })),
        totals: { category: 'Total', subcategory: '', n: total, pct: total ? '100%' : '—', open: rows.reduce((s, r) => s + r.open, 0), resolved: rows.reduce((s, r) => s + r.resolved, 0) },
      };
    },
  },
  group: {
    title: 'Tickets by support group', group: 'Breakdowns', description: 'Workload and SLA breaches per support group, plus tickets not yet routed.',
    build(c) {
      const rows = db.prepare(`
        SELECT g.name AS support_group, COUNT(t.id) AS n,
          SUM(CASE WHEN t.status IN ${OPEN} THEN 1 ELSE 0 END) AS open,
          SUM(CASE WHEN t.status IN ('RESOLVED','CLOSED') THEN 1 ELSE 0 END) AS resolved,
          SUM(CASE WHEN s.resolution_breached = 1 THEN 1 ELSE 0 END) AS breached, ${mttr} AS avg_min
        FROM support_groups g LEFT JOIN tickets t ON t.support_group_id = g.id AND ${c.created}
        LEFT JOIN ticket_sla s ON s.ticket_id = t.id
        WHERE g.active = 1 GROUP BY g.id ORDER BY n DESC, g.name`).all(c.params);
      const un = db.prepare(`
        SELECT COUNT(*) AS n, SUM(CASE WHEN t.status IN ${OPEN} THEN 1 ELSE 0 END) AS open,
          SUM(CASE WHEN t.status IN ('RESOLVED','CLOSED') THEN 1 ELSE 0 END) AS resolved,
          SUM(CASE WHEN s.resolution_breached = 1 THEN 1 ELSE 0 END) AS breached, ${mttr} AS avg_min
        FROM tickets t LEFT JOIN ticket_sla s ON s.ticket_id = t.id WHERE ${c.created} AND t.support_group_id IS NULL`).get(c.params);
      if (un.n) rows.push({ support_group: 'Not routed to a group', ...un });
      const total = rows.reduce((s, r) => s + r.n, 0);
      return {
        summary: [{ label: 'Tickets', value: total }, { label: 'Groups', value: rows.filter((r) => r.n > 0 && r.support_group !== 'Not routed to a group').length }],
        columns: [{ key: 'support_group', label: 'Support group', wide: true }, { key: 'n', label: 'Tickets', align: 'right' }, { key: 'open', label: 'Open', align: 'right' },
          { key: 'resolved', label: 'Resolved', align: 'right' }, { key: 'breached', label: 'SLA breached', align: 'right' }, { key: 'avg', label: 'Avg resolution', align: 'right' }],
        rows: rows.map((r) => ({ ...r, open: r.open || 0, resolved: r.resolved || 0, breached: r.breached || 0, avg: fmtMin(r.avg_min) })),
        totals: { support_group: 'Total', n: total, open: rows.reduce((s, r) => s + (r.open || 0), 0), resolved: rows.reduce((s, r) => s + (r.resolved || 0), 0), breached: rows.reduce((s, r) => s + (r.breached || 0), 0), avg: '' },
      };
    },
  },
  agent: {
    title: 'Agent performance', group: 'Breakdowns', description: 'Assigned, open and resolved tickets and average resolution time per agent.',
    build(c) {
      const w = D.agentWorkload(c);
      const rows = w.agents.map((a) => ({ agent: a.agent, assigned: a.assigned, open: a.open || 0, resolved: a.resolved || 0, rate: pctOf(a.resolved || 0, a.assigned), avg: fmtMin(a.avg_mttr_minutes) }));
      if (w.unassigned.assigned) rows.push({ agent: 'Unassigned', assigned: w.unassigned.assigned, open: w.unassigned.open, resolved: 0, rate: '—', avg: '—' });
      const total = rows.reduce((s, r) => s + r.assigned, 0);
      return {
        summary: [{ label: 'Tickets', value: total }, { label: 'Agents active', value: w.agents.length }, { label: 'Unassigned', value: w.unassigned.assigned }],
        columns: [{ key: 'agent', label: 'Agent', wide: true }, { key: 'assigned', label: 'Assigned', align: 'right' }, { key: 'open', label: 'Open', align: 'right' },
          { key: 'resolved', label: 'Resolved', align: 'right' }, { key: 'rate', label: 'Resolution rate', align: 'right' }, { key: 'avg', label: 'Avg resolution', align: 'right' }],
        rows,
        totals: { agent: 'Total', assigned: total, open: rows.reduce((s, r) => s + r.open, 0), resolved: rows.reduce((s, r) => s + r.resolved, 0), rate: '', avg: '' },
      };
    },
  },
  sla: {
    title: 'SLA compliance', group: 'Service levels', description: 'Resolution-SLA outcome per priority: within, at risk and breached.',
    build(c) {
      const s = D.sla(c);
      const rows = D.slaByPriority(c).map((p) => ({ priority: `${p.code} — ${p.label}`, tracked: p.tracked, within: p.within, at_risk: p.at_risk, breached: p.breached, compliance: p.compliance_pct != null ? `${p.compliance_pct}%` : '—' }));
      return {
        note: !s.available ? s.message : null,
        summary: [{ label: 'Compliance', value: s.available ? `${s.compliance_pct}%` : '—' }, { label: 'Tracked', value: s.tracked }, { label: 'Breached', value: s.breached }, { label: 'At risk', value: s.at_risk }],
        columns: [{ key: 'priority', label: 'Priority', wide: true }, { key: 'tracked', label: 'Tracked', align: 'right' }, { key: 'within', label: 'Within SLA', align: 'right' },
          { key: 'at_risk', label: 'At risk', align: 'right' }, { key: 'breached', label: 'Breached', align: 'right' }, { key: 'compliance', label: 'Compliance', align: 'right' }],
        rows,
        totals: { priority: 'Total', tracked: s.tracked, within: s.within, at_risk: s.at_risk, breached: s.breached, compliance: s.available ? `${s.compliance_pct}%` : '—' },
      };
    },
  },
  aging: {
    title: 'Ticket aging', group: 'Service levels', description: 'Open tickets grouped by how long they have been open, with the oldest tickets listed.',
    build(c) {
      const buckets = D.aging(c);
      const total = buckets.reduce((s, b) => s + b.n, 0);
      const oldest = ticketRows(`${c.base} AND t.status IN ${OPEN}`, c.params, 't.created_at ASC').slice(0, 25).map(mapTicket);
      return {
        summary: [{ label: 'Open tickets', value: total }, { label: 'Older than 7 days', value: buckets[3].n }],
        columns: [{ key: 'bucket', label: 'Age', wide: true }, { key: 'n', label: 'Open tickets', align: 'right' }, { key: 'pct', label: '% of open', align: 'right' }],
        rows: buckets.map((b) => ({ bucket: b.label, n: b.n, pct: pctOf(b.n, total) })),
        totals: { bucket: 'Total open', n: total, pct: total ? '100%' : '—' },
        extra: oldest.length ? {
          title: 'Oldest open tickets',
          columns: [{ key: 'ticket_number', label: 'Ticket' }, { key: 'title', label: 'Short description', wide: true }, { key: 'priority', label: 'Priority' },
            { key: 'status', label: 'Status' }, { key: 'agent', label: 'Assigned to' }, { key: 'age_days', label: 'Age (days)', align: 'right' }],
          rows: oldest,
        } : null,
      };
    },
  },
  daily: {
    title: 'Daily ticket volume', group: 'Trends', description: 'Tickets created and resolved per day, with the open backlog at the end of each day.',
    build(c, f) {
      const t = D.trend(c, f).points;
      const backlog = f.bucket === 'hour' ? null : new Map(D.backlogSeries(c, f).points.map((p) => [p.key, p.open]));
      const rows = t.map((p) => ({ day: p.label, created: p.created, resolved: p.resolved, net: p.created - p.resolved, backlog: backlog ? backlog.get(p.key) ?? '' : '' }));
      return {
        summary: [{ label: 'Created', value: rows.reduce((s, r) => s + r.created, 0) }, { label: 'Resolved', value: rows.reduce((s, r) => s + r.resolved, 0) },
          { label: 'Busiest day', value: rows.reduce((b, r) => (r.created > (b?.created ?? -1) ? r : b), null)?.day || '—' }],
        columns: [{ key: 'day', label: f.bucket === 'hour' ? 'Hour' : 'Date', wide: true }, { key: 'created', label: 'Created', align: 'right' },
          { key: 'resolved', label: 'Resolved', align: 'right' }, { key: 'net', label: 'Net change', align: 'right' }, { key: 'backlog', label: 'Open at end of day', align: 'right' }],
        rows,
        totals: { day: 'Total', created: rows.reduce((s, r) => s + r.created, 0), resolved: rows.reduce((s, r) => s + r.resolved, 0), net: rows.reduce((s, r) => s + r.net, 0), backlog: '' },
      };
    },
  },
  tickets: {
    title: 'Ticket list', group: 'Detail', description: 'One row per ticket created in the period, with assignment, timestamps and resolution time.',
    build(c) {
      const rows = ticketRows(c.created, c.params).map(mapTicket);
      return {
        summary: [{ label: 'Tickets', value: rows.length }, { label: 'Resolved', value: rows.filter((r) => r.resolved_at).length }],
        columns: [...TICKET_COLS, { key: 'resolved_at', label: 'Resolved (UTC)' }, { key: 'resolution_time', label: 'Resolution time', align: 'right' }, { key: 'sla', label: 'SLA' }, { key: 'reopen_count', label: 'Reopens', align: 'right' }],
        rows,
      };
    },
  },
  resolved: {
    title: 'Resolved tickets', group: 'Detail', description: 'Tickets resolved in the period (by resolution date), with who resolved them and how long it took.',
    build(c) {
      const rows = ticketRows(c.resolved, c.params, 't.resolved_at DESC').map(mapTicket);
      const avg = rows.length ? rows.reduce((s, r) => s + (r.resolution_minutes || 0), 0) / rows.length : null;
      return {
        summary: [{ label: 'Resolved', value: rows.length }, { label: 'Avg resolution', value: fmtMin(avg) }, { label: 'SLA breached', value: rows.filter((r) => r.sla === 'Breached').length }],
        columns: [{ key: 'ticket_number', label: 'Ticket' }, { key: 'title', label: 'Short description', wide: true }, { key: 'category', label: 'Category' },
          { key: 'priority', label: 'Priority' }, { key: 'agent', label: 'Resolved by' }, { key: 'support_group', label: 'Support group' },
          { key: 'created_at', label: 'Created (UTC)' }, { key: 'resolved_at', label: 'Resolved (UTC)' }, { key: 'resolution_time', label: 'Resolution time', align: 'right' }, { key: 'sla', label: 'SLA' }],
        rows,
      };
    },
  },
  open: {
    title: 'Open tickets', group: 'Detail', description: 'Tickets created in the period that are still open, oldest first, with their current age.',
    build(c) {
      const rows = ticketRows(`${c.created} AND t.status IN ${OPEN}`, c.params, 't.created_at ASC').map(mapTicket);
      return {
        summary: [{ label: 'Open', value: rows.length }, { label: 'Unassigned', value: rows.filter((r) => r.agent === 'Unassigned').length }, { label: 'Older than 7 days', value: rows.filter((r) => r.age_days > 7).length }],
        columns: [{ key: 'ticket_number', label: 'Ticket' }, { key: 'title', label: 'Short description', wide: true }, { key: 'category', label: 'Category' },
          { key: 'priority', label: 'Priority' }, { key: 'status', label: 'Status' }, { key: 'agent', label: 'Assigned to' }, { key: 'support_group', label: 'Support group' },
          { key: 'created_at', label: 'Created (UTC)' }, { key: 'age_days', label: 'Age (days)', align: 'right' }, { key: 'sla', label: 'SLA' }],
        rows,
      };
    },
  },
};

function catalog() {
  return Object.entries(REPORTS).map(([key, r]) => ({ key, title: r.title, group: r.group, description: r.description }));
}

// ---------- build a report (JSON shape shared by every format) ----------
function filterLabels(f) {
  const name = (table, id) => (id != null ? db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id)?.name : null);
  const prio = f.priority_id != null ? db.prepare('SELECT code, label FROM priorities WHERE id = ?').get(f.priority_id) : null;
  return {
    team: f.group_id != null ? name('support_groups', f.group_id) || `#${f.group_id}` : 'All teams',
    category: f.category_id != null ? name('categories', f.category_id) || `#${f.category_id}` : 'All categories',
    priority: prio ? `${prio.code} — ${prio.label}` : 'All priorities',
    status: f.status ? STATUS_LABEL[f.status] : 'All statuses',
    scope: f.scope === 'all' ? 'All teams' : 'Own team',
  };
}

const fmtDay = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function buildReport(user, query) {
  const type = String(query.type || 'summary');
  const def = REPORTS[type];
  if (!def) throw Object.assign(new Error('Unknown report type'), { status: 400 });
  const f = D.resolveFilters(user, query);
  const c = D.buildClauses(f);
  const body = def.build(c, f);
  return {
    type, title: def.title, description: def.description,
    generated_at: new Date().toISOString(), generated_by: user.full_name,
    period: { from: f.from, to: f.to, days: f.days, label: f.from === f.to ? fmtDay(f.from) : `${fmtDay(f.from)} – ${fmtDay(f.to)}` },
    filters: filterLabels(f),
    note: body.note || null,
    summary: body.summary || [],
    columns: body.columns, rows: body.rows, totals: body.totals || null, extra: body.extra || null,
    row_count: body.rows.length,
    truncated: body.rows.length >= MAX_DETAIL_ROWS,
  };
}

// ---------- renderers ----------
const filtersLine = (rep) => `Team: ${rep.filters.team} · Priority: ${rep.filters.priority} · Category: ${rep.filters.category} · Status: ${rep.filters.status}`;

function toCsv(rep) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [
    [rep.title], [`Period: ${rep.period.label}`], [filtersLine(rep)], [`Generated: ${rep.generated_at} by ${rep.generated_by}`], [],
    rep.columns.map((c) => c.label), ...rep.rows.map((r) => rep.columns.map((c) => r[c.key])),
  ];
  if (rep.totals) lines.push(rep.columns.map((c) => rep.totals[c.key] ?? ''));
  if (rep.extra) lines.push([], [rep.extra.title], rep.extra.columns.map((c) => c.label), ...rep.extra.rows.map((r) => rep.extra.columns.map((c) => r[c.key])));
  return `﻿${lines.map((l) => l.map(esc).join(',')).join('\r\n')}`;
}

const BRAND = '4B3AE9';

async function toXlsx(rep) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Cars24 IT Service Desk';
  wb.created = new Date();
  const ws = wb.addWorksheet(rep.title.slice(0, 31), { views: [{ showGridLines: false }] });

  const addTable = (columns, rows, totals, startRow) => {
    const header = ws.getRow(startRow);
    header.values = columns.map((c) => c.label);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.alignment = { vertical: 'middle' };
    header.height = 20;
    columns.forEach((c, i) => {
      const cell = header.getCell(i + 1);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${BRAND}` } };
      cell.alignment = { horizontal: c.align === 'right' ? 'right' : 'left', vertical: 'middle' };
    });
    rows.forEach((r, ri) => {
      const row = ws.getRow(startRow + 1 + ri);
      row.values = columns.map((c) => r[c.key] ?? '');
      columns.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        cell.alignment = { horizontal: c.align === 'right' ? 'right' : 'left', vertical: 'top', wrapText: !!c.wide };
        cell.border = { bottom: { style: 'hair', color: { argb: 'FFE4E4F0' } } };
        if (ri % 2) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F8FD' } };
      });
    });
    let end = startRow + rows.length;
    if (totals) {
      end += 1;
      const row = ws.getRow(end);
      row.values = columns.map((c) => totals[c.key] ?? '');
      row.font = { bold: true };
      columns.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        cell.alignment = { horizontal: c.align === 'right' ? 'right' : 'left' };
        cell.border = { top: { style: 'thin', color: { argb: `FF${BRAND}` } } };
      });
    }
    ws.autoFilter = { from: { row: startRow, column: 1 }, to: { row: startRow, column: columns.length } };
    return end;
  };

  ws.getCell('A1').value = rep.title;
  ws.getCell('A1').font = { bold: true, size: 16, color: { argb: `FF${BRAND}` } };
  ws.getCell('A2').value = `Period: ${rep.period.label}`;
  ws.getCell('A3').value = filtersLine(rep);
  ws.getCell('A4').value = `Generated ${rep.generated_at.replace('T', ' ').slice(0, 16)} UTC by ${rep.generated_by} · Cars24 IT Service Desk`;
  ['A2', 'A3', 'A4'].forEach((a) => { ws.getCell(a).font = { color: { argb: 'FF545470' }, size: 10 }; });
  let r = 6;
  if (rep.summary.length) {
    ws.getRow(r).values = rep.summary.map((s) => s.label);
    ws.getRow(r).font = { bold: true, size: 9, color: { argb: 'FF8A8AA6' } };
    ws.getRow(r + 1).values = rep.summary.map((s) => s.value);
    ws.getRow(r + 1).font = { bold: true, size: 14 };
    r += 3;
  }
  if (rep.note) { ws.getCell(`A${r}`).value = rep.note; ws.getCell(`A${r}`).font = { italic: true, color: { argb: 'FF8A8AA6' } }; r += 2; }
  let end = addTable(rep.columns, rep.rows, rep.totals, r);
  if (rep.extra) {
    end += 2;
    ws.getCell(`A${end}`).value = rep.extra.title;
    ws.getCell(`A${end}`).font = { bold: true, size: 12 };
    addTable(rep.extra.columns, rep.extra.rows, null, end + 1);
  }
  const allCols = rep.extra ? Math.max(rep.columns.length, rep.extra.columns.length) : rep.columns.length;
  for (let i = 1; i <= allCols; i++) {
    const c = rep.columns[i - 1];
    let max = c ? c.label.length : 10;
    ws.eachRow({ includeEmpty: false }, (row, n) => { if (n > 5) max = Math.max(max, String(row.getCell(i).value ?? '').length); });
    ws.getColumn(i).width = Math.min(c?.wide ? 60 : 28, Math.max(10, max + 2));
  }
  ws.views = [{ state: 'frozen', ySplit: rep.summary.length ? r : r, showGridLines: false }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Natural column widths in points for 8.5pt Helvetica: wide enough for the
// longest header word and typical content, so short columns never wrap
// mid-word. Wide (free-text) columns absorb the remaining space.
const PDF_FONT = 8.5;
const PDF_PAD = 4;
function pdfWidths(columns, rows, available) {
  const charW = PDF_FONT * 0.52;
  // floor = longest single word in the header or content (never break a word);
  // natural = comfortable width for typical content.
  const floors = [];
  const natural = columns.map((c) => {
    const words = [c.label, ...rows.slice(0, 300).map((r) => String(r[c.key] ?? ''))].flatMap((s) => s.split(/\s+/));
    const longestWord = Math.min(c.wide ? 24 : 14, Math.max(1, ...words.map((w) => w.length)));
    floors.push(longestWord * charW + PDF_PAD * 2 + 2);
    const content = rows.slice(0, 300).reduce((m, r) => Math.max(m, String(r[c.key] ?? '').length), 0);
    const chars = Math.max(longestWord, Math.min(content, c.wide ? 42 : 17));
    return chars * charW + PDF_PAD * 2 + 2;
  });
  const total = natural.reduce((s, w) => s + w, 0);
  if (total <= available) {
    const wide = columns.map((c, i) => (c.wide ? i : -1)).filter((i) => i >= 0);
    const extra = available - total;
    if (wide.length) wide.forEach((i) => { natural[i] += extra / wide.length; });
    else natural.forEach((_, i) => { natural[i] += extra / natural.length; });
    return { widths: natural, fits: true };
  }
  // Too wide: shrink only the slack above each column's floor.
  const sumFloor = floors.reduce((s, w) => s + w, 0);
  if (sumFloor >= available) return { widths: floors.map((w) => (w / sumFloor) * available), fits: false };
  const k = (available - sumFloor) / (total - sumFloor);
  return { widths: natural.map((w, i) => floors[i] + (w - floors[i]) * k), fits: false };
}

function toPdf(rep) {
  return new Promise((resolve, reject) => {
    // Portrait unless the columns need more room than a portrait page offers.
    const portraitW = 595.28 - 72;
    const landscape = !pdfWidths(rep.columns, rep.rows, portraitW).fits
      || (rep.extra && !pdfWidths(rep.extra.columns, rep.extra.rows, portraitW).fits);
    const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 36, bufferPages: true,
      info: { Title: rep.title, Author: 'Cars24 IT Service Desk' } });
    const chunks = [];
    doc.on('data', (d) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const left = doc.page.margins.left;
    const bottom = () => doc.page.height - doc.page.margins.bottom - 18;

    // Header
    doc.fillColor(`#${BRAND}`).font('Helvetica-Bold').fontSize(18).text(rep.title, left, 36);
    doc.moveDown(0.2);
    doc.fillColor('#545470').font('Helvetica').fontSize(9.5)
      .text(`Period: ${rep.period.label}`)
      .text(filtersLine(rep))
      .text(`Generated ${rep.generated_at.replace('T', ' ').slice(0, 16)} UTC by ${rep.generated_by} · Cars24 IT Service Desk`);
    doc.moveDown(0.6);

    // Summary tiles
    if (rep.summary.length) {
      const tw = Math.min(150, W / rep.summary.length);
      const y = doc.y;
      rep.summary.forEach((s, i) => {
        const x = left + i * tw;
        doc.roundedRect(x, y, tw - 8, 44, 6).fillAndStroke('#F8F8FD', '#E4E4F0');
        doc.fillColor('#8A8AA6').font('Helvetica').fontSize(8).text(s.label.toUpperCase(), x + 8, y + 7, { width: tw - 24 });
        doc.fillColor('#1C1C2E').font('Helvetica-Bold').fontSize(14).text(String(s.value), x + 8, y + 20, { width: tw - 24 });
      });
      doc.y = y + 56;
    }
    if (rep.note) { doc.fillColor('#8A8AA6').font('Helvetica-Oblique').fontSize(9.5).text(rep.note, left, doc.y, { width: W }); doc.moveDown(0.6); }

    const drawTable = (columns, rows, totals) => {
      const { widths } = pdfWidths(columns, rows, W);
      const pad = PDF_PAD;
      const cellH = (text, w, size) => { doc.fontSize(size); return doc.heightOfString(String(text ?? ''), { width: w - pad * 2 }) + pad * 2; };

      const header = () => {
        const y = doc.y;
        const h = Math.max(...columns.map((c, i) => cellH(c.label, widths[i], 8.5)));
        doc.rect(left, y, W, h).fill(`#${BRAND}`);
        let x = left;
        columns.forEach((c, i) => {
          doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8.5)
            .text(c.label, x + pad, y + pad, { width: widths[i] - pad * 2, align: c.align === 'right' ? 'right' : 'left' });
          x += widths[i];
        });
        doc.y = y + h;
      };
      const line = (r, bold, zebra) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
        const h = Math.max(...columns.map((c, i) => cellH(r[c.key], widths[i], 8.5)));
        if (doc.y + h > bottom()) { doc.addPage(); header(); }
        const y = doc.y;
        if (zebra) doc.rect(left, y, W, h).fill('#F8F8FD');
        if (bold) doc.moveTo(left, y).lineTo(left + W, y).lineWidth(0.8).stroke(`#${BRAND}`);
        let x = left;
        columns.forEach((c, i) => {
          doc.fillColor('#1C1C2E').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5)
            .text(String(r[c.key] ?? ''), x + pad, y + pad, { width: widths[i] - pad * 2, align: c.align === 'right' ? 'right' : 'left' });
          x += widths[i];
        });
        doc.moveTo(left, y + h).lineTo(left + W, y + h).lineWidth(0.3).stroke('#E4E4F0');
        doc.y = y + h;
      };
      header();
      if (rows.length === 0) { doc.fillColor('#8A8AA6').font('Helvetica-Oblique').fontSize(9).text('No data for the selected period and filters.', left, doc.y + 6); doc.moveDown(1); }
      rows.forEach((r, i) => line(r, false, i % 2 === 1));
      if (totals) line(totals, true, false);
    };

    drawTable(rep.columns, rep.rows, rep.totals);
    if (rep.extra) {
      doc.moveDown(1.2);
      if (doc.y + 60 > bottom()) doc.addPage();
      doc.fillColor('#1C1C2E').font('Helvetica-Bold').fontSize(12).text(rep.extra.title, left, doc.y);
      doc.moveDown(0.4);
      drawTable(rep.extra.columns, rep.extra.rows, null);
    }

    // Footer with page numbers. The bottom margin is lifted while writing so
    // pdfkit never treats the footer line as overflow and adds a blank page.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const savedBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const fy = doc.page.height - savedBottom + 8;
      doc.fillColor('#8A8AA6').font('Helvetica').fontSize(8)
        .text(`${rep.title} · ${rep.period.label}`, left, fy, { width: W / 2, lineBreak: false })
        .text(`Page ${i - range.start + 1} of ${range.count}`, left + W / 2, fy, { width: W / 2, align: 'right', lineBreak: false });
      doc.page.margins.bottom = savedBottom;
    }
    doc.end();
  });
}

const FORMATS = {
  csv: { mime: 'text/csv; charset=utf-8', ext: 'csv', render: async (rep) => Buffer.from(toCsv(rep), 'utf8') },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx', render: toXlsx },
  pdf: { mime: 'application/pdf', ext: 'pdf', render: toPdf },
};

async function renderReport(rep, format) {
  const f = FORMATS[format];
  if (!f) throw Object.assign(new Error('Unknown export format'), { status: 400 });
  const buffer = await f.render(rep);
  const filename = `${rep.type}-report_${rep.period.from}_${rep.period.to}.${f.ext}`;
  return { buffer, mime: f.mime, filename };
}

module.exports = { REPORTS, catalog, buildReport, renderReport, FORMATS };
