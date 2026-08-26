const { db } = require('./db');
const { fromSql } = require('./calendar');

// ================= Predictive SLA & advanced analytics (BRD 8.12/8.13) =================
// Statistical models over the ticket history — deterministic, no external AI.

// Historical resolution-SLA breach rate for a priority (Laplace-smoothed).
function historicalBreachRate(priorityId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN s.resolution_breached = 1 THEN 1 ELSE 0 END) AS breached
    FROM ticket_sla s JOIN tickets t ON t.id = s.ticket_id
    WHERE t.priority_id = ? AND s.completed_at IS NOT NULL`).get(priorityId);
  return (Number(row.breached || 0) + 1) / (Number(row.total || 0) + 4);
}

// Per-ticket probability of missing the resolution SLA.
function breachProbability(ticket, sla) {
  if (!sla || !sla.resolution_due_at) return null;
  if (sla.resolution_breached) return 100;
  if (sla.completed_at) return 0;

  const base = historicalBreachRate(ticket.priority_id);

  // Elapsed fraction of the SLA window (paused clock keeps due date moving).
  const created = fromSql(ticket.created_at).getTime();
  const due = fromSql(sla.resolution_due_at).getTime();
  const span = Math.max(due - created, 60000);
  const elapsed = Math.min(Math.max((Date.now() - created) / span, 0), 1.2);

  // Load factor: open tickets per active agent in the assignment group.
  let load = 0.5;
  if (ticket.support_group_id) {
    const open = db.prepare(`SELECT COUNT(*) AS n FROM tickets
      WHERE support_group_id = ? AND status NOT IN ('RESOLVED','CLOSED')`).get(ticket.support_group_id).n;
    const agents = db.prepare(`SELECT COUNT(*) AS n FROM users
      WHERE support_group_id = ? AND active = 1 AND role IN ('AGENT','TEAM_LEAD')`).get(ticket.support_group_id).n;
    load = agents ? Math.min(open / (agents * 5), 1) : 0.8;
  }
  const unassigned = ticket.assigned_agent_id ? 0 : 0.15;

  let p = base * 0.35 + elapsed * 0.45 + load * 0.15 + unassigned;
  if (sla.warning_sent) p = Math.max(p, 0.6);
  return Math.round(Math.min(Math.max(p, 0.02), 0.98) * 100);
}

function recommendations(prob, ticket) {
  if (prob == null || prob < 50) return [];
  const recs = [];
  if (!ticket.assigned_agent_id) recs.push('Assign an agent now');
  recs.push('Escalate to the group team lead');
  if (prob >= 70) recs.push('Reassign to a less-loaded agent or add an additional agent');
  if (prob >= 85 && ticket.priority_id > 1) recs.push('Consider increasing priority (authorized users)');
  return recs;
}

// Open tickets ranked by predicted breach risk.
function slaRiskList(limit = 25) {
  const rows = db.prepare(`
    SELECT t.*, s.resolution_due_at, s.resolution_breached, s.completed_at, s.warning_sent,
      p.code AS priority_code
    FROM tickets t
    JOIN ticket_sla s ON s.ticket_id = t.id
    JOIN priorities p ON p.id = t.priority_id
    WHERE t.status NOT IN ('RESOLVED','CLOSED') AND s.completed_at IS NULL`).all();
  return rows.map((t) => {
    const prob = breachProbability(t, t);
    return {
      id: t.id, ticket_number: t.ticket_number, title: t.title, status: t.status,
      priority_code: t.priority_code, resolution_due_at: t.resolution_due_at,
      breach_probability: prob, recommendations: recommendations(prob, t),
    };
  }).filter((t) => t.breach_probability != null)
    .sort((a, b) => b.breach_probability - a.breach_probability)
    .slice(0, limit);
}

// ---------- Advanced analytics dashboards (BRD 8.13) ----------
function advancedAnalytics() {
  // Ticket volume forecast: average per weekday over the last 28 days → next 7 days.
  const daily = db.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS n FROM tickets
    WHERE julianday('now') - julianday(created_at) <= 28
    GROUP BY day`).all();
  const byWeekday = Array.from({ length: 7 }, () => ({ sum: 0, days: 0 }));
  for (const d of daily) {
    const wd = new Date(`${d.day}T00:00:00Z`).getUTCDay();
    byWeekday[wd].sum += d.n;
    byWeekday[wd].days += 1;
  }
  const forecast = [];
  const today = new Date();
  for (let i = 1; i <= 7; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    const wd = d.getUTCDay();
    const avgAll = daily.length ? daily.reduce((s, x) => s + x.n, 0) / Math.max(daily.length, 1) : 0;
    const expected = byWeekday[wd].days ? byWeekday[wd].sum / byWeekday[wd].days : avgAll;
    forecast.push({ day: d.toISOString().slice(0, 10), expected: Math.round(expected * 10) / 10 });
  }

  // Recurring issue prediction: subcategories trending up (last 14d vs previous 14d).
  const recurring = db.prepare(`
    SELECT c.name AS category, COALESCE(sc.name, '(none)') AS subcategory,
      SUM(CASE WHEN julianday('now') - julianday(t.created_at) <= 14 THEN 1 ELSE 0 END) AS recent,
      SUM(CASE WHEN julianday('now') - julianday(t.created_at) > 14
               AND julianday('now') - julianday(t.created_at) <= 28 THEN 1 ELSE 0 END) AS previous
    FROM tickets t
    JOIN categories c ON c.id = t.category_id
    LEFT JOIN subcategories sc ON sc.id = t.subcategory_id
    WHERE julianday('now') - julianday(t.created_at) <= 28
    GROUP BY c.id, sc.id
    HAVING recent >= 2 AND recent >= previous
    ORDER BY (recent - previous) DESC, recent DESC LIMIT 10`).all()
    .map((r) => ({ ...r, trend: r.previous ? `+${r.recent - r.previous}` : 'new' }));

  // Asset failure trends: assets with repeated incidents / repairs in 90 days.
  const assetFailures = db.prepare(`
    SELECT a.id, a.asset_tag, a.manufacturer, a.model, COUNT(t.id) AS incidents,
      (SELECT COUNT(*) FROM asset_history ah WHERE ah.asset_id = a.id AND ah.action = 'REPAIR') AS repairs
    FROM assets a JOIN tickets t ON t.asset_id = a.id
    WHERE julianday('now') - julianday(t.created_at) <= 90
    GROUP BY a.id HAVING incidents >= 2
    ORDER BY incidents DESC LIMIT 10`).all();

  // Agent workload (open now).
  const workload = db.prepare(`
    SELECT u.full_name AS agent, COUNT(t.id) AS open
    FROM users u LEFT JOIN tickets t
      ON t.assigned_agent_id = u.id AND t.status NOT IN ('RESOLVED','CLOSED')
    WHERE u.active = 1 AND u.role IN ('AGENT','TEAM_LEAD')
    GROUP BY u.id ORDER BY open DESC`).all();

  // Support team performance.
  const teams = db.prepare(`
    SELECT g.name AS team, COUNT(t.id) AS total,
      SUM(CASE WHEN t.status IN ('RESOLVED','CLOSED') THEN 1 ELSE 0 END) AS resolved,
      ROUND(AVG(CASE WHEN t.resolved_at IS NOT NULL
        THEN (julianday(t.resolved_at) - julianday(t.created_at)) * 24 * 60 END)) AS avg_mttr_minutes
    FROM support_groups g LEFT JOIN tickets t ON t.support_group_id = g.id
    WHERE g.active = 1 GROUP BY g.id`).all();

  // Cost analysis: fleet + repair exposure.
  const cost = {
    fleet_value: db.prepare('SELECT ROUND(SUM(purchase_cost), 2) AS v FROM assets WHERE active = 1').get().v || 0,
    assets_in_repair: db.prepare("SELECT COUNT(*) AS n FROM assets WHERE status = 'IN_REPAIR'").get().n,
    retired_value: db.prepare("SELECT ROUND(SUM(purchase_cost), 2) AS v FROM assets WHERE status = 'RETIRED'").get().v || 0,
    warranty_expired: db.prepare("SELECT COUNT(*) AS n FROM assets WHERE active = 1 AND warranty_until IS NOT NULL AND date(warranty_until) < date('now')").get().n,
  };

  // Resolution trend: weekly MTTR (minutes) over 12 weeks.
  const resolutionTrend = db.prepare(`
    SELECT strftime('%Y-%W', resolved_at) AS week,
      ROUND(AVG((julianday(resolved_at) - julianday(created_at)) * 24 * 60)) AS mttr_minutes,
      COUNT(*) AS resolved
    FROM tickets
    WHERE resolved_at IS NOT NULL AND julianday('now') - julianday(resolved_at) <= 84
    GROUP BY week ORDER BY week ASC`).all();

  // Customer satisfaction (from ticket_ratings).
  const sat = db.prepare(`SELECT COUNT(*) AS n, ROUND(AVG(score), 2) AS avg FROM ticket_ratings`).get();
  const satDist = db.prepare(`SELECT score, COUNT(*) AS n FROM ticket_ratings GROUP BY score ORDER BY score`).all();

  return {
    forecast, recurring, assetFailures, workload, teams, cost, resolutionTrend,
    satisfaction: { responses: sat.n || 0, average: sat.avg, distribution: satDist },
  };
}

module.exports = { breachProbability, slaRiskList, advancedAnalytics, recommendations };
