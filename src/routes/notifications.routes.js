const express = require('express');
const { db } = require('../db');
const { authenticate } = require('../auth');

const router = express.Router();
router.use(authenticate);

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT n.*, t.ticket_number
    FROM notifications n LEFT JOIN tickets t ON t.id = n.ticket_id
    WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 50`).all(req.user.id);
  const unread = db.prepare(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0'
  ).get(req.user.id).n;
  res.json({ items: rows, unread });
});

router.post('/read', (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

// ---------- STANDARD S11: per-user notification preferences ----------
router.get('/prefs', (req, res) => {
  const row = db.prepare('SELECT * FROM user_prefs WHERE user_id = ?').get(req.user.id);
  res.json({ email_enabled: row ? !!row.email_enabled : true });
});

router.post('/prefs', (req, res) => {
  const enabled = (req.body || {}).email_enabled ? 1 : 0;
  db.prepare(`INSERT INTO user_prefs (user_id, email_enabled) VALUES (?,?)
    ON CONFLICT(user_id) DO UPDATE SET email_enabled = excluded.email_enabled`)
    .run(req.user.id, enabled);
  res.json({ email_enabled: !!enabled });
});

module.exports = router;
