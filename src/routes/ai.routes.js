const express = require('express');
const { db } = require('../db');
const { authenticate, requireRole, IT_ROLES } = require('../auth');
const { aiStatus, classify, recommend, summarize, chatReply, recommendAssignment } = require('../ai');
const { breachProbability, recommendations } = require('../predict');

const router = express.Router();
router.use(authenticate);

router.get('/status', (_req, res) => res.json(aiStatus()));

// BRD 8.7: classification suggestions (recommendation only — business rules
// and the person submitting stay in control).
router.post('/classify', (req, res) => {
  const { title, description } = req.body || {};
  if (!title && !description) return res.status(400).json({ error: 'Provide a title or description to classify' });
  res.json(classify(title || '', description || ''));
});

// BRD 8.8: resolution recommendations from history + knowledge.
router.post('/recommend', requireRole(...IT_ROLES), (req, res) => {
  const { text, ticket_id } = req.body || {};
  let query = text;
  if (ticket_id) {
    const t = db.prepare('SELECT title, description FROM tickets WHERE id = ?').get(ticket_id);
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    query = `${t.title} ${t.description}`;
  }
  if (!query) return res.status(400).json({ error: 'Provide text or a ticket to analyse' });
  res.json(recommend(query));
});

// BRD 8.9: ticket summary (requester or IT).
router.get('/summary/:ticketId', async (req, res) => {
  const t = db.prepare('SELECT requester_id FROM tickets WHERE id = ?').get(req.params.ticketId);
  if (!t) return res.status(404).json({ error: 'Ticket not found' });
  if (t.requester_id !== req.user.id && !IT_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Not permitted' });
  }
  res.json(await summarize(req.params.ticketId));
});

// BRD 8.10: IT Support Assistant chatbot. Ticket creation happens only via
// the normal POST /api/tickets after the user confirms the returned draft.
router.post('/chat', (req, res) => {
  const { messages } = req.body || {};
  if (messages !== undefined && !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages must be a list' });
  }
  res.json(chatReply(messages || []));
});

// BRD 8.11: intelligent assignment recommendation (advice only).
router.get('/assignment/:ticketId', requireRole(...IT_ROLES), (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ recommendations: recommendAssignment(ticket) });
});

// BRD 8.12: per-ticket SLA breach prediction.
router.get('/sla-prediction/:ticketId', requireRole(...IT_ROLES), (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const sla = db.prepare('SELECT * FROM ticket_sla WHERE ticket_id = ?').get(ticket.id);
  const probability = breachProbability(ticket, sla);
  res.json({
    ticket_number: ticket.ticket_number,
    breach_probability: probability,
    recommendations: recommendations(probability, ticket),
  });
});

module.exports = router;
