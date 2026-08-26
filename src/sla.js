const { db } = require('./db');
const { audit, ticketHistory, notifyUser } = require('./services');
const { addBusinessMinutes, addPlainMinutes, fromSql, toSql, nowSql } = require('./calendar');

// ================= SLA engine (BRD 7.4) =================
// Response SLA  : met when first response (assignment or first IT comment) recorded.
// Resolution SLA: met when ticket reaches RESOLVED.
// PENDING pauses the clock (SLA pause/resume); due dates shift by pause duration.
// Sweep marks warnings (<= 30 business-min or 20% budget left) and breaches,
// and escalates breaches to the assignment group's team lead(s).

function policyFor(priorityId) {
  return db.prepare('SELECT * FROM sla_policies WHERE priority_id = ? AND active = 1').get(priorityId);
}

function getTicketSla(ticketId) {
  return db.prepare('SELECT * FROM ticket_sla WHERE ticket_id = ?').get(ticketId);
}

function computeDue(startDate, policy) {
  const add = policy.use_business_hours ? addBusinessMinutes : addPlainMinutes;
  return {
    response_due_at: toSql(add(startDate, policy.response_minutes)),
    resolution_due_at: toSql(add(startDate, policy.resolution_minutes)),
  };
}

// Attach an SLA record when a ticket is created.
function applySla(ticket) {
  const policy = policyFor(ticket.priority_id);
  if (!policy) return null;
  const due = computeDue(fromSql(ticket.created_at), policy);
  db.prepare(`INSERT INTO ticket_sla (ticket_id, policy_id, response_due_at, resolution_due_at)
    VALUES (?,?,?,?)
    ON CONFLICT(ticket_id) DO UPDATE SET policy_id = excluded.policy_id,
      response_due_at = excluded.response_due_at, resolution_due_at = excluded.resolution_due_at`)
    .run(ticket.id, policy.id, due.response_due_at, due.resolution_due_at);
  return getTicketSla(ticket.id);
}

// Re-baseline after a priority change: recompute from creation, then push the
// due dates out by however long the clock has been paused so far.
function recomputeSla(ticket) {
  const sla = getTicketSla(ticket.id);
  const policy = policyFor(ticket.priority_id);
  if (!policy) return;
  const due = computeDue(fromSql(ticket.created_at), policy);
  const shift = (sla?.paused_minutes || 0) * 60000;
  db.prepare(`UPDATE ticket_sla SET policy_id = ?, response_due_at = ?, resolution_due_at = ?,
      warning_sent = 0
    WHERE ticket_id = ?`)
    .run(policy.id,
      toSql(new Date(fromSql(due.response_due_at).getTime() + shift)),
      toSql(new Date(fromSql(due.resolution_due_at).getTime() + shift)),
      ticket.id);
  if (!sla) applySla(ticket);
}

function pauseSla(ticketId) {
  db.prepare("UPDATE ticket_sla SET paused_at = datetime('now') WHERE ticket_id = ? AND paused_at IS NULL AND completed_at IS NULL")
    .run(ticketId);
}

function resumeSla(ticketId) {
  const sla = getTicketSla(ticketId);
  if (!sla || !sla.paused_at) return;
  const pausedMs = Date.now() - fromSql(sla.paused_at).getTime();
  const pausedMin = Math.max(0, Math.round(pausedMs / 60000));
  const shift = (col) => sla[col] ? toSql(new Date(fromSql(sla[col]).getTime() + pausedMs)) : null;
  db.prepare(`UPDATE ticket_sla SET paused_at = NULL,
      paused_minutes = paused_minutes + ?,
      response_due_at = ?, resolution_due_at = ?
    WHERE ticket_id = ?`)
    .run(pausedMin, shift('response_due_at'), shift('resolution_due_at'), ticketId);
}

// First response = first assignment to an agent or first public IT comment.
function markFirstResponse(ticketId) {
  const sla = getTicketSla(ticketId);
  if (!sla || sla.first_response_at) return;
  const now = nowSql();
  const breached = sla.response_due_at && now > sla.response_due_at ? 1 : 0;
  db.prepare('UPDATE ticket_sla SET first_response_at = ?, response_breached = ? WHERE ticket_id = ?')
    .run(now, breached || sla.response_breached, ticketId);
}

// Called when the ticket reaches RESOLVED: stop the clock.
function completeSla(ticketId) {
  const sla = getTicketSla(ticketId);
  if (!sla || sla.completed_at) return;
  const now = nowSql();
  const breached = sla.resolution_due_at && now > sla.resolution_due_at ? 1 : 0;
  db.prepare('UPDATE ticket_sla SET completed_at = ?, paused_at = NULL, resolution_breached = ? WHERE ticket_id = ?')
    .run(now, breached || sla.resolution_breached, ticketId);
}

