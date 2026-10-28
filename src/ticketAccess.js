const { db } = require('./db');
const participants = require('./email/participants');

// ================= Ticket authorization (shared) =================
// Single source of truth for "may this user see / act on this ticket by id".
// Used by every route that reads or changes a ticket by id, so group/triage
// isolation cannot be bypassed on one endpoint while enforced on another.

const IT_ROLES = ['AGENT', 'TEAM_LEAD', 'ADMIN'];

function isITUser(user) {
  return IT_ROLES.includes(user.role);
}

// Untriaged tickets (no support group yet) form the first-line intake queue and
// must not be visible to every IT user — only Admins and the Service Desk Triage
// group handle intake. Once a triage group exists, intake narrows to it + Admins.
let _triageGroupId;
function triageGroupId() {
  if (_triageGroupId === undefined || _triageGroupId === null) {
    const row = db.prepare("SELECT id FROM support_groups WHERE name = 'Service Desk Triage'").get();
    _triageGroupId = row ? row.id : null; // re-query while absent (group is seeded lazily)
  }
  return _triageGroupId;
}

function canSeeIntake(user) {
  if (user.role === 'ADMIN') return true;
  const tg = triageGroupId();
  // No triage group configured (pure Basic): IT shares the intake/pickup queue.
  if (tg == null) return isITUser(user);
  return user.support_group_id != null && user.support_group_id === tg;
}

// `ticket` must carry requester_id, assigned_agent_id, support_group_id and
// (for CC checks) cc_list — i.e. a row from the tickets table.
function canSeeTicket(user, ticket) {
  if (!user || !ticket) return false;
  // Admins and Team Leads have cross-group oversight (management roles); Agents
  // are confined to their own support group + the triage intake queue.
  if (user.role === 'ADMIN' || user.role === 'TEAM_LEAD') return true;
  if (ticket.requester_id === user.id) return true;
  // On the incident's CC list: they already receive the whole email trail.
  if (user.email && participants.listParticipants(ticket).includes(user.email.toLowerCase())) return true;
  if (user.role === 'AGENT') {
    if (ticket.assigned_agent_id === user.id) return true;
    if (!ticket.support_group_id) return canSeeIntake(user); // untriaged intake: triage/admin only
    return ticket.support_group_id === user.support_group_id;
  }
  return false;
}

module.exports = { canSeeTicket, canSeeIntake, triageGroupId, isITUser, IT_ROLES };
