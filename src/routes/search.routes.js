const express = require('express');
const { db } = require('../db');
const { authenticate, IT_ROLES } = require('../auth');

const router = express.Router();
router.use(authenticate);

function isIT(user) { return IT_ROLES.includes(user.role); }

// ---------- Global search (BRD 7.3-12): tickets, knowledge, requests, assets ----------
router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.status(400).json({ error: 'Type at least 2 characters to search' });
  const like = `%${q}%`;
  const it = isIT(req.user);

  let tickets;
  if (it && req.user.role === 'ADMIN') {
    tickets = db.prepare(`SELECT t.id, t.ticket_number, t.title, t.status, p.code AS priority_code
      FROM tickets t JOIN priorities p ON p.id = t.priority_id
      WHERE (t.title LIKE @q OR t.description LIKE @q OR t.ticket_number LIKE @q)
      ORDER BY t.updated_at DESC LIMIT 20`).all({ q: like });
  } else if (it) {
    tickets = db.prepare(`SELECT t.id, t.ticket_number, t.title, t.status, p.code AS priority_code
      FROM tickets t JOIN priorities p ON p.id = t.priority_id
      WHERE (t.title LIKE @q OR t.description LIKE @q OR t.ticket_number LIKE @q)
        AND (t.assigned_agent_id = @uid OR t.support_group_id = @gid OR t.support_group_id IS NULL)
      ORDER BY t.updated_at DESC LIMIT 20`)
      .all({ q: like, uid: req.user.id, gid: req.user.support_group_id ?? -1 });
  } else {
    tickets = db.prepare(`SELECT t.id, t.ticket_number, t.title, t.status, p.code AS priority_code
      FROM tickets t JOIN priorities p ON p.id = t.priority_id
      WHERE t.requester_id = @uid AND (t.title LIKE @q OR t.description LIKE @q OR t.ticket_number LIKE @q)
      ORDER BY t.updated_at DESC LIMIT 20`).all({ q: like, uid: req.user.id });
  }

  const kb = db.prepare(`SELECT id, article_number, title, status FROM kb_articles
      WHERE (title LIKE ? OR body LIKE ? OR article_number LIKE ?)
      ${it ? '' : "AND status = 'PUBLISHED'"}
      ORDER BY updated_at DESC LIMIT 20`).all(like, like, like);

  const requests = it
    ? db.prepare(`SELECT r.id, r.request_number, ci.name AS item_name, r.status
        FROM requests r JOIN catalog_items ci ON ci.id = r.catalog_item_id
        WHERE (r.request_number LIKE ? OR ci.name LIKE ? OR r.description LIKE ?)
        ORDER BY r.updated_at DESC LIMIT 20`).all(like, like, like)
    : db.prepare(`SELECT r.id, r.request_number, ci.name AS item_name, r.status
        FROM requests r JOIN catalog_items ci ON ci.id = r.catalog_item_id
        WHERE r.requester_id = ? AND (r.request_number LIKE ? OR ci.name LIKE ?)
        ORDER BY r.updated_at DESC LIMIT 20`).all(req.user.id, like, like);

  const assets = it
    ? db.prepare(`SELECT id, asset_tag, manufacturer, model, hostname, status FROM assets
        WHERE asset_tag LIKE ? OR serial_number LIKE ? OR hostname LIKE ? OR model LIKE ?
        ORDER BY asset_tag ASC LIMIT 20`).all(like, like, like, like)
    : [];

  res.json({ q, tickets, kb, requests, assets });
});

// ---------- Saved searches ----------
router.get('/saved', (req, res) => {
  res.json(db.prepare('SELECT * FROM saved_searches WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id));
});

router.post('/saved', (req, res) => {
  const { name, query } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Give the saved search a name' });
  if (!query || !String(query).trim()) return res.status(400).json({ error: 'Nothing to save' });
  const info = db.prepare('INSERT INTO saved_searches (user_id, name, query) VALUES (?,?,?)')
    .run(req.user.id, String(name).trim(), String(query).trim());
  res.status(201).json(db.prepare('SELECT * FROM saved_searches WHERE id = ?').get(info.lastInsertRowid));
});

router.delete('/saved/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM saved_searches WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Saved search not found' });
  db.prepare('DELETE FROM saved_searches WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

module.exports = router;
