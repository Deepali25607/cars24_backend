const express = require('express');
const { db, nextArticleNumber } = require('../db');
const { authenticate, requireRole, IT_ROLES } = require('../auth');
const { audit, notifyUser } = require('../services');

const router = express.Router();
router.use(authenticate);

const ARTICLE_SELECT = `
  SELECT k.*, u.full_name AS author_name, c.name AS category_name
  FROM kb_articles k
  JOIN users u ON u.id = k.author_id
  LEFT JOIN categories c ON c.id = k.category_id
`;

function getArticle(id) {
  return db.prepare(`${ARTICLE_SELECT} WHERE k.id = ?`).get(id);
}

function isIT(user) { return IT_ROLES.includes(user.role); }

// Everyone sees PUBLISHED; IT also sees drafts/pending/archived.
router.get('/', (req, res) => {
  const { q, category_id, status } = req.query;
  const where = [];
  const params = {};
  if (!isIT(req.user)) {
    where.push("k.status = 'PUBLISHED'");
  } else if (status) {
    where.push('k.status = @status'); params.status = status;
  }
  if (category_id) { where.push('k.category_id = @cat'); params.cat = category_id; }
  if (q) {
    where.push('(k.title LIKE @q OR k.body LIKE @q OR k.article_number LIKE @q)');
    params.q = `%${q}%`;
  }
  const rows = db.prepare(`${ARTICLE_SELECT}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY k.updated_at DESC LIMIT 200`).all(params);
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const article = getArticle(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.status !== 'PUBLISHED' && !isIT(req.user)) {
    return res.status(403).json({ error: 'Not permitted' });
  }
  const related = db.prepare(`
    SELECT k.id, k.article_number, k.title, k.status FROM kb_related r
    JOIN kb_articles k ON k.id = r.related_id
    WHERE r.article_id = ? ${isIT(req.user) ? '' : "AND k.status = 'PUBLISHED'"}`).all(article.id);
  const versions = isIT(req.user)
    ? db.prepare(`SELECT v.id, v.version, v.title, v.created_at, u.full_name AS editor_name
        FROM kb_versions v LEFT JOIN users u ON u.id = v.editor_id
        WHERE v.article_id = ? ORDER BY v.version DESC`).all(article.id)
    : [];
  const myRating = db.prepare('SELECT helpful FROM kb_ratings WHERE article_id = ? AND user_id = ?')
    .get(article.id, req.user.id);
  res.json({ ...article, related, versions, my_rating: myRating ? myRating.helpful : null });
});

// ---------- Author (IT roles) ----------
router.post('/', requireRole(...IT_ROLES), (req, res) => {
  const { title, body, category_id, review_at } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required' });
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Article body is required' });
  const number = nextArticleNumber();
  const info = db.prepare(`INSERT INTO kb_articles
    (article_number, title, body, category_id, author_id, status, review_at)
    VALUES (?,?,?,?,?,'DRAFT',?)`)
    .run(number, String(title).trim(), String(body).trim(), category_id || null, req.user.id, review_at || null);
  db.prepare('INSERT INTO kb_versions (article_id, version, title, body, editor_id) VALUES (?,?,?,?,?)')
    .run(info.lastInsertRowid, 1, String(title).trim(), String(body).trim(), req.user.id);
  audit(req.user.id, 'KB_CREATED', 'kb_article', info.lastInsertRowid, number, req);
  res.status(201).json(getArticle(info.lastInsertRowid));
});

