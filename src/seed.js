const bcrypt = require('bcryptjs');
const { db } = require('./db');

// Idempotent seed: runs on startup, inserts reference data + demo accounts
// only when the corresponding tables are empty.
function seed() {
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  if (db.prepare('SELECT COUNT(*) AS n FROM priorities').get().n === 0) {
    const ins = db.prepare(
      'INSERT INTO priorities (id, code, label, description, sort) VALUES (?,?,?,?,?)'
    );
    ins.run(1, 'P1', 'Critical', 'Work is fully blocked; no workaround.', 1);
    ins.run(2, 'P2', 'High', 'Major function impacted; workaround is difficult.', 2);
    ins.run(3, 'P3', 'Medium', 'Partial impact; a workaround exists.', 3);
    ins.run(4, 'P4', 'Low', 'Minor issue or question; no urgency.', 4);
  }

  if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n === 0) {
    const cat = db.prepare('INSERT INTO categories (name, icon) VALUES (?,?)');
    const sub = db.prepare('INSERT INTO subcategories (category_id, name) VALUES (?,?)');
    const data = {
      Hardware: ['Power', 'Battery', 'Keyboard', 'Touchpad', 'Display', 'Camera',
        'Speaker', 'Microphone', 'Charging', 'USB', 'Physical Damage'],
      'Operating System': ['Boot issue', 'Blue screen', 'Windows update', 'Driver',
        'Login', 'Performance'],
      Software: ['Outlook', 'Teams', 'Office', 'Browser', 'Business application',
        'Application crash'],
      Network: ['Wi-Fi', 'LAN', 'VPN', 'Internet'],
      Security: ['Antivirus', 'Malware', 'BitLocker', 'Suspicious activity'],
      Access: ['Password', 'MFA', 'Account lock', 'Application access'],
      Peripheral: ['Monitor', 'Dock', 'Keyboard', 'Mouse', 'Headset'],
    };
    const icons = {
      Hardware: 'laptop', 'Operating System': 'cpu', Software: 'apps',
      Network: 'wifi', Security: 'shield', Access: 'key', Peripheral: 'plug',
    };
    for (const [name, subs] of Object.entries(data)) {
      const { lastInsertRowid } = cat.run(name, icons[name]);
      for (const s of subs) sub.run(lastInsertRowid, s);
    }
  }

  if (userCount > 0) return; // demo org data only on first run

  const dep = db.prepare('INSERT INTO departments (name) VALUES (?)');
  const depIds = {};
  for (const d of ['Engineering', 'Finance', 'Human Resources', 'Sales', 'IT Operations']) {
    depIds[d] = dep.run(d).lastInsertRowid;
  }

  const loc = db.prepare('INSERT INTO locations (name, city, country) VALUES (?,?,?)');
  const locIds = {};
  locIds['Noida HQ'] = loc.run('Noida HQ', 'Noida', 'India').lastInsertRowid;
  locIds['Bengaluru Office'] = loc.run('Bengaluru Office', 'Bengaluru', 'India').lastInsertRowid;
  locIds['Remote'] = loc.run('Remote', null, null).lastInsertRowid;

  const grp = db.prepare('INSERT INTO support_groups (name, description) VALUES (?,?)');
  const grpIds = {};
  grpIds['Desktop Support'] = grp.run('Desktop Support', 'Laptop hardware, OS and software issues').lastInsertRowid;
  grpIds['Network Team'] = grp.run('Network Team', 'Connectivity, VPN and network access').lastInsertRowid;
  grpIds['Security Team'] = grp.run('Security Team', 'Security incidents and access control').lastInsertRowid;

  const hash = bcrypt.hashSync('Passw0rd!', 10);
  const usr = db.prepare(`INSERT INTO users
    (email, password_hash, full_name, role, department_id, location_id, support_group_id)
    VALUES (?,?,?,?,?,?,?)`);
  const uid = {};
  uid.admin = usr.run('admin@itsm.local', hash, 'Meera Iyer', 'ADMIN',
    depIds['IT Operations'], locIds['Noida HQ'], null).lastInsertRowid;
  uid.lead = usr.run('lead@itsm.local', hash, 'Arjun Nair', 'TEAM_LEAD',
    depIds['IT Operations'], locIds['Noida HQ'], grpIds['Desktop Support']).lastInsertRowid;
  uid.agent1 = usr.run('agent@itsm.local', hash, 'Sana Qureshi', 'AGENT',
    depIds['IT Operations'], locIds['Noida HQ'], grpIds['Desktop Support']).lastInsertRowid;
  uid.agent2 = usr.run('agent2@itsm.local', hash, 'Vikram Rao', 'AGENT',
    depIds['IT Operations'], locIds['Bengaluru Office'], grpIds['Network Team']).lastInsertRowid;
  uid.emp = usr.run('employee@itsm.local', hash, 'Deepali Gupta', 'EMPLOYEE',
    depIds['Engineering'], locIds['Noida HQ'], null).lastInsertRowid;
  uid.emp2 = usr.run('rohit@itsm.local', hash, 'Rohit Sharma', 'EMPLOYEE',
    depIds['Finance'], locIds['Bengaluru Office'], null).lastInsertRowid;

  const asset = db.prepare(`INSERT INTO assets
    (asset_tag, serial_number, manufacturer, model, hostname, operating_system,
     assigned_user_id, location_id, warranty_until)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  asset.run('LAP-0001', '5CD1234ABC', 'Dell', 'Latitude 5440', 'NOIDA-LT-0001',
    'Windows 11 Pro', uid.emp, locIds['Noida HQ'], '2027-03-31');
  asset.run('LAP-0002', '5CD5678DEF', 'Lenovo', 'ThinkPad T14 Gen 4', 'BLR-LT-0002',
    'Windows 11 Pro', uid.emp2, locIds['Bengaluru Office'], '2026-11-30');
  asset.run('LAP-0003', 'C02XYZ9GHJ', 'Apple', 'MacBook Pro 14', 'NOIDA-MB-0003',
    'macOS Sonoma', uid.lead, locIds['Noida HQ'], '2026-06-15');
  asset.run('LAP-0004', 'PF3TSTK00', 'HP', 'EliteBook 840 G10', null,
    'Windows 11 Pro', null, locIds['Noida HQ'], '2028-01-31');

  console.log('[seed] Demo data created. All demo accounts use password: Passw0rd!');
}

// ================= STANDARD phase seed (idempotent) =================
function seedStandard() {
  // S2: SLA policies — BRD 7.4 example matrix, seeded as admin-configurable
  // defaults with approved = 0 until the customer formally approves values.
  // P1/P2 run on the 24x7 clock; P3/P4 on business hours (9h business day).
  if (db.prepare('SELECT COUNT(*) AS n FROM sla_policies').get().n === 0) {
    const ins = db.prepare(`INSERT INTO sla_policies
      (priority_id, response_minutes, resolution_minutes, use_business_hours, approved)
      VALUES (?,?,?,?,0)`);
    ins.run(1, 15, 240, 0);        // P1: respond 15m, resolve 4h
    ins.run(2, 30, 480, 0);        // P2: respond 30m, resolve 8h
    ins.run(3, 240, 1080, 1);      // P3: respond 4 business hrs, resolve 2 business days
    ins.run(4, 480, 2700, 1);      // P4: respond 8 business hrs, resolve 5 business days
  }

  // S5: service catalog — BRD 7.7 example items
  if (db.prepare('SELECT COUNT(*) AS n FROM catalog_items').get().n === 0) {
    const grp = (name) => db.prepare('SELECT id FROM support_groups WHERE name = ?').get(name)?.id ?? null;
    const desktop = grp('Desktop Support');
    const network = grp('Network Team');
    const security = grp('Security Team');
    const ins = db.prepare(`INSERT INTO catalog_items
      (name, description, icon, support_group_id, requires_approval) VALUES (?,?,?,?,?)`);
    ins.run('New Laptop', 'Request a new laptop for a new joiner or role change.', 'laptop', desktop, 1);
    ins.run('Laptop Replacement', 'Replace a damaged, ageing or end-of-life laptop.', 'laptop', desktop, 1);
    ins.run('Software Installation', 'Install licensed software on your laptop.', 'apps', desktop, 1);
    ins.run('VPN Access', 'Request VPN connectivity for remote work.', 'wifi', network, 1);
    ins.run('Application Access', 'Request access to a business application.', 'key', security, 1);
    ins.run('Monitor Request', 'Request an external monitor.', 'plug', desktop, 0);
    ins.run('Keyboard Request', 'Request an external keyboard.', 'plug', desktop, 0);
    ins.run('Mouse Request', 'Request an external mouse.', 'plug', desktop, 0);
    ins.run('Headset Request', 'Request a headset for calls and meetings.', 'plug', desktop, 0);
  }

  // S3: default assignment rules mirroring the BRD 7.5 example (admin-editable)
  if (db.prepare('SELECT COUNT(*) AS n FROM assignment_rules').get().n === 0) {
    const cat = (name) => db.prepare('SELECT id FROM categories WHERE name = ?').get(name)?.id ?? null;
    const grp = (name) => db.prepare('SELECT id FROM support_groups WHERE name = ?').get(name)?.id ?? null;
    const ins = db.prepare(`INSERT INTO assignment_rules
      (name, sort, category_id, target_group_id) VALUES (?,?,?,?)`);
    const pairs = [
      ['Hardware → Desktop Support', 10, cat('Hardware'), grp('Desktop Support')],
      ['Operating System → Desktop Support', 20, cat('Operating System'), grp('Desktop Support')],
      ['Software → Desktop Support', 30, cat('Software'), grp('Desktop Support')],
      ['Peripheral → Desktop Support', 40, cat('Peripheral'), grp('Desktop Support')],
      ['Network → Network Team', 50, cat('Network'), grp('Network Team')],
      ['Security → Security Team', 60, cat('Security'), grp('Security Team')],
      ['Access → Security Team', 70, cat('Access'), grp('Security Team')],
    ];
    for (const [name, sort, catId, grpId] of pairs) {
      if (catId && grpId) ins.run(name, sort, catId, grpId);
    }
  }

  // S7: one-time sync of the new asset lifecycle status column for rows
  // created during Basic (default 'IN_STOCK' even when assigned).
  db.prepare(`UPDATE assets SET status = 'ASSIGNED'
    WHERE assigned_user_id IS NOT NULL AND status = 'IN_STOCK'`).run();

  // DEF-A-001: dedupe approval rows first (rapid restart races could insert
  // the chain more than once; duplicates would deadlock the approve flow).
  db.prepare(`DELETE FROM request_approvals WHERE id NOT IN (
    SELECT MIN(id) FROM request_approvals GROUP BY request_id, approver_role, level)`).run();

  // DEF-A-001 backfill: requests stranded in PENDING_APPROVAL with no
  // approval rows (created while request_approvals had the legacy schema).
  // Recreate their approval chain and notify approvers. Idempotent.
  const stranded = db.prepare(`
    SELECT r.id, r.request_number, ci.name AS item_name
    FROM requests r JOIN catalog_items ci ON ci.id = r.catalog_item_id
    WHERE r.status = 'PENDING_APPROVAL'
      AND NOT EXISTS (SELECT 1 FROM request_approvals ra WHERE ra.request_id = r.id)`).all();
  if (stranded.length) {
    const { notifyUser } = require('./services');
    const approvers = db.prepare(
      "SELECT id FROM users WHERE role IN ('TEAM_LEAD','ADMIN') AND active = 1"
    ).all();
    for (const r of stranded) {
      db.prepare("INSERT INTO request_approvals (request_id, approver_role, level) VALUES (?, 'TEAM_LEAD', 1)").run(r.id);
      db.prepare("INSERT INTO request_approvals (request_id, approver_role, level) VALUES (?, 'ADMIN', 2)").run(r.id);
      for (const a of approvers) {
        notifyUser(a.id, null, 'REQUEST_APPROVAL', `Request ${r.request_number} (${r.item_name}) awaits approval.`);
      }
    }
    console.log(`[seed] repaired approval chain for ${stranded.length} stranded request(s) (DEF-A-001)`);
  }
}

// ================= ADVANCED phase seed (idempotent) =================
function seedAdvanced() {
  // A1: CMDB — a CI for every laptop in the asset repository (kept in sync on
  // boot), plus starter business-service/application CIs on first run.
  const { nextCiNumber } = require('./db');
  const laptops = db.prepare(`
    SELECT a.id, a.asset_tag, a.manufacturer, a.model
    FROM assets a
    WHERE NOT EXISTS (SELECT 1 FROM cis c WHERE c.asset_id = a.id)`).all();
  const insCi = db.prepare(
    'INSERT INTO cis (ci_number, name, ci_type, asset_id, description) VALUES (?,?,?,?,?)'
  );
  for (const a of laptops) {
    insCi.run(nextCiNumber(), `${a.asset_tag} — ${a.manufacturer} ${a.model}`, 'LAPTOP', a.id,
      'Auto-created from the laptop asset repository');
  }

  if (db.prepare("SELECT COUNT(*) AS n FROM cis WHERE ci_type != 'LAPTOP'").get().n === 0) {
    const svc = insCi.run(nextCiNumber(), 'Employee IT Services', 'BUSINESS_SERVICE', null,
      'End-user computing business service').lastInsertRowid;
    const email = insCi.run(nextCiNumber(), 'Email (Exchange Online)', 'APPLICATION', null,
      'Corporate email service').lastInsertRowid;
    const vpnApp = insCi.run(nextCiNumber(), 'Corporate VPN', 'APPLICATION', null,
      'Remote access VPN').lastInsertRowid;
    const rel = db.prepare(
      "INSERT OR IGNORE INTO ci_relationships (parent_id, child_id, relation_type) VALUES (?,?,'DEPENDS_ON')"
    );
    rel.run(svc, email);
    rel.run(svc, vpnApp);
  }
}

// ================= Email channel seed (S10 extension, idempotent) =================
// General category + Service Desk Triage group (classifier fallback), the
// guest requester for unverified senders, keyword rules, templates, config.
function seedEmailChannel() {
  if (!db.prepare("SELECT id FROM categories WHERE name = 'General'").get()) {
    db.prepare("INSERT INTO categories (name, icon) VALUES ('General', 'inbox')").run();
  }
  if (!db.prepare("SELECT id FROM support_groups WHERE name = 'Service Desk Triage'").get()) {
    db.prepare("INSERT INTO support_groups (name, description) VALUES ('Service Desk Triage', 'First-line triage for unclassified email requests')").run();
  }
  require('./email/pipeline').getGuestUser();
  require('./email/classifier').seedClassificationRules();
  require('./email/templates').ensureTemplates();
  require('./email/config').getConfig();
  // One-time default change (2026-09-22): agents/leads are no longer emailed
  // about threaded tickets (in-app only) so each incident has one mail chain.
  if (!db.prepare("SELECT value FROM settings WHERE key = 'email_agent_mail_default_v2'").get()) {
    db.prepare('UPDATE email_channel_config SET thread_internal_notifications = 0 WHERE id = 1').run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('email_agent_mail_default_v2', '1')").run();
  }
  // Backfill: portal tickets that already received email comments get their
  // thread enabled so agent updates are mailed back (idempotent).
  db.prepare(`UPDATE tickets SET
      thread_subject = title,
      caller_email = COALESCE(caller_email, (SELECT email FROM users WHERE users.id = tickets.requester_id))
    WHERE thread_subject IS NULL AND source = 'PORTAL'
      AND EXISTS (SELECT 1 FROM ticket_comments c WHERE c.ticket_id = tickets.id AND c.source = 'EMAIL')`).run();
}

module.exports = { seed, seedStandard, seedAdvanced, seedEmailChannel };
