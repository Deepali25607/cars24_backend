const express = require('express');
const { db } = require('../db');
const { authenticate, requireRole, IT_ROLES } = require('../auth');
const { audit, ticketHistory, notifyUser, notifyTicketParties } = require('../services');
const { runWorkflows } = require('../workflow');

const router = express.Router();
router.use(authenticate);

// BRD 8.6: declare major incident, incident commander, stakeholder
// communication, dedicated bridge, incident linking, priority escalation,
// status communication, post-incident review.

function getTicket(id) { return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id); }

function miData(ticketId) {
  const t = db.prepare(`
    SELECT t.id, t.ticket_number, t.title, t.status, t.is_major, t.major_bridge,
      t.major_declared_at, t.major_commander_id, u.full_name AS commander_name,
      p.code AS priority_code
    FROM tickets t
    LEFT JOIN users u ON u.id = t.major_commander_id
    JOIN priorities p ON p.id = t.priority_id
    WHERE t.id = ?`).get(ticketId);
  if (!t) return null;
  const updates = db.prepare(`
    SELECT m.*, u.full_name AS author_name
    FROM mi_updates m JOIN users u ON u.id = m.author_id
    WHERE m.ticket_id = ? ORDER BY m.id DESC`).all(ticketId);
  const linked = db.prepare(`
    SELECT l.id AS link_id, t2.id, t2.ticket_number, t2.title, t2.status
    FROM mi_links l JOIN tickets t2 ON t2.id = l.ticket_id
    WHERE l.major_ticket_id = ?`).all(ticketId);
  return { ...t, updates, linked };
}

// Active major incidents (IT overview)
router.get('/', requireRole(...IT_ROLES), (_req, res) => {
  const rows = db.prepare(`
    SELECT t.id, t.ticket_number, t.title, t.status, t.major_declared_at,
      u.full_name AS commander_name,
      (SELECT COUNT(*) FROM mi_links l WHERE l.major_ticket_id = t.id) AS linked_count
    FROM tickets t LEFT JOIN users u ON u.id = t.major_commander_id
    WHERE t.is_major = 1 AND t.status NOT IN ('CLOSED')
    ORDER BY t.major_declared_at DESC`).all();
  res.json(rows);
});

router.get('/:ticketId', requireRole(...IT_ROLES), (req, res) => {
  const data = miData(req.params.ticketId);
  if (!data) return res.status(404).json({ error: 'Ticket not found' });
  res.json(data);
});

// Declare a major incident: escalates to P1, sets commander + bridge,
// notifies IT leadership and the requester.
router.post('/:ticketId/declare', requireRole('TEAM_LEAD', 'ADMIN'), (req, res) => {
  const ticket = getTicket(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.is_major) return res.status(400).json({ error: 'This ticket is already a major incident' });
  if (['RESOLVED', 'CLOSED'].includes(ticket.status)) {
    return res.status(400).json({ error: 'Resolved/closed tickets cannot be declared major' });
  }
  const { commander_id, bridge } = req.body || {};
  const commander = db.prepare(
    "SELECT * FROM users WHERE id = ? AND active = 1 AND role IN ('AGENT','TEAM_LEAD','ADMIN')"
  ).get(commander_id || req.user.id);
  if (!commander) return res.status(400).json({ error: 'Choose an active IT user as incident commander' });

  db.prepare(`UPDATE tickets SET is_major = 1, major_commander_id = ?, major_bridge = ?,
      major_declared_at = datetime('now'), priority_id = 1,
      updated_at = datetime('now')
    WHERE id = ?`)
    .run(commander.id, bridge || null, ticket.id);

  ticketHistory(ticket.id, req.user.id, 'MAJOR_DECLARED',
    `Major incident declared. Commander: ${commander.full_name}. Priority escalated to P1.`);
  audit(req.user.id, 'MAJOR_DECLARED', 'ticket', ticket.id, ticket.ticket_number, req);

  const updated = getTicket(ticket.id);
  const leadership = db.prepare(
    "SELECT id FROM users WHERE active = 1 AND role IN ('TEAM_LEAD','ADMIN')"
  ).all();
  const targets = new Set(leadership.map((l) => l.id));
  targets.add(commander.id);
  targets.add(ticket.requester_id);
  targets.delete(req.user.id);
  for (const uid of targets) {
    notifyUser(uid, updated, 'MAJOR_INCIDENT',
      `MAJOR INCIDENT declared on ${updated.ticket_number} "${updated.title}". Commander: ${commander.full_name}.${bridge ? ` Bridge: ${bridge}` : ''}`);
  }
  runWorkflows('ticket.major_declared', updated);
  res.json(miData(ticket.id));
});

// Stakeholder status communication.
router.post('/:ticketId/update', requireRole(...IT_ROLES), (req, res) => {
  const ticket = getTicket(req.params.ticketId);
  if (!ticket || !ticket.is_major) return res.status(404).json({ error: 'Major incident not found' });
  const { message } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'Update message is required' });
  db.prepare("INSERT INTO mi_updates (ticket_id, author_id, update_type, message) VALUES (?,?,'UPDATE',?)")
    .run(ticket.id, req.user.id, String(message).trim());
  ticketHistory(ticket.id, req.user.id, 'MAJOR_UPDATE', String(message).trim().slice(0, 120));
  notifyTicketParties(ticket, req.user.id, 'MAJOR_INCIDENT',
    `Status update on major incident ${ticket.ticket_number}: ${String(message).trim().slice(0, 140)}`);
  res.status(201).json(miData(ticket.id));
});

// Link related incidents to the major.
router.post('/:ticketId/link', requireRole(...IT_ROLES), (req, res) => {
  const major = getTicket(req.params.ticketId);
  if (!major || !major.is_major) return res.status(404).json({ error: 'Major incident not found' });
  const other = getTicket((req.body || {}).ticket_id);
  if (!other || other.id === major.id) return res.status(400).json({ error: 'Choose a different existing ticket to link' });
  db.prepare('INSERT OR IGNORE INTO mi_links (major_ticket_id, ticket_id) VALUES (?,?)')
    .run(major.id, other.id);
  ticketHistory(other.id, req.user.id, 'MAJOR_LINKED', `Linked to major incident ${major.ticket_number}`);
  res.status(201).json(miData(major.id));
});

router.delete('/:ticketId/link/:linkId', requireRole(...IT_ROLES), (req, res) => {
  db.prepare('DELETE FROM mi_links WHERE id = ? AND major_ticket_id = ?')
    .run(req.params.linkId, req.params.ticketId);
  res.json(miData(req.params.ticketId));
});

// Post-incident review; stands down the major flag handling.
router.post('/:ticketId/review', requireRole('TEAM_LEAD', 'ADMIN'), (req, res) => {
  const ticket = getTicket(req.params.ticketId);
  if (!ticket || !ticket.is_major) return res.status(404).json({ error: 'Major incident not found' });
  const { message } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'Review notes are required' });
  db.prepare("INSERT INTO mi_updates (ticket_id, author_id, update_type, message) VALUES (?,?,'REVIEW',?)")
    .run(ticket.id, req.user.id, String(message).trim());
  ticketHistory(ticket.id, req.user.id, 'MAJOR_REVIEW', 'Post-incident review recorded');
  audit(req.user.id, 'MAJOR_REVIEW', 'ticket', ticket.id, null, req);
  res.status(201).json(miData(ticket.id));
});

module.exports = router;
