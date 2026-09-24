const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, nextTicketNumber } = require('../db');
const { authenticate, requireRole, IT_ROLES } = require('../auth');
const { audit, ticketHistory, notifyUser, notifyTicketParties } = require('../services');
const { applySla, recomputeSla, pauseSla, resumeSla, markFirstResponse,
  completeSla, reopenSla, getTicketSla } = require('../sla');
const { applyAssignmentRules, runWorkflows } = require('../workflow');
// S10 extension: customer-visible updates on email-sourced tickets are mailed
// back on the original thread. Internal work notes never trigger a send.
const emailSync = require('../email/outbound');
// The ticket's CC watch list: who else follows the incident's email thread.
const participants = require('../email/participants');

const router = express.Router();
router.use(authenticate);

// ---------- Attachments storage ----------
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'text/csv', 'application/zip',
]);
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 10);

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) =>
      cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).slice(0, 10)}`),
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error('File type not allowed. Use images, PDF, logs (txt/csv) or zip.'));
  },
});

// ---------- Helpers ----------
const TICKET_SELECT = `
  SELECT t.*,
    req.full_name  AS requester_name,  req.email AS requester_email,
    ag.full_name   AS agent_name,
    c.name  AS category_name,
    sc.name AS subcategory_name,
    p.code  AS priority_code, p.label AS priority_label,
    g.name  AS group_name,
    l.name  AS location_name,
    a.asset_tag, a.manufacturer AS asset_manufacturer, a.model AS asset_model
  FROM tickets t
  JOIN users req ON req.id = t.requester_id
  LEFT JOIN users ag ON ag.id = t.assigned_agent_id
  JOIN categories c  ON c.id = t.category_id
  LEFT JOIN subcategories sc ON sc.id = t.subcategory_id
  JOIN priorities p  ON p.id = t.priority_id
  LEFT JOIN support_groups g ON g.id = t.support_group_id
  LEFT JOIN locations l ON l.id = t.location_id
  LEFT JOIN assets a ON a.id = t.asset_id
