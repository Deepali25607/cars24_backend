const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ITSM_DB_PATH lets the test suite point at an isolated throwaway database.
const db = new Database(process.env.ITSM_DB_PATH || path.join(DATA_DIR, 'itsm.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  city TEXT,
  country TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS support_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'EMPLOYEE'
    CHECK (role IN ('EMPLOYEE','AGENT','TEAM_LEAD','ADMIN')),
  department_id INTEGER REFERENCES departments(id),
  location_id INTEGER REFERENCES locations(id),
  support_group_id INTEGER REFERENCES support_groups(id),
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  icon TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS subcategories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (category_id, name)
);

CREATE TABLE IF NOT EXISTS priorities (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  description TEXT,
  sort INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_tag TEXT NOT NULL UNIQUE,
  serial_number TEXT NOT NULL UNIQUE,
  manufacturer TEXT NOT NULL,
  model TEXT NOT NULL,
  hostname TEXT,
  operating_system TEXT,
  assigned_user_id INTEGER REFERENCES users(id),
  location_id INTEGER REFERENCES locations(id),
  warranty_until TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_number TEXT NOT NULL UNIQUE,
  requester_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  subcategory_id INTEGER REFERENCES subcategories(id),
  priority_id INTEGER NOT NULL REFERENCES priorities(id),
  status TEXT NOT NULL DEFAULT 'NEW'
    CHECK (status IN ('NEW','ASSIGNED','IN_PROGRESS','PENDING','RESOLVED','CLOSED','REOPENED')),
  support_group_id INTEGER REFERENCES support_groups(id),
  assigned_agent_id INTEGER REFERENCES users(id),
  asset_id INTEGER REFERENCES assets(id),
  location_id INTEGER REFERENCES locations(id),
  resolution_note TEXT,
  resolved_at TEXT,
  closed_at TEXT,
  reopen_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ticket_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  is_internal INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ticket_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  uploader_id INTEGER NOT NULL REFERENCES users(id),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ticket_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ===================== STANDARD PHASE (BRD section 7) =====================

-- S1: holiday calendar (business hours live in settings key 'business_hours')
CREATE TABLE IF NOT EXISTS holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

-- S2: SLA policies per priority + per-ticket SLA tracking
CREATE TABLE IF NOT EXISTS sla_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  priority_id INTEGER NOT NULL UNIQUE REFERENCES priorities(id),
  response_minutes INTEGER NOT NULL,
  resolution_minutes INTEGER NOT NULL,
  use_business_hours INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  approved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ticket_sla (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL UNIQUE REFERENCES tickets(id) ON DELETE CASCADE,
  policy_id INTEGER REFERENCES sla_policies(id),
  response_due_at TEXT,
  resolution_due_at TEXT,
  first_response_at TEXT,
  paused_at TEXT,
  paused_minutes INTEGER NOT NULL DEFAULT 0,
  response_breached INTEGER NOT NULL DEFAULT 0,
  resolution_breached INTEGER NOT NULL DEFAULT 0,
  warning_sent INTEGER NOT NULL DEFAULT 0,
  escalated INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT
);

-- S3: automated assignment rules (first match by sort wins)
CREATE TABLE IF NOT EXISTS assignment_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1,
  category_id INTEGER REFERENCES categories(id),
  subcategory_id INTEGER REFERENCES subcategories(id),
  priority_id INTEGER REFERENCES priorities(id),
  location_id INTEGER REFERENCES locations(id),
  department_id INTEGER REFERENCES departments(id),
  target_group_id INTEGER NOT NULL REFERENCES support_groups(id),
  target_agent_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- S4: knowledge management
CREATE TABLE IF NOT EXISTS kb_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_number TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','PENDING_APPROVAL','PUBLISHED','ARCHIVED')),
  version INTEGER NOT NULL DEFAULT 1,
  review_at TEXT,
  helpful_count INTEGER NOT NULL DEFAULT 0,
  not_helpful_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kb_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  editor_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kb_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  helpful INTEGER NOT NULL,
  UNIQUE (article_id, user_id)
);

CREATE TABLE IF NOT EXISTS kb_related (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  related_id INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  UNIQUE (article_id, related_id)
);

-- S5: service catalog + requests
CREATE TABLE IF NOT EXISTS catalog_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  icon TEXT,
  support_group_id INTEGER REFERENCES support_groups(id),
  requires_approval INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_number TEXT NOT NULL UNIQUE,
  requester_id INTEGER NOT NULL REFERENCES users(id),
  catalog_item_id INTEGER NOT NULL REFERENCES catalog_items(id),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'SUBMITTED'
    CHECK (status IN ('SUBMITTED','PENDING_APPROVAL','APPROVED','REJECTED','IN_FULFILLMENT','COMPLETED','CANCELLED')),
  support_group_id INTEGER REFERENCES support_groups(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS request_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  approver_role TEXT NOT NULL DEFAULT 'TEAM_LEAD',
  approver_id INTEGER REFERENCES users(id),
  level INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  note TEXT,
  acted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS request_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  assigned_agent_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','IN_PROGRESS','DONE')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_at TEXT
);

-- S7: asset lifecycle history (lifecycle columns added via ensureColumn below)
CREATE TABLE IF NOT EXISTS asset_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- S8: workflow engine
CREATE TABLE IF NOT EXISTS workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  trigger_event TEXT NOT NULL,
  conditions_json TEXT NOT NULL DEFAULT '[]',
  actions_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflow_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER REFERENCES workflows(id) ON DELETE CASCADE,
  ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
  actions_json TEXT NOT NULL,
  run_at TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- S10: email-to-ticket — inbound_emails was replaced by email_message_log
-- (see the email-channel block below; legacy rows are migrated on boot).

-- S12: saved searches
CREATE TABLE IF NOT EXISTS saved_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- S11: per-user notification preferences
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_enabled INTEGER NOT NULL DEFAULT 1
);

