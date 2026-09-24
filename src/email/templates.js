const { db } = require('../db');

// ================= Admin-editable email templates (FR5 / FR7) =================
// Placeholders: {{incident_number}} {{caller_name}} {{short_description}}
// {{description}} {{status}} {{assignment_group}} {{priority}} {{category}}
// {{comment}} {{portal_link}} {{original_subject}} {{agent_name}}
// {{resolution_note}} {{conversation_history}} (text) and
// {{conversation_history_html}} (pre-rendered, HTML template only).
// Values are HTML-escaped in HTML templates except keys ending in _html.

// One template per ticket action that is mailed on the incident's thread.
// NOTIFY is the version sent to agents / leads (their in-app notification text).
const EVENT_TYPES = ['ACK', 'COMMENT', 'ASSIGNED', 'IN_PROGRESS', 'UPDATED', 'ON_HOLD', 'RESOLVED', 'CLOSED', 'REOPENED', 'NOTIFY', 'THREAD_ADDED'];
const OBSOLETE_TYPES = ['PRIORITY', 'GROUP'];
const PLACEHOLDERS = ['incident_number', 'caller_name', 'recipient_name', 'short_description', 'description', 'status',
  'assignment_group', 'priority', 'category', 'comment', 'portal_link', 'original_subject', 'agent_name',
  'resolution_note', 'conversation_history', 'conversation_history_html', 'added_by', 'participants'];

const SUBJECT = 'RE: {{original_subject}} [{{incident_number}}]';
const SUMMARY_TEXT = [
  'Incident: {{incident_number}}',
  'Summary: {{short_description}}',
  'Category: {{category}}',
  'Assigned group: {{assignment_group}}',
  'Priority: {{priority}}',
  'Status: {{status}}',
  '',
  'View in the self-service portal: {{portal_link}}',
  '',
  'Please reply to this email to add information. Keep [{{incident_number}}] in the subject line.',
  '',
  '— IT Service Desk',
].join('\n');
const SUMMARY_HTML = `
<table style="border-collapse:collapse;font-size:14px;margin:12px 0">
  <tr><td style="padding:3px 12px 3px 0;color:#666">Incident</td><td><b>{{incident_number}}</b></td></tr>
  <tr><td style="padding:3px 12px 3px 0;color:#666">Summary</td><td>{{short_description}}</td></tr>
  <tr><td style="padding:3px 12px 3px 0;color:#666">Category</td><td>{{category}}</td></tr>
  <tr><td style="padding:3px 12px 3px 0;color:#666">Assigned group</td><td>{{assignment_group}}</td></tr>
  <tr><td style="padding:3px 12px 3px 0;color:#666">Priority</td><td>{{priority}}</td></tr>
  <tr><td style="padding:3px 12px 3px 0;color:#666">Status</td><td>{{status}}</td></tr>
</table>
<p><a href="{{portal_link}}">View this incident in the self-service portal</a></p>
<p style="color:#666;font-size:13px">Please reply to this email to add information. Keep <b>[{{incident_number}}]</b> in the subject line.</p>
<p>— IT Service Desk</p>`;
const HISTORY_TEXT = '\n\n----- Conversation so far -----\n{{conversation_history}}';
const HISTORY_HTML = `
<div style="margin-top:18px;border-top:1px solid #ddd;padding-top:10px">
  <p style="color:#666;font-size:12px;margin:0 0 6px"><b>Conversation so far</b></p>
  {{conversation_history_html}}
</div>`;
const QUOTE = 'style="border-left:3px solid #ccc;margin:8px 0;padding:6px 12px;white-space:pre-wrap"';