`;

function getTicket(id) {
  return db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(id);
}

function canSeeTicket(user, ticket) {
  if (user.role === 'ADMIN') return true;
  if (ticket.requester_id === user.id) return true;
  // On the incident's CC list: they already receive the whole email trail, so
  // they may follow the same conversation in the portal.
  if (user.email && participants.listParticipants(ticket).includes(user.email.toLowerCase())) return true;
  if (user.role === 'AGENT' || user.role === 'TEAM_LEAD') {
    if (ticket.assigned_agent_id === user.id) return true;
    if (!ticket.support_group_id) return true; // untriaged queue is visible to IT
    return ticket.support_group_id === user.support_group_id;
  }
  return false;
}

function isITUser(user) {
  return IT_ROLES.includes(user.role);
}

const TRANSITIONS = {
  NEW:         ['ASSIGNED', 'IN_PROGRESS'],
  ASSIGNED:    ['IN_PROGRESS', 'PENDING'],
  IN_PROGRESS: ['PENDING', 'RESOLVED'],
  PENDING:     ['IN_PROGRESS', 'RESOLVED'],
  RESOLVED:    ['CLOSED', 'REOPENED'],
  CLOSED:      ['REOPENED'],
  REOPENED:    ['IN_PROGRESS', 'PENDING', 'RESOLVED'],
};

function touch(id) {
  db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(id);
}

// ---------- Create ----------
router.post('/', (req, res) => {
  const { title, description, category_id, subcategory_id, priority_id,
    asset_id, location_id } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required' });
  if (!description || !String(description).trim()) return res.status(400).json({ error: 'Description is required' });

  const category = db.prepare('SELECT * FROM categories WHERE id = ? AND active = 1').get(category_id);
  if (!category) return res.status(400).json({ error: 'Please choose a valid category' });
  if (subcategory_id) {
    const sub = db.prepare('SELECT * FROM subcategories WHERE id = ? AND category_id = ? AND active = 1')
      .get(subcategory_id, category_id);
    if (!sub) return res.status(400).json({ error: 'Subcategory does not belong to the chosen category' });
  }
  const priority = db.prepare('SELECT * FROM priorities WHERE id = ?').get(priority_id);
  if (!priority) return res.status(400).json({ error: 'Please choose a valid priority' });

  if (asset_id) {
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(asset_id);
    if (!asset) return res.status(400).json({ error: 'Unknown laptop/asset' });
    // Employees may only attach their own assigned laptop
    if (!isITUser(req.user) && asset.assigned_user_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only select a laptop assigned to you' });
    }
  }

  const ticketNumber = nextTicketNumber();
  const info = db.prepare(`INSERT INTO tickets
    (ticket_number, requester_id, title, description, category_id, subcategory_id,
     priority_id, location_id, asset_id, status)
    VALUES (?,?,?,?,?,?,?,?,?, 'NEW')`)
    .run(ticketNumber, req.user.id, String(title).trim(), String(description).trim(),
      category_id, subcategory_id || null, priority_id,
      location_id || req.user.location_id || null, asset_id || null);

  let ticket = getTicket(info.lastInsertRowid);
  ticketHistory(ticket.id, req.user.id, 'CREATED', `Ticket created with priority ${priority.code}`);
  audit(req.user.id, 'TICKET_CREATED', 'ticket', ticket.id, ticketNumber, req);

  // STANDARD S3: automated assignment (first matching rule wins)
  const rule = applyAssignmentRules(ticket);
  if (rule) {
    db.prepare(`UPDATE tickets SET support_group_id = ?,
        assigned_agent_id = COALESCE(?, assigned_agent_id),
        status = CASE WHEN ? IS NOT NULL THEN 'ASSIGNED' ELSE status END
      WHERE id = ?`)
      .run(rule.target_group_id, rule.target_agent_id || null, rule.target_agent_id || null, ticket.id);
    ticket = getTicket(ticket.id);
    ticketHistory(ticket.id, null, 'AUTO_ASSIGNED',
      `Rule "${rule.name}" routed to ${ticket.group_name || 'group'}${ticket.agent_name ? ` / ${ticket.agent_name}` : ''}`);
    if (rule.target_agent_id) {
      notifyUser(rule.target_agent_id, ticket, 'TICKET_ASSIGNED',
        `Ticket ${ticket.ticket_number} was auto-assigned to you.`);
    }
  }

  // STANDARD S2: attach SLA targets
  applySla(ticket);

  // STANDARD S8: workflows on creation
  runWorkflows('ticket.created', ticket);
  ticket = getTicket(ticket.id);

  notifyUser(req.user.id, ticket, 'TICKET_CREATED',
    `Your ticket ${ticket.ticket_number} "${ticket.title}" has been created.`);
  res.status(201).json({ ...ticket, sla: getTicketSla(ticket.id) });
});

// ---------- List (role-scoped) ----------
router.get('/', (req, res) => {
  const { scope, status, priority_id, category_id, subcategory_id, group_id, q, from, to } = req.query;
  const where = [];
  const params = {};

  if (!isITUser(req.user)) {
    // Employees see what they raised plus what they were copied into by email —
    // the portal then matches the mail thread they are already on.
    where.push("(t.requester_id = @uid OR instr(lower(coalesce(t.cc_list, '')), @ccme) > 0)");
    params.ccme = `"${String(req.user.email || '').toLowerCase()}"`;
  } else if (scope === 'my') {
    where.push('t.requester_id = @uid');
  } else if (scope === 'assigned') {
    where.push('t.assigned_agent_id = @uid');
  } else if (scope === 'unassigned') {
    where.push('t.assigned_agent_id IS NULL');
    where.push("t.status IN ('NEW','REOPENED')");
  } else if (scope === 'team') {
    if (req.user.role !== 'ADMIN') {
      where.push('(t.support_group_id = @gid OR t.support_group_id IS NULL)');
      params.gid = req.user.support_group_id;
    }
  } else if (req.user.role !== 'ADMIN') {
    // default IT scope: my work + my team's queue + unassigned
    where.push('(t.assigned_agent_id = @uid OR t.support_group_id = @gid OR t.support_group_id IS NULL)');
    params.gid = req.user.support_group_id;
  }
  params.uid = req.user.id;

  if (status) { where.push('t.status = @status'); params.status = status; }
  if (priority_id) { where.push('t.priority_id = @prio'); params.prio = priority_id; }
  if (category_id) { where.push('t.category_id = @cat'); params.cat = category_id; }
  if (subcategory_id) { where.push('t.subcategory_id = @sub'); params.sub = subcategory_id; }
  // Optional creation-date window (YYYY-MM-DD), used by the Reports data table.
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) { where.push('date(t.created_at) >= date(@from)'); params.from = from; }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) { where.push('date(t.created_at) <= date(@to)'); params.to = to; }
  if (group_id) { where.push('t.support_group_id = @grp'); params.grp = group_id; }
  if (q) {
    where.push('(t.title LIKE @q OR t.ticket_number LIKE @q OR t.description LIKE @q)');
    params.q = `%${q}%`;
  }

  const sql = `${TICKET_SELECT}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.updated_at DESC LIMIT 500`;
  res.json(db.prepare(sql).all(params));
});

// ---------- Detail ----------
router.get('/:id', (req, res) => {
  const ticket = getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (!canSeeTicket(req.user, ticket)) return res.status(403).json({ error: 'Not permitted' });

  const comments = db.prepare(`
    SELECT tc.*, u.full_name AS author_name, u.role AS author_role
    FROM ticket_comments tc JOIN users u ON u.id = tc.author_id
    WHERE tc.ticket_id = ? ${isITUser(req.user) ? '' : 'AND tc.is_internal = 0'}
    ORDER BY tc.created_at ASC`).all(ticket.id);

  const attachments = db.prepare(`
    SELECT ta.id, ta.original_name, ta.mime_type, ta.size_bytes, ta.created_at,
           u.full_name AS uploader_name
    FROM ticket_attachments ta JOIN users u ON u.id = ta.uploader_id
    WHERE ta.ticket_id = ? ORDER BY ta.created_at ASC`).all(ticket.id);

  const history = db.prepare(`
    SELECT th.*, u.full_name AS actor_name
    FROM ticket_history th LEFT JOIN users u ON u.id = th.actor_id
    WHERE th.ticket_id = ? ORDER BY th.created_at ASC, th.id ASC`).all(ticket.id);

  const rating = db.prepare('SELECT score, comment FROM ticket_ratings WHERE ticket_id = ?').get(ticket.id);
  const related = ticket.related_ticket_id
    ? db.prepare('SELECT id, ticket_number, status FROM tickets WHERE id = ?').get(ticket.related_ticket_id) : null;
  const followUps = db.prepare('SELECT id, ticket_number, status FROM tickets WHERE related_ticket_id = ? ORDER BY id').all(ticket.id);
  res.json({ ...ticket, comments, attachments, history, sla: getTicketSla(ticket.id), rating: rating || null,
    related_ticket: related, follow_up_tickets: followUps });
});

// ---------- Assign / reassign ----------
router.post('/:id/assign', requireRole(...IT_ROLES), (req, res) => {
  const ticket = getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const { agent_id, group_id } = req.body || {};

  // Agents may take tickets themselves; leads/admins may assign to anyone.
  if (req.user.role === 'AGENT' && agent_id && Number(agent_id) !== req.user.id) {
    return res.status(403).json({ error: 'Agents can only assign tickets to themselves' });
  }

  let agent = null;
  if (agent_id) {
    agent = db.prepare("SELECT * FROM users WHERE id = ? AND active = 1 AND role IN ('AGENT','TEAM_LEAD','ADMIN')").get(agent_id);
    if (!agent) return res.status(400).json({ error: 'Chosen assignee is not an active IT user' });
  }
  const groupId = group_id ?? agent?.support_group_id ?? ticket.support_group_id;

  const wasAssigned = !!ticket.assigned_agent_id;
  const newStatus = ['NEW', 'REOPENED'].includes(ticket.status) && agent ? 'ASSIGNED' : ticket.status;
  db.prepare('UPDATE tickets SET assigned_agent_id = ?, support_group_id = ?, status = ? WHERE id = ?')
    .run(agent_id || null, groupId || null, newStatus, ticket.id);
  touch(ticket.id);

  const updated = getTicket(ticket.id);
  const detail = agent
    ? `${wasAssigned ? 'Reassigned' : 'Assigned'} to ${agent.full_name}${updated.group_name ? ` (${updated.group_name})` : ''}`
    : `Moved to group ${updated.group_name || '—'}`;
  ticketHistory(ticket.id, req.user.id, wasAssigned ? 'REASSIGNED' : 'ASSIGNED', detail);
  audit(req.user.id, 'TICKET_ASSIGNED', 'ticket', ticket.id, detail, req);
  if (agent) markFirstResponse(ticket.id); // STANDARD S2: assignment counts as first response
  runWorkflows('ticket.assigned', updated);
  notifyTicketParties(updated, req.user.id, 'TICKET_ASSIGNED',
    `Ticket ${updated.ticket_number} ${detail.toLowerCase()}.`);
  emailSync.onAssigned(updated, req.user, detail); // FR7: assignment goes on the email thread (configurable)
  res.json(updated);
});

// ---------- Update classification (category/priority/etc.) ----------
router.patch('/:id', requireRole(...IT_ROLES), (req, res) => {
  const ticket = getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const { category_id, subcategory_id, priority_id, location_id } = req.body || {};
  const changes = [];

  if (category_id && category_id !== ticket.category_id) {
    const c = db.prepare('SELECT * FROM categories WHERE id = ? AND active = 1').get(category_id);
    if (!c) return res.status(400).json({ error: 'Invalid category' });
    changes.push(`category → ${c.name}`);
  }
  if (priority_id && priority_id !== ticket.priority_id) {
    const p = db.prepare('SELECT * FROM priorities WHERE id = ?').get(priority_id);
    if (!p) return res.status(400).json({ error: 'Invalid priority' });
    changes.push(`priority → ${p.code}`);
  }
  if (subcategory_id !== undefined && (subcategory_id || null) !== ticket.subcategory_id) {
    const sc = subcategory_id ? db.prepare('SELECT name FROM subcategories WHERE id = ?').get(subcategory_id) : null;
    changes.push(`subcategory → ${sc?.name || '—'}`);
  }
  if (location_id && location_id !== ticket.location_id) {
    const l = db.prepare('SELECT name FROM locations WHERE id = ?').get(location_id);
    if (l) changes.push(`location → ${l.name}`);
  }
  db.prepare(`UPDATE tickets SET
      category_id = COALESCE(?, category_id),
      subcategory_id = ?,
      priority_id = COALESCE(?, priority_id),
      location_id = COALESCE(?, location_id)
    WHERE id = ?`)
    .run(category_id || null,
      subcategory_id !== undefined ? subcategory_id : ticket.subcategory_id,
      priority_id || null, location_id || null, ticket.id);
  touch(ticket.id);

  if (changes.length) {
    ticketHistory(ticket.id, req.user.id, 'UPDATED', changes.join(', '));
    audit(req.user.id, 'TICKET_UPDATED', 'ticket', ticket.id, changes.join(', '), req);
  }
  // STANDARD S2: priority change re-baselines the SLA targets
  if (priority_id && priority_id !== ticket.priority_id) recomputeSla(getTicket(ticket.id));
  // FR7: one "details updated" mail on the email thread listing every change (configurable)
  if (changes.length) emailSync.onDetailsUpdated(getTicket(ticket.id), req.user, changes.join(', '));
  res.json(getTicket(ticket.id));
});

// ---------- Status transitions ----------
router.post('/:id/status', (req, res) => {
  const ticket = getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const { status, note } = req.body || {};
  const target = String(status || '').toUpperCase();

  const isRequester = ticket.requester_id === req.user.id;
  const it = isITUser(req.user);
  if (!it && !isRequester) return res.status(403).json({ error: 'Not permitted' });

  const allowed = TRANSITIONS[ticket.status] || [];
  if (!allowed.includes(target)) {
    return res.status(400).json({ error: `Cannot move a ${ticket.status.replace('_', ' ')} ticket to ${target.replace('_', ' ')}` });
  }

  // Role rules per BRD: employees may close their own resolved ticket or reopen;
  // all other transitions are IT actions.
  if (!it && !( (target === 'CLOSED' && ticket.status === 'RESOLVED') || target === 'REOPENED')) {
    return res.status(403).json({ error: 'Only the support team can make this change' });
  }
  if (target === 'RESOLVED' && !note && !ticket.resolution_note) {
    return res.status(400).json({ error: 'A resolution note is required to resolve a ticket' });
  }

  const sets = ['status = ?'];
  const vals = [target];
  if (target === 'RESOLVED') {
    sets.push("resolved_at = datetime('now')", 'resolution_note = COALESCE(?, resolution_note)');
    vals.push(note || null);
  }
  if (target === 'CLOSED') sets.push("closed_at = datetime('now')");
  if (target === 'REOPENED') sets.push('reopen_count = reopen_count + 1');
  vals.push(ticket.id);
  db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  touch(ticket.id);

  // STANDARD S2: SLA pause on PENDING, resume when leaving it, stop on resolve,
  // restart resolution window on reopen.
  if (target === 'PENDING') pauseSla(ticket.id);
  else if (ticket.status === 'PENDING') resumeSla(ticket.id);
  if (target === 'RESOLVED') completeSla(ticket.id);
  if (target === 'REOPENED') reopenSla(getTicket(ticket.id));

  const updated = getTicket(ticket.id);
  ticketHistory(ticket.id, req.user.id, `STATUS_${target}`, note || null);
  audit(req.user.id, 'TICKET_STATUS', 'ticket', ticket.id, note ? `${target}: ${note}` : target, req);
  runWorkflows(`ticket.status.${target}`, updated);

  const messages = {
    RESOLVED: `Ticket ${updated.ticket_number} has been resolved.`,
    CLOSED: `Ticket ${updated.ticket_number} has been closed.`,
    REOPENED: `Ticket ${updated.ticket_number} has been reopened.`,
  };
  notifyTicketParties(updated, req.user.id, `TICKET_${target}`,
    messages[target] || `Ticket ${updated.ticket_number} status changed to ${target.replace('_', ' ')}.`);
  // Email sync (FR7): on hold / resolved / closed / reopened go back on the thread.
  if (it) emailSync.onStatusChange(updated, target, note || null, req.user);
  res.json(updated);
});

// ---------- Comments & work notes ----------
router.post('/:id/comments', (req, res) => {
  const ticket = getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (!canSeeTicket(req.user, ticket)) return res.status(403).json({ error: 'Not permitted' });

  const { body, is_internal } = req.body || {};
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Comment cannot be empty' });
  const internal = is_internal && isITUser(req.user) ? 1 : 0;

  const info = db.prepare(
    'INSERT INTO ticket_comments (ticket_id, author_id, body, is_internal) VALUES (?,?,?,?)'
  ).run(ticket.id, req.user.id, String(body).trim(), internal);
  touch(ticket.id);

  ticketHistory(ticket.id, req.user.id, internal ? 'WORK_NOTE' : 'COMMENT',
    internal ? 'Internal work note added' : 'Comment added');
  // STANDARD S2: a public comment from IT counts as the first response
  if (!internal && isITUser(req.user) && ticket.requester_id !== req.user.id) {
    markFirstResponse(ticket.id);
  }
  if (!internal) {
    notifyTicketParties(ticket, req.user.id, 'COMMENT_ADDED',
      `New comment on ticket ${ticket.ticket_number} from ${req.user.full_name}.`);
  }
  const comment = db.prepare(`
    SELECT tc.*, u.full_name AS author_name, u.role AS author_role
    FROM ticket_comments tc JOIN users u ON u.id = tc.author_id WHERE tc.id = ?`)
    .get(info.lastInsertRowid);
  // Email sync (FR7): every public comment by an IT user goes back on the
  // customer's thread, so the email chain mirrors the ticket conversation.
  if (!internal && isITUser(req.user)) {
    emailSync.onPublicComment(ticket, comment, req.user);
  }
  res.status(201).json({ ...comment, emailed: !internal && emailSync.hasEmailThread(ticket) && isITUser(req.user) });
});

// ---------- Email participants (CC watch list) ----------
// Several addresses can be put on copy in one go ("a@x.com, b@y.com"). Each new
// one is mailed the conversation so far on the original thread and is copied on
// every later update; the addition shows up in the ticket history and audit log.
function canManageParticipants(user, ticket) {
  return isITUser(user) || ticket.requester_id === user.id;
}

router.get('/:id/participants', (req, res) => {
  const ticket = getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (!canSeeTicket(req.user, ticket)) return res.status(403).json({ error: 'Not permitted' });
  res.json({
    caller: ticket.caller_email || ticket.requester_email,
    cc: participants.listParticipants(ticket),
    can_manage: canManageParticipants(req.user, ticket),
    emails_thread: emailSync.hasEmailThread(ticket),
  });
});

router.post('/:id/participants', (req, res) => {
  const ticket = getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (!canSeeTicket(req.user, ticket) || !canManageParticipants(req.user, ticket)) {
    return res.status(403).json({ error: 'Not permitted' });
  }
  if (ticket.status === 'CLOSED') return res.status(400).json({ error: 'This ticket is closed' });
  const input = req.body?.emails ?? req.body?.email ?? '';
  if (!String(Array.isArray(input) ? input.join(',') : input).trim()) {
    return res.status(400).json({ error: 'Enter at least one email address' });
  }
  let result;
  try {
    result = participants.addParticipants(ticket.id, input, {
      actorId: req.user.id, actorName: req.user.full_name, via: 'portal', startThread: true,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!result.added.length) {
    const reason = result.invalid.length
      ? `Not a valid email address: ${result.invalid.join(', ')}`
      : `Already on this ticket: ${result.skipped.map((s) => s.address).join(', ')}`;
    return res.status(400).json({ error: reason, skipped: result.skipped });
  }
  const updated = getTicket(ticket.id);
  res.status(201).json({
    added: result.added,
    skipped: result.skipped,
    emailed: !!result.mail,
    cc: participants.listParticipants(updated),
    ticket: updated,
  });
});

router.delete('/:id/participants/:email', (req, res) => {
  const ticket = getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (!canSeeTicket(req.user, ticket) || !canManageParticipants(req.user, ticket)) {
    return res.status(403).json({ error: 'Not permitted' });
  }
  const result = participants.removeParticipants(ticket.id, req.params.email, {
    actorId: req.user.id, actorName: req.user.full_name,
  });
  if (!result.removed.length) return res.status(404).json({ error: 'That address is not on the CC list' });
  const updated = getTicket(ticket.id);
  res.json({ removed: result.removed, cc: participants.listParticipants(updated), ticket: updated });
});

// ---------- Attachments ----------
router.post('/:id/attachments', (req, res) => {
  const ticket = getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (!canSeeTicket(req.user, ticket)) return res.status(403).json({ error: 'Not permitted' });

  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const info = db.prepare(`INSERT INTO ticket_attachments
      (ticket_id, uploader_id, original_name, stored_name, mime_type, size_bytes)
      VALUES (?,?,?,?,?,?)`)
      .run(ticket.id, req.user.id, req.file.originalname, req.file.filename,
        req.file.mimetype, req.file.size);
    touch(ticket.id);
    ticketHistory(ticket.id, req.user.id, 'ATTACHMENT', `Uploaded ${req.file.originalname}`);
    audit(req.user.id, 'ATTACHMENT_UPLOADED', 'ticket', ticket.id, req.file.originalname, req);
    res.status(201).json({ id: info.lastInsertRowid, original_name: req.file.originalname });
  });
});

// ---------- ADVANCED A8: satisfaction rating (requester, after resolve/close) ----------
router.post('/:id/rating', (req, res) => {
  const ticket = getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.requester_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the requester can rate this ticket' });
  }
  if (!['RESOLVED', 'CLOSED'].includes(ticket.status)) {
    return res.status(400).json({ error: 'You can rate a ticket once it is resolved' });
  }
  const { score, comment } = req.body || {};
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return res.status(400).json({ error: 'Score must be 1 to 5' });
  }
  db.prepare(`INSERT INTO ticket_ratings (ticket_id, user_id, score, comment) VALUES (?,?,?,?)
    ON CONFLICT(ticket_id) DO UPDATE SET score = excluded.score, comment = excluded.comment`)
    .run(ticket.id, req.user.id, score, comment ? String(comment).trim() : null);
  ticketHistory(ticket.id, req.user.id, 'RATED', `Satisfaction rating: ${score}/5`);
  audit(req.user.id, 'TICKET_RATED', 'ticket', ticket.id, String(score), req);
  res.status(201).json({ ok: true, score });
});

router.get('/:id/attachments/:attId', (req, res) => {
  const ticket = getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (!canSeeTicket(req.user, ticket)) return res.status(403).json({ error: 'Not permitted' });
  const att = db.prepare('SELECT * FROM ticket_attachments WHERE id = ? AND ticket_id = ?')
    .get(req.params.attId, ticket.id);
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  res.setHeader('Content-Type', att.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(att.original_name)}"`);
  res.sendFile(path.join(UPLOAD_DIR, att.stored_name));
});

module.exports = router;