-- S15: API tokens for external integrations
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id),
  active INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== ADVANCED PHASE (BRD section 8) =====================

-- A1: CMDB (BRD 8.3)
CREATE TABLE IF NOT EXISTS cis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ci_number TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  ci_type TEXT NOT NULL
    CHECK (ci_type IN ('BUSINESS_SERVICE','APPLICATION','SERVER','LAPTOP','NETWORK_DEVICE')),
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','INACTIVE','RETIRED')),
  asset_id INTEGER REFERENCES assets(id),
  owner_user_id INTEGER REFERENCES users(id),
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ci_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
  child_id INTEGER NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL DEFAULT 'DEPENDS_ON'
    CHECK (relation_type IN ('DEPENDS_ON','RUNS_ON','USED_BY','CONNECTS_TO')),
  UNIQUE (parent_id, child_id, relation_type)
);

-- A2: Problem Management (BRD 8.4)
CREATE TABLE IF NOT EXISTS problems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_number TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'NEW'
    CHECK (status IN ('NEW','ROOT_CAUSE_ANALYSIS','KNOWN_ERROR','RESOLVED','CLOSED')),
  root_cause TEXT,
  workaround TEXT,
  permanent_fix TEXT,
  category_id INTEGER REFERENCES categories(id),
  priority_id INTEGER REFERENCES priorities(id),
  support_group_id INTEGER REFERENCES support_groups(id),
  assigned_agent_id INTEGER REFERENCES users(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS problem_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  UNIQUE (problem_id, ticket_id)
);

CREATE TABLE IF NOT EXISTS problem_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','IN_PROGRESS','DONE')),
  assigned_agent_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_at TEXT
);

-- A3: Change Management (BRD 8.5)
CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_number TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  change_type TEXT NOT NULL DEFAULT 'NORMAL'
    CHECK (change_type IN ('STANDARD','NORMAL','EMERGENCY')),
  risk TEXT NOT NULL DEFAULT 'MEDIUM'
    CHECK (risk IN ('LOW','MEDIUM','HIGH')),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','SCHEDULED','IN_PROGRESS','COMPLETED','FAILED','CANCELLED')),
  implementation_plan TEXT,
  backout_plan TEXT,
  planned_start TEXT,
  planned_end TEXT,
  requested_by INTEGER NOT NULL REFERENCES users(id),
  support_group_id INTEGER REFERENCES support_groups(id),
  pir_outcome TEXT
    CHECK (pir_outcome IN ('SUCCESSFUL','COMPLETED_WITH_ISSUES','BACKED_OUT')),
  pir_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS change_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id INTEGER NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  approver_role TEXT NOT NULL DEFAULT 'TEAM_LEAD',
  approver_id INTEGER REFERENCES users(id),
  level INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  note TEXT,
  acted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS change_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id INTEGER NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','IN_PROGRESS','DONE')),
  assigned_agent_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_at TEXT
);

CREATE TABLE IF NOT EXISTS change_cis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id INTEGER NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  ci_id INTEGER NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
  UNIQUE (change_id, ci_id)
);