// Reopen: restart the resolution clock from now with the policy's window.
function reopenSla(ticket) {
  const policy = policyFor(ticket.priority_id);
  if (!policy) return;
  const add = policy.use_business_hours ? addBusinessMinutes : addPlainMinutes;
  db.prepare(`UPDATE ticket_sla SET completed_at = NULL, warning_sent = 0, escalated = 0,
      resolution_breached = 0, resolution_due_at = ? WHERE ticket_id = ?`)
    .run(toSql(add(new Date(), policy.resolution_minutes)), ticket.id);
}

function escalationTargets(ticket) {
  const targets = new Set();
  if (ticket.assigned_agent_id) targets.add(ticket.assigned_agent_id);
  const leads = ticket.support_group_id
    ? db.prepare("SELECT id FROM users WHERE role = 'TEAM_LEAD' AND active = 1 AND support_group_id = ?")
      .all(ticket.support_group_id)
    : db.prepare("SELECT id FROM users WHERE role = 'TEAM_LEAD' AND active = 1").all();
  for (const l of leads) targets.add(l.id);
  return [...targets];
}

// Periodic sweep: warnings, breaches, escalations. Also runs due workflow jobs.
function sweepSla() {
  const now = nowSql();
  const active = db.prepare(`
    SELECT s.*, t.ticket_number, t.title, t.status, t.priority_id,
           t.assigned_agent_id, t.support_group_id, t.requester_id, t.id AS tid
    FROM ticket_sla s JOIN tickets t ON t.id = s.ticket_id
    WHERE s.completed_at IS NULL AND s.paused_at IS NULL
      AND t.status NOT IN ('RESOLVED','CLOSED')`).all();

  const events = [];
  for (const row of active) {
    const ticket = { ...row, id: row.tid };

    // Resolution breach
    if (row.resolution_due_at && now > row.resolution_due_at && !row.resolution_breached) {
      db.prepare('UPDATE ticket_sla SET resolution_breached = 1 WHERE id = ?').run(row.id);
      ticketHistory(ticket.id, null, 'SLA_BREACH', `Resolution SLA breached (due ${row.resolution_due_at} UTC)`);
      audit(null, 'SLA_BREACH', 'ticket', ticket.id, `Resolution due ${row.resolution_due_at}`);
      if (!row.escalated) {
        db.prepare('UPDATE ticket_sla SET escalated = 1 WHERE id = ?').run(row.id);
        for (const uid of escalationTargets(ticket)) {
          notifyUser(uid, ticket, 'SLA_ESCALATION',
            `SLA breached on ${ticket.ticket_number} "${ticket.title}" — escalated for attention.`);
        }
        ticketHistory(ticket.id, null, 'SLA_ESCALATION', 'Escalated to assignment group lead(s)');
      }
      events.push({ ticket_id: ticket.id, type: 'breach' });
      // ADVANCED A10: SLA breach is a workflow trigger (enterprise automation)
      try {
        require('./workflow').runWorkflows('ticket.sla_breach',
          db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id));
      } catch (err) { console.error('[sla] breach workflow failed:', err.message); }
      continue;
    }

    // Response breach (only until first response happens)
    if (row.response_due_at && !row.first_response_at && now > row.response_due_at && !row.response_breached) {
      db.prepare('UPDATE ticket_sla SET response_breached = 1 WHERE id = ?').run(row.id);
      ticketHistory(ticket.id, null, 'SLA_BREACH', `Response SLA breached (due ${row.response_due_at} UTC)`);
      for (const uid of escalationTargets(ticket)) {
        notifyUser(uid, ticket, 'SLA_WARNING',
          `Response SLA breached on ${ticket.ticket_number} — no first response recorded.`);
      }
      events.push({ ticket_id: ticket.id, type: 'response_breach' });
      continue;
    }

    // Warning at <= 20% of the resolution window remaining (once)
    if (row.resolution_due_at && !row.warning_sent && !row.resolution_breached) {
      const due = fromSql(row.resolution_due_at).getTime();
      const policy = db.prepare('SELECT * FROM sla_policies WHERE id = ?').get(row.policy_id);
      const windowMs = (policy?.resolution_minutes || 0) * 60000;
      if (windowMs && due - Date.now() <= windowMs * 0.2 && due > Date.now()) {
        db.prepare('UPDATE ticket_sla SET warning_sent = 1 WHERE id = ?').run(row.id);
        ticketHistory(ticket.id, null, 'SLA_WARNING', `Resolution SLA due ${row.resolution_due_at} UTC`);
        for (const uid of escalationTargets(ticket)) {
          notifyUser(uid, ticket, 'SLA_WARNING',
            `SLA warning: ${ticket.ticket_number} is due by ${row.resolution_due_at} UTC.`);
        }
        events.push({ ticket_id: ticket.id, type: 'warning' });
      }
    }
  }
  return events;
}

module.exports = {
  policyFor, getTicketSla, applySla, recomputeSla, pauseSla, resumeSla,
  markFirstResponse, completeSla, reopenSla, sweepSla,
};
