const { db } = require('./db');
const { audit, ticketHistory, notifyUser } = require('./services');
const { toSql, nowSql } = require('./calendar');

// ================= Assignment rules (BRD 7.5) =================
// First active rule (by sort, then id) whose set conditions all match wins.
function applyAssignmentRules(ticket) {
  const rules = db.prepare(
    'SELECT * FROM assignment_rules WHERE active = 1 ORDER BY sort ASC, id ASC'
  ).all();
  const requester = db.prepare('SELECT department_id FROM users WHERE id = ?').get(ticket.requester_id);
  for (const r of rules) {
    if (r.category_id && r.category_id !== ticket.category_id) continue;
    if (r.subcategory_id && r.subcategory_id !== ticket.subcategory_id) continue;
    if (r.priority_id && r.priority_id !== ticket.priority_id) continue;
    if (r.location_id && r.location_id !== ticket.location_id) continue;
    if (r.department_id && r.department_id !== (requester?.department_id ?? null)) continue;
    return r;
  }
  return null;
}

// ================= Workflow engine (BRD 7.11) =================
// workflows: trigger_event + conditions_json + actions_json.
// Triggers: ticket.created | ticket.status.<STATUS> | ticket.assigned
// Conditions: [{field, op: eq|ne|in|gte|lte, value}] over the ticket row.
// Actions: assign_group{group_id} | assign_agent{agent_id} | set_priority{priority_id}
//   | notify_user{user_id,message} | notify_requester{message} | add_note{body}
//   | wait{minutes} (defers the remaining actions via workflow_jobs)
//   | create_task{title} (adds an OPEN request-style task as an internal note/history entry)

function condMatches(cond, ticket) {
  const actual = ticket[cond.field];
  const v = cond.value;
  switch (cond.op || 'eq') {
    case 'eq': return String(actual) === String(v);
    case 'ne': return String(actual) !== String(v);
    case 'in': return Array.isArray(v) && v.map(String).includes(String(actual));
    case 'gte': return Number(actual) >= Number(v);
    case 'lte': return Number(actual) <= Number(v);
    default: return false;
  }
}

function runActions(actions, ticket, workflowId) {
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i] || {};
    if (a.type === 'wait') {
      const runAt = toSql(new Date(Date.now() + Number(a.minutes || 0) * 60000));
      db.prepare(
        'INSERT INTO workflow_jobs (workflow_id, ticket_id, actions_json, run_at) VALUES (?,?,?,?)'
      ).run(workflowId ?? null, ticket.id, JSON.stringify(actions.slice(i + 1)), runAt);
      return;
    }
    try {
      if (a.type === 'assign_group' && a.group_id) {
        db.prepare('UPDATE tickets SET support_group_id = ? WHERE id = ?').run(a.group_id, ticket.id);
        ticketHistory(ticket.id, null, 'WORKFLOW', `Workflow moved ticket to group #${a.group_id}`);
      } else if (a.type === 'assign_agent' && a.agent_id) {
        db.prepare("UPDATE tickets SET assigned_agent_id = ?, status = CASE WHEN status IN ('NEW','REOPENED') THEN 'ASSIGNED' ELSE status END WHERE id = ?")
          .run(a.agent_id, ticket.id);
        ticketHistory(ticket.id, null, 'WORKFLOW', `Workflow assigned ticket to user #${a.agent_id}`);
        notifyUser(a.agent_id, ticket, 'TICKET_ASSIGNED', `Ticket ${ticket.ticket_number} was assigned to you by a workflow.`);
      } else if (a.type === 'set_priority' && a.priority_id) {
        db.prepare('UPDATE tickets SET priority_id = ? WHERE id = ?').run(a.priority_id, ticket.id);
        ticketHistory(ticket.id, null, 'WORKFLOW', `Workflow set priority #${a.priority_id}`);
      } else if (a.type === 'notify_user' && a.user_id) {
        notifyUser(a.user_id, ticket, 'WORKFLOW', a.message || `Workflow notification for ${ticket.ticket_number}.`);
      } else if (a.type === 'notify_requester') {
        notifyUser(ticket.requester_id, ticket, 'WORKFLOW', a.message || `Update on your ticket ${ticket.ticket_number}.`);
      } else if (a.type === 'add_note' && a.body) {
        const sys = db.prepare("SELECT id FROM users WHERE role = 'ADMIN' AND active = 1 ORDER BY id LIMIT 1").get();
        if (sys) {
          db.prepare('INSERT INTO ticket_comments (ticket_id, author_id, body, is_internal) VALUES (?,?,?,1)')
            .run(ticket.id, sys.id, `[workflow] ${a.body}`);
        }
        ticketHistory(ticket.id, null, 'WORKFLOW', 'Workflow added an internal note');
      } else if (a.type === 'escalate') {
        const leads = ticket.support_group_id
          ? db.prepare("SELECT id FROM users WHERE role = 'TEAM_LEAD' AND active = 1 AND support_group_id = ?").all(ticket.support_group_id)
          : db.prepare("SELECT id FROM users WHERE role = 'TEAM_LEAD' AND active = 1").all();
        for (const l of leads) {
          notifyUser(l.id, ticket, 'WORKFLOW', a.message || `Ticket ${ticket.ticket_number} was escalated by a workflow.`);
        }
        ticketHistory(ticket.id, null, 'WORKFLOW', 'Workflow escalation');
      } else if (a.type === 'create_task' && a.title) {
        ticketHistory(ticket.id, null, 'WORKFLOW_TASK', a.title);
      }
    } catch (err) {
      console.error('[workflow] action failed:', a.type, err.message);
    }
  }
}

function runWorkflows(event, ticket) {
  const rows = db.prepare(
    'SELECT * FROM workflows WHERE active = 1 AND trigger_event = ? ORDER BY sort ASC, id ASC'
  ).all(event);
  for (const wf of rows) {
    let conditions = []; let actions = [];
    try { conditions = JSON.parse(wf.conditions_json || '[]'); } catch { continue; }
    try { actions = JSON.parse(wf.actions_json || '[]'); } catch { continue; }
    if (!conditions.every((c) => condMatches(c, ticket))) continue;
    audit(null, 'WORKFLOW_RUN', 'workflow', wf.id, `${wf.name} on ${ticket.ticket_number || ticket.id}`);
    runActions(actions, ticket, wf.id);
  }
}

// Execute deferred (wait) jobs whose time has come. Called from the SLA sweep timer.
function runDueJobs() {
  const due = db.prepare('SELECT * FROM workflow_jobs WHERE done = 0 AND run_at <= ?').all(nowSql());
  for (const job of due) {
    db.prepare('UPDATE workflow_jobs SET done = 1 WHERE id = ?').run(job.id);
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(job.ticket_id);
    if (!ticket) continue;
    try { runActions(JSON.parse(job.actions_json), ticket, job.workflow_id); }
    catch (err) { console.error('[workflow] job failed:', err.message); }
  }
  return due.length;
}

module.exports = { applyAssignmentRules, runWorkflows, runDueJobs, runActions };