-- A4: Major Incident Management (BRD 8.6) — flag columns added via ensureColumn
CREATE TABLE IF NOT EXISTS mi_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  update_type TEXT NOT NULL DEFAULT 'UPDATE'
    CHECK (update_type IN ('UPDATE','REVIEW')),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mi_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  major_ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  UNIQUE (major_ticket_id, ticket_id)
);

-- A8: customer satisfaction rating (data source for CSAT analytics)
CREATE TABLE IF NOT EXISTS ticket_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL UNIQUE REFERENCES tickets(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A9: event/monitoring integration
CREATE TABLE IF NOT EXISTS inbound_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT,
  source TEXT,
  severity TEXT,
  subject TEXT,
  body TEXT,
  ticket_id INTEGER REFERENCES tickets(id),
  status TEXT NOT NULL DEFAULT 'PROCESSED',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cis_type ON cis(ci_type);
CREATE INDEX IF NOT EXISTS idx_ci_rel_parent ON ci_relationships(parent_id);
CREATE INDEX IF NOT EXISTS idx_problem_tickets ON problem_tickets(problem_id);
CREATE INDEX IF NOT EXISTS idx_changes_status ON changes(status);
CREATE INDEX IF NOT EXISTS idx_mi_links_major ON mi_links(major_ticket_id);
CREATE INDEX IF NOT EXISTS idx_inbound_events_key ON inbound_events(dedupe_key);

CREATE INDEX IF NOT EXISTS idx_ticket_sla_ticket ON ticket_sla(ticket_id);
CREATE INDEX IF NOT EXISTS idx_kb_status ON kb_articles(status);
CREATE INDEX IF NOT EXISTS idx_requests_requester ON requests(requester_id);
CREATE INDEX IF NOT EXISTS idx_req_approvals_approver ON request_approvals(approver_id, status);
CREATE INDEX IF NOT EXISTS idx_asset_history_asset ON asset_history(asset_id);
CREATE INDEX IF NOT EXISTS idx_workflow_jobs_due ON workflow_jobs(done, run_at);

CREATE INDEX IF NOT EXISTS idx_tickets_requester ON tickets(requester_id);
CREATE INDEX IF NOT EXISTS idx_tickets_agent ON tickets(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_tickets_group ON tickets(support_group_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_comments_ticket ON ticket_comments(ticket_id);
CREATE INDEX IF NOT EXISTS idx_history_ticket ON ticket_history(ticket_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);
`);

// STANDARD: additive column migrations for tables that predate this phase.
// SQLite has no IF NOT EXISTS for columns, so check pragma first.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('assets', 'status', "status TEXT NOT NULL DEFAULT 'IN_STOCK'");
ensureColumn('assets', 'vendor', 'vendor TEXT');
ensureColumn('assets', 'purchase_date', 'purchase_date TEXT');
ensureColumn('assets', 'purchase_cost', 'purchase_cost REAL');
ensureColumn('assets', 'retired_at', 'retired_at TEXT');
// ADVANCED: major-incident flags on tickets (BRD 8.6)
ensureColumn('tickets', 'is_major', 'is_major INTEGER NOT NULL DEFAULT 0');
ensureColumn('tickets', 'major_commander_id', 'major_commander_id INTEGER REFERENCES users(id)');
ensureColumn('tickets', 'major_bridge', 'major_bridge TEXT');
ensureColumn('tickets', 'major_declared_at', 'major_declared_at TEXT');

// ================= Email channel (S10 extension: two-way email sync) =================
// Ticket/comment provenance columns (additive, default to portal behaviour).
ensureColumn('tickets', 'source', "source TEXT NOT NULL DEFAULT 'PORTAL'");
ensureColumn('tickets', 'original_message_id', 'original_message_id TEXT');
ensureColumn('tickets', 'thread_subject', 'thread_subject TEXT');
ensureColumn('tickets', 'caller_email', 'caller_email TEXT');
ensureColumn('tickets', 'caller_unverified', 'caller_unverified INTEGER NOT NULL DEFAULT 0');
ensureColumn('tickets', 'cc_list', 'cc_list TEXT');
ensureColumn('tickets', 'related_ticket_id', 'related_ticket_id INTEGER REFERENCES tickets(id)');
ensureColumn('ticket_comments', 'source', "source TEXT NOT NULL DEFAULT 'PORTAL'");
ensureColumn('ticket_comments', 'sender_email', 'sender_email TEXT');
ensureColumn('ticket_comments', 'email_log_id', 'email_log_id INTEGER');
ensureColumn('ticket_comments', 'external_participant', 'external_participant INTEGER NOT NULL DEFAULT 0');

db.exec(`
CREATE TABLE IF NOT EXISTS email_message_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER REFERENCES tickets(id),
  message_id TEXT UNIQUE,
  in_reply_to TEXT,
  references_header TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  from_address TEXT,
  from_name TEXT,
  to_addresses TEXT,
  cc_addresses TEXT,
  subject TEXT,
  body_text TEXT,
  body_html_raw TEXT,
  received_or_sent_at TEXT,
  processing_status TEXT NOT NULL DEFAULT 'PROCESSED'
    CHECK (processing_status IN ('PENDING','PROCESSED','IGNORED','QUARANTINED','FAILED','DISCARDED')),
  ignore_reason TEXT,
  event_type TEXT,
  raw_headers TEXT,
  raw_source TEXT,
  attachments_json TEXT,
  auth_results TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_log_ticket ON email_message_log(ticket_id, id);
CREATE INDEX IF NOT EXISTS idx_email_log_status ON email_message_log(processing_status, direction);
CREATE INDEX IF NOT EXISTS idx_email_log_from ON email_message_log(from_address, created_at);
CREATE INDEX IF NOT EXISTS idx_email_log_reply ON email_message_log(in_reply_to);

CREATE TABLE IF NOT EXISTS email_classification_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  subcategory_id INTEGER REFERENCES subcategories(id),
  keyword TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  assignment_group_id INTEGER REFERENCES support_groups(id),
  default_priority_id INTEGER REFERENCES priorities(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL UNIQUE
    CHECK (event_type IN ('ACK','COMMENT','ON_HOLD','RESOLVED','CLOSED','REOPENED','PRIORITY','GROUP')),
  subject_template TEXT NOT NULL,
  body_html_template TEXT NOT NULL,
  body_text_template TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_channel_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  mailbox_address TEXT,
  system_addresses TEXT,
  allowed_domains TEXT,
  unknown_sender_action TEXT NOT NULL DEFAULT 'QUARANTINE'
    CHECK (unknown_sender_action IN ('QUARANTINE','REJECT')),
  auth_check_mode TEXT NOT NULL DEFAULT 'QUARANTINE_FAIL'
    CHECK (auth_check_mode IN ('OFF','QUARANTINE_FAIL')),
  polling_interval_seconds INTEGER NOT NULL DEFAULT 60,
  reopen_window_days INTEGER NOT NULL DEFAULT 7,
  max_attachment_mb INTEGER NOT NULL DEFAULT 10,
  max_total_attachment_mb INTEGER NOT NULL DEFAULT 25,
  attachment_violation_action TEXT NOT NULL DEFAULT 'QUARANTINE'
    CHECK (attachment_violation_action IN ('QUARANTINE','STRIP')),
  inline_image_min_kb INTEGER NOT NULL DEFAULT 10,
  rate_limit_per_hour INTEGER NOT NULL DEFAULT 10,
  triage_group_id INTEGER REFERENCES support_groups(id),
  general_category_id INTEGER REFERENCES categories(id),
  subject_weight INTEGER NOT NULL DEFAULT 2,
  body_weight INTEGER NOT NULL DEFAULT 1,
  notify_on_priority_change INTEGER NOT NULL DEFAULT 0,
  notify_on_group_change INTEGER NOT NULL DEFAULT 0,
  portal_url TEXT,
  processed_folder TEXT NOT NULL DEFAULT 'Processed',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('INBOUND','OUTBOUND')),
  message_id TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','RUNNING','DONE','DEAD','DISCARDED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_run_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_jobs_due ON email_jobs(status, next_run_at);
`);

// Templates still at their shipped default are refreshed when defaults evolve;
// admin-edited ones (is_default = 0) are left alone.
ensureColumn('email_templates', 'is_default', 'is_default INTEGER NOT NULL DEFAULT 1');
// Which ticket actions are mailed to the caller on the thread (all on by default).
ensureColumn('email_channel_config', 'notify_on_assignment', 'notify_on_assignment INTEGER NOT NULL DEFAULT 1');
ensureColumn('email_channel_config', 'notify_on_update', 'notify_on_update INTEGER NOT NULL DEFAULT 1');
ensureColumn('email_channel_config', 'notify_on_progress', 'notify_on_progress INTEGER NOT NULL DEFAULT 1');
// 0 = agents/leads get in-app notifications only (one mail chain per incident);
// 1 = they also receive a copy on the incident's thread.
ensureColumn('email_channel_config', 'thread_internal_notifications', 'thread_internal_notifications INTEGER NOT NULL DEFAULT 0');
// 1 = the assigned agent is CC'd on every thread mail to the caller.
ensureColumn('email_channel_config', 'cc_assigned_agent', 'cc_assigned_agent INTEGER NOT NULL DEFAULT 1');

// The event-type CHECK on email_templates was too narrow once assignment /
// progress / update / internal-notification events were added: rebuild the
// table without it (validation lives in src/email/templates.js). Idempotent.
(function migrateEmailTemplates() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'email_templates'").get();
  if (!row || !/CHECK\s*\(\s*event_type IN/i.test(row.sql)) return;
  db.exec(`
    ALTER TABLE email_templates RENAME TO email_templates_legacy;
    CREATE TABLE email_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL UNIQUE,
      subject_template TEXT NOT NULL,
      body_html_template TEXT NOT NULL,
      body_text_template TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO email_templates (id, event_type, subject_template, body_html_template, body_text_template, is_active, is_default, updated_at)
      SELECT id, event_type, subject_template, body_html_template, body_text_template, is_active, is_default, updated_at
      FROM email_templates_legacy;
    DROP TABLE email_templates_legacy;
  `);
  console.log('[migrate] rebuilt email_templates without the event_type CHECK');
})();

// One-time migration: the Standard-phase inbound_emails table is replaced by
// email_message_log. Copy rows across (skipping duplicates) and drop the table.
(function migrateInboundEmails() {
  const legacy = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbound_emails'"
  ).get();
  if (!legacy) return;
  const rows = db.prepare('SELECT * FROM inbound_emails ORDER BY id').all();
  const statusMap = { CREATED: 'PROCESSED', THREADED: 'PROCESSED', REJECTED: 'QUARANTINED', FAILED: 'FAILED' };
  const ins = db.prepare(`INSERT OR IGNORE INTO email_message_log
    (ticket_id, message_id, direction, from_address, subject, body_text, received_or_sent_at,
     processing_status, ignore_reason, event_type, created_at)
    VALUES (?,?,'INBOUND',?,?,?,?,?,?,?,?)`);
  for (const r of rows) {
    ins.run(r.ticket_id, r.message_id, r.from_email, r.subject, r.body, r.created_at,
      statusMap[r.status] || 'PROCESSED', r.error, r.status, r.created_at);
  }
  db.exec('DROP TABLE inbound_emails');
  if (rows.length) console.log(`[migrate] moved ${rows.length} inbound_emails row(s) to email_message_log`);
})();

// Repair migration (DEF-A-001): databases booted against a pre-release
// intermediate build have request_approvals without approver_role (and with
// approver_id NOT NULL). SQLite cannot alter constraints, so rebuild the
// table in place, preserving any rows. Idempotent — runs only when needed.
(function migrateRequestApprovals() {
  const cols = db.prepare('PRAGMA table_info(request_approvals)').all();
  if (!cols.length || cols.some((c) => c.name === 'approver_role')) return;
  db.exec(`
    ALTER TABLE request_approvals RENAME TO request_approvals_legacy;
    CREATE TABLE request_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      approver_role TEXT NOT NULL DEFAULT 'TEAM_LEAD',
      approver_id INTEGER REFERENCES users(id),
      level INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING','APPROVED','REJECTED')),
      note TEXT,
      acted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO request_approvals (id, request_id, approver_id, level, status, note, acted_at, created_at)
      SELECT id, request_id, approver_id, level, status, note, acted_at, created_at
      FROM request_approvals_legacy;
    DROP TABLE request_approvals_legacy;
  `);
  console.log('[migrate] rebuilt request_approvals with approver_role (DEF-A-001)');
})();

// Generic sequence generator backed by the settings table.
function nextNumber(key, prefix, start) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const next = row ? Number(row.value) + 1 : start;
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(next));
  return `${prefix}-${String(next).padStart(6, '0')}`;
}

function nextTicketNumber() { return nextNumber('ticket_seq', 'INC', 1001); }
function nextRequestNumber() { return nextNumber('request_seq', 'REQ', 1001); }
function nextArticleNumber() { return nextNumber('kb_seq', 'KB', 1001); }
function nextCiNumber() { return nextNumber('ci_seq', 'CI', 1001); }
function nextProblemNumber() { return nextNumber('prb_seq', 'PRB', 1001); }
function nextChangeNumber() { return nextNumber('chg_seq', 'CHG', 1001); }

module.exports = {
  db, nextTicketNumber, nextRequestNumber, nextArticleNumber,
  nextCiNumber, nextProblemNumber, nextChangeNumber, ensureColumn,
};