function wrapHtml(lead, { history = true } = {}) {
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222">
<p>Hello {{caller_name}},</p>
${lead}
${SUMMARY_HTML}
${history ? HISTORY_HTML : ''}
</div>`;
}
function wrapText(lead, { history = true } = {}) {
  return `Hello {{caller_name}},\n\n${lead}\n\n${SUMMARY_TEXT}${history ? HISTORY_TEXT : ''}`;
}

const DEFAULTS = {
  ACK: {
    subject: SUBJECT,
    html: wrapHtml(`<p>Your request has been submitted successfully and incident <b>{{incident_number}}</b> has been created.</p><p><b>Your message:</b></p><blockquote ${QUOTE}>{{description}}</blockquote>`, { history: false }),
    text: wrapText('Your request has been submitted successfully and incident {{incident_number}} has been created.\n\nYour message:\n{{description}}', { history: false }),
  },
  COMMENT: {
    subject: SUBJECT,
    html: wrapHtml(`<p>{{agent_name}} added an update to your incident:</p><blockquote ${QUOTE}>{{comment}}</blockquote>`),
    text: wrapText('{{agent_name}} added an update to your incident:\n\n{{comment}}'),
  },
  ON_HOLD: {
    subject: SUBJECT,
    html: wrapHtml(`<p>Your incident <b>{{incident_number}}</b> is on hold and awaiting your input.</p><blockquote ${QUOTE}>{{comment}}</blockquote>`),
    text: wrapText('Your incident {{incident_number}} is on hold and awaiting your input.\n\n{{comment}}'),
  },
  RESOLVED: {
    subject: SUBJECT,
    html: wrapHtml(`<p>Your incident <b>{{incident_number}}</b> has been resolved.</p><p><b>Resolution:</b></p><blockquote ${QUOTE}>{{resolution_note}}</blockquote><p>If the issue persists, simply reply to this email and the incident will be reopened.</p>`),
    text: wrapText('Your incident {{incident_number}} has been resolved.\n\nResolution:\n{{resolution_note}}\n\nIf the issue persists, simply reply to this email and the incident will be reopened.'),
  },
  CLOSED: {
    subject: SUBJECT,
    html: wrapHtml('<p>Your incident <b>{{incident_number}}</b> has been closed. Thank you for contacting the IT Service Desk.</p><p>If you need further help, reply to this email and a new incident will be raised and linked to this one.</p>'),
    text: wrapText('Your incident {{incident_number}} has been closed. Thank you for contacting the IT Service Desk.\n\nIf you need further help, reply to this email and a new incident will be raised and linked to this one.'),
  },
  REOPENED: {
    subject: SUBJECT,
    html: wrapHtml('<p>Your incident <b>{{incident_number}}</b> has been reopened and the support team has been notified.</p>'),
    text: wrapText('Your incident {{incident_number}} has been reopened and the support team has been notified.'),
  },
  ASSIGNED: {
    subject: SUBJECT,
    html: wrapHtml('<p>Your incident <b>{{incident_number}}</b> has been assigned: {{comment}}.</p>'),
    text: wrapText('Your incident {{incident_number}} has been assigned: {{comment}}.'),
  },
  IN_PROGRESS: {
    subject: SUBJECT,
    html: wrapHtml('<p>{{agent_name}} has started working on your incident <b>{{incident_number}}</b>.</p>'),
    text: wrapText('{{agent_name}} has started working on your incident {{incident_number}}.'),
  },
  UPDATED: {
    subject: SUBJECT,
    html: wrapHtml('<p>{{agent_name}} updated the details of your incident <b>{{incident_number}}</b>: {{comment}}.</p>'),
    text: wrapText('{{agent_name}} updated the details of your incident {{incident_number}}: {{comment}}.'),
  },
  // Sent to people newly put on copy (and to them only): the whole conversation
  // so far, on the original thread, so their mail client files it with the chain.
  THREAD_ADDED: {
    subject: SUBJECT,
    html: `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222">
<p>Hello,</p>
<p>You have been added ({{added_by}}) to the email thread of incident <b>{{incident_number}}</b>. The conversation so far is below — reply to this email to take part, and you will be copied on every further update.</p>
${SUMMARY_HTML}
${HISTORY_HTML}
</div>`,
    text: `Hello,\n\nYou have been added ({{added_by}}) to the email thread of incident {{incident_number}}. The conversation so far is below — reply to this email to take part, and you will be copied on every further update.\n\n${SUMMARY_TEXT}${HISTORY_TEXT}`,
  },
  // Sent to agents / leads (not the caller) so their notifications sit on the same chain.
  NOTIFY: {
    subject: SUBJECT,
    html: `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222">
<p>Hello {{recipient_name}},</p>
<p>{{comment}}</p>
${SUMMARY_HTML.replace(/<p style="color:#666;font-size:13px">[\s\S]*?<\/p>\n/, '')}
${HISTORY_HTML}
</div>`,
    text: `Hello {{recipient_name}},\n\n{{comment}}\n\n${SUMMARY_TEXT.replace(/\nPlease reply to this email[^\n]*\n/, '')}${HISTORY_TEXT}`,
  },
};

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fill(template, vars, { html }) {
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    if (v === null || v === undefined) return '';
    if (html && key.endsWith('_html')) return String(v); // pre-rendered, already safe
    if (!html && key.endsWith('_html')) return '';
    return html ? escapeHtml(v).replace(/\n/g, '<br>') : String(v);
  });
}

// Seed missing templates; refresh the ones nobody customised so that new
// defaults (e.g. the conversation history block) reach existing installs.
function ensureTemplates() {
  const ins = db.prepare(`INSERT OR IGNORE INTO email_templates
    (event_type, subject_template, body_html_template, body_text_template, is_default) VALUES (?,?,?,?,1)`);
  const refresh = db.prepare(`UPDATE email_templates SET subject_template = ?, body_html_template = ?, body_text_template = ?
    WHERE event_type = ? AND is_default = 1
      AND (subject_template <> ? OR body_html_template <> ? OR body_text_template <> ?)`);
  for (const type of EVENT_TYPES) {
    const d = DEFAULTS[type];
    ins.run(type, d.subject, d.html, d.text);
    refresh.run(d.subject, d.html, d.text, type, d.subject, d.html, d.text);
  }
  for (const type of OBSOLETE_TYPES) db.prepare('DELETE FROM email_templates WHERE event_type = ?').run(type);
}

function getTemplate(eventType) {
  const row = db.prepare('SELECT * FROM email_templates WHERE event_type = ?').get(eventType);
  if (row) return row;
  const d = DEFAULTS[eventType];
  if (!d) throw new Error(`Unknown email template ${eventType}`);
  return { event_type: eventType, subject_template: d.subject, body_html_template: d.html, body_text_template: d.text, is_active: 1, is_default: 1 };
}

function renderTemplate(eventType, vars) {
  const t = getTemplate(eventType);
  return {
    active: !!t.is_active,
    subject: fill(t.subject_template, vars, { html: false }),
    html: fill(t.body_html_template, vars, { html: true }),
    text: fill(t.body_text_template, vars, { html: false }),
  };
}

function updateTemplate(eventType, patch, actorId) {
  if (!EVENT_TYPES.includes(eventType)) throw new Error('Unknown template type');
  ensureTemplates();
  const fields = [];
  const vals = [];
  for (const key of ['subject_template', 'body_html_template', 'body_text_template']) {
    if (patch[key] !== undefined) {
      if (!String(patch[key]).trim()) throw new Error(`${key} cannot be empty`);
      fields.push(`${key} = ?`); vals.push(String(patch[key]));
    }
  }
  if (fields.length) fields.push('is_default = 0');
  if (patch.is_active !== undefined) { fields.push('is_active = ?'); vals.push(patch.is_active ? 1 : 0); }
  if (!fields.length) return getTemplate(eventType);
  fields.push("updated_at = datetime('now')");
  vals.push(eventType);
  db.prepare(`UPDATE email_templates SET ${fields.join(', ')} WHERE event_type = ?`).run(...vals);
  if (actorId !== undefined) {
    const { audit } = require('../services');
    audit(actorId, 'EMAIL_TEMPLATE_UPDATED', 'email_template', eventType, Object.keys(patch).join(', '));
  }
  return getTemplate(eventType);
}

function resetTemplate(eventType) {
  const d = DEFAULTS[eventType];
  if (!d) throw new Error('Unknown template type');
  db.prepare(`INSERT INTO email_templates (event_type, subject_template, body_html_template, body_text_template, is_active, is_default)
    VALUES (?,?,?,?,1,1)
    ON CONFLICT(event_type) DO UPDATE SET subject_template = excluded.subject_template,
      body_html_template = excluded.body_html_template, body_text_template = excluded.body_text_template,
      is_active = 1, is_default = 1, updated_at = datetime('now')`).run(eventType, d.subject, d.html, d.text);
  return getTemplate(eventType);
}

module.exports = { EVENT_TYPES, PLACEHOLDERS, DEFAULTS, ensureTemplates, getTemplate, renderTemplate, updateTemplate, resetTemplate, escapeHtml };