router.patch('/:id', requireRole(...IT_ROLES), (req, res) => {
  const article = getArticle(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  const { title, body, category_id, review_at } = req.body || {};
  const newTitle = title !== undefined ? String(title).trim() : article.title;
  const newBody = body !== undefined ? String(body).trim() : article.body;
  if (!newTitle) return res.status(400).json({ error: 'Title is required' });
  if (!newBody) return res.status(400).json({ error: 'Article body is required' });

  const contentChanged = newTitle !== article.title || newBody !== article.body;
  const newVersion = contentChanged ? article.version + 1 : article.version;
  db.prepare(`UPDATE kb_articles SET title = ?, body = ?, category_id = ?, review_at = ?,
      version = ?, updated_at = datetime('now'),
      status = CASE WHEN ? AND status = 'PUBLISHED' THEN 'DRAFT' ELSE status END
    WHERE id = ?`)
    .run(newTitle, newBody,
      category_id !== undefined ? category_id : article.category_id,
      review_at !== undefined ? review_at : article.review_at,
      newVersion, contentChanged ? 1 : 0, article.id);
  if (contentChanged) {
    db.prepare('INSERT INTO kb_versions (article_id, version, title, body, editor_id) VALUES (?,?,?,?,?)')
      .run(article.id, newVersion, newTitle, newBody, req.user.id);
  }
  audit(req.user.id, 'KB_UPDATED', 'kb_article', article.id, `v${newVersion}`, req);
  res.json(getArticle(article.id));
});

// ---------- Approval flow: DRAFT -> PENDING_APPROVAL -> PUBLISHED / back to DRAFT ----------
router.post('/:id/submit', requireRole(...IT_ROLES), (req, res) => {
  const article = getArticle(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.status !== 'DRAFT') return res.status(400).json({ error: 'Only draft articles can be submitted for approval' });
  db.prepare("UPDATE kb_articles SET status = 'PENDING_APPROVAL', updated_at = datetime('now') WHERE id = ?").run(article.id);
  const approvers = db.prepare("SELECT id FROM users WHERE role IN ('TEAM_LEAD','ADMIN') AND active = 1").all();
  for (const a of approvers) {
    notifyUser(a.id, null, 'KB_APPROVAL', `Knowledge article ${article.article_number} "${article.title}" awaits approval.`);
  }
  audit(req.user.id, 'KB_SUBMITTED', 'kb_article', article.id, article.article_number, req);
  res.json(getArticle(article.id));
});

router.post('/:id/approve', requireRole('TEAM_LEAD', 'ADMIN'), (req, res) => {
  const article = getArticle(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.status !== 'PENDING_APPROVAL') return res.status(400).json({ error: 'Article is not awaiting approval' });
  db.prepare("UPDATE kb_articles SET status = 'PUBLISHED', updated_at = datetime('now') WHERE id = ?").run(article.id);
  notifyUser(article.author_id, null, 'KB_PUBLISHED', `Your article ${article.article_number} "${article.title}" was approved and published.`);
  audit(req.user.id, 'KB_PUBLISHED', 'kb_article', article.id, article.article_number, req);
  res.json(getArticle(article.id));
});

router.post('/:id/reject', requireRole('TEAM_LEAD', 'ADMIN'), (req, res) => {
  const article = getArticle(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.status !== 'PENDING_APPROVAL') return res.status(400).json({ error: 'Article is not awaiting approval' });
  db.prepare("UPDATE kb_articles SET status = 'DRAFT', updated_at = datetime('now') WHERE id = ?").run(article.id);
  const note = (req.body || {}).note;
  notifyUser(article.author_id, null, 'KB_REJECTED',
    `Article ${article.article_number} was returned to draft${note ? `: ${note}` : '.'}`);
  audit(req.user.id, 'KB_REJECTED', 'kb_article', article.id, note || '', req);
  res.json(getArticle(article.id));
});

router.post('/:id/archive', requireRole('TEAM_LEAD', 'ADMIN'), (req, res) => {
  const article = getArticle(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  db.prepare("UPDATE kb_articles SET status = 'ARCHIVED', updated_at = datetime('now') WHERE id = ?").run(article.id);
  audit(req.user.id, 'KB_ARCHIVED', 'kb_article', article.id, article.article_number, req);
  res.json(getArticle(article.id));
});

// ---------- Rating (helpful / not helpful) ----------
router.post('/:id/rate', (req, res) => {
  const article = getArticle(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.status !== 'PUBLISHED') return res.status(400).json({ error: 'Only published articles can be rated' });
  const helpful = (req.body || {}).helpful ? 1 : 0;
  db.prepare(`INSERT INTO kb_ratings (article_id, user_id, helpful) VALUES (?,?,?)
    ON CONFLICT(article_id, user_id) DO UPDATE SET helpful = excluded.helpful`)
    .run(article.id, req.user.id, helpful);
  const counts = db.prepare(`SELECT
      SUM(CASE WHEN helpful = 1 THEN 1 ELSE 0 END) AS yes,
      SUM(CASE WHEN helpful = 0 THEN 1 ELSE 0 END) AS no
    FROM kb_ratings WHERE article_id = ?`).get(article.id);
  db.prepare('UPDATE kb_articles SET helpful_count = ?, not_helpful_count = ? WHERE id = ?')
    .run(counts.yes || 0, counts.no || 0, article.id);
  res.json(getArticle(article.id));
});

// ---------- Related articles ----------
router.post('/:id/related', requireRole(...IT_ROLES), (req, res) => {
  const article = getArticle(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  const other = getArticle((req.body || {}).related_id);
  if (!other || other.id === article.id) return res.status(400).json({ error: 'Choose a different existing article to relate' });
  db.prepare('INSERT OR IGNORE INTO kb_related (article_id, related_id) VALUES (?,?)').run(article.id, other.id);
  db.prepare('INSERT OR IGNORE INTO kb_related (article_id, related_id) VALUES (?,?)').run(other.id, article.id);
  res.status(201).json({ ok: true });
});

module.exports = router;
