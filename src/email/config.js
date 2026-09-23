const { db } = require('../db');

// ================= Email channel configuration =================
// Single-row table (id = 1) edited from Admin → Email channel. Environment
// variables only supply what must stay out of the database (credentials) or
// sensible fallbacks (mailbox address, portal URL).

const EDITABLE = [
  'enabled', 'mailbox_address', 'system_addresses', 'allowed_domains',
  'unknown_sender_action', 'auth_check_mode', 'polling_interval_seconds',
  'reopen_window_days', 'max_attachment_mb', 'max_total_attachment_mb',
  'attachment_violation_action', 'inline_image_min_kb', 'rate_limit_per_hour',
  'triage_group_id', 'general_category_id', 'subject_weight', 'body_weight',
  'notify_on_priority_change', 'notify_on_group_change', 'portal_url',
  'processed_folder', 'notify_on_assignment', 'notify_on_update', 'notify_on_progress',
  'thread_internal_notifications', 'cc_assigned_agent',
];
const INT_FIELDS = new Set([
  'enabled', 'polling_interval_seconds', 'reopen_window_days', 'max_attachment_mb',
  'max_total_attachment_mb', 'inline_image_min_kb', 'rate_limit_per_hour',
  'triage_group_id', 'general_category_id', 'subject_weight', 'body_weight',
  'notify_on_priority_change', 'notify_on_group_change', 'notify_on_assignment',
  'notify_on_update', 'notify_on_progress', 'thread_internal_notifications', 'cc_assigned_agent',
]);
const ENUMS = {
  unknown_sender_action: ['QUARANTINE', 'REJECT'],
  auth_check_mode: ['OFF', 'QUARANTINE_FAIL'],
  attachment_violation_action: ['QUARANTINE', 'STRIP'],
};

function splitList(value) {
  return String(value || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function ensureRow() {
  let row = db.prepare('SELECT * FROM email_channel_config WHERE id = 1').get();
  if (row) return row;
  const triage = db.prepare("SELECT id FROM support_groups WHERE name = 'Service Desk Triage'").get();
  const general = db.prepare("SELECT id FROM categories WHERE name = 'General'").get();
  db.prepare(`INSERT INTO email_channel_config
    (id, enabled, mailbox_address, allowed_domains, triage_group_id, general_category_id)
    VALUES (1, 1, ?, ?, ?, ?)`)
    .run(process.env.MAIL_IN_USER || process.env.SMTP_FROM || null,
      process.env.EMAIL_ALLOWED_DOMAINS || 'cars24.com',
      triage?.id ?? null, general?.id ?? null);
  row = db.prepare('SELECT * FROM email_channel_config WHERE id = 1').get();
  return row;
}

function getConfig() {
  const row = ensureRow();
  const mailbox = (row.mailbox_address || process.env.MAIL_IN_USER || process.env.SMTP_FROM || '')
    .trim().toLowerCase();
  return {
    ...row,
    mailboxAddress: mailbox || null,
    systemAddresses: new Set([mailbox, ...splitList(row.system_addresses)].filter(Boolean)),
    allowedDomains: splitList(row.allowed_domains),
    portalUrl: (row.portal_url || process.env.PORTAL_URL || 'http://localhost:5173').replace(/\/+$/, ''),
  };
}

function updateConfig(patch, actorId) {
  ensureRow();
  const sets = [];
  const vals = [];
  for (const key of EDITABLE) {
    if (!(key in (patch || {}))) continue;
    let v = patch[key];
    if (INT_FIELDS.has(key)) {
      if (v === '' || v === null || v === undefined) v = null;
      else {
        v = Number(v);
        if (!Number.isFinite(v) || v < 0) throw new Error(`Invalid value for ${key}`);
        v = Math.round(v);
      }
      if (v === null && !['triage_group_id', 'general_category_id'].includes(key)) {
        throw new Error(`${key} is required`);
      }
    } else if (ENUMS[key]) {
      v = String(v || '').toUpperCase();
      if (!ENUMS[key].includes(v)) throw new Error(`Invalid value for ${key}`);
    } else {
      v = v === null || v === undefined ? null : String(v).trim();
      if (v === '') v = null;
    }
    sets.push(`${key} = ?`);
    vals.push(v);
  }
  if (!sets.length) return getConfig();
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE email_channel_config SET ${sets.join(', ')} WHERE id = 1`).run(...vals);
  if (actorId !== undefined) {
    const { audit } = require('../services');
    audit(actorId, 'EMAIL_CONFIG_UPDATED', 'email_channel_config', 1, Object.keys(patch).join(', '));
  }
  return getConfig();
}

module.exports = { getConfig, updateConfig, splitList, EDITABLE };
