const { db } = require('./db');

// ================= AI capabilities (BRD 8.7–8.11) =================
// Two engines:
//  - BUILTIN: deterministic keyword/similarity engine — no external calls,
//    always available, used until the customer approves an AI provider
//    (BRD 8.15 excludes unapproved AI models/APIs; BRD 16 requires approval).
//  - EXTERNAL: activates when AI_PROVIDER=anthropic, AI_API_KEY is set AND
//    AI_PROVIDER_APPROVED=true. Falls back to BUILTIN on any failure.

function externalEnabled() {
  return process.env.AI_PROVIDER === 'anthropic'
    && !!process.env.AI_API_KEY
    && process.env.AI_PROVIDER_APPROVED === 'true';
}

function aiStatus() {
  return {
    mode: externalEnabled() ? 'external' : 'builtin',
    provider: externalEnabled() ? 'anthropic' : 'built-in deterministic engine',
    note: externalEnabled() ? undefined
      : 'External AI provider activates once the customer approves a provider and supplies AI_PROVIDER/AI_API_KEY/AI_PROVIDER_APPROVED (BRD 8.15, BRD 16).',
  };
}

async function externalComplete(system, userText) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.AI_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.AI_MODEL || 'claude-sonnet-5',
      max_tokens: 700,
      system,
      messages: [{ role: 'user', content: userText }],
    }),
  });
  if (!resp.ok) throw new Error(`AI provider returned ${resp.status}`);
  const data = await resp.json();
  return data.content?.map((c) => c.text || '').join('') || '';
}

// ---------- Text helpers ----------
const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'my', 'i', 'it',
  'to', 'of', 'and', 'or', 'in', 'on', 'at', 'for', 'with', 'not', 'no', 'very',
  'me', 'this', 'that', 'have', 'has', 'do', 'does', 'be', 'can', 'cannot', 'cant',
  'wont', 'will', 'when', 'after', 'before', 'from', 'but', 'am', 'im', 'its']);

function tokens(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
}

function overlap(aTokens, bTokens) {
  const b = new Set(bTokens);
  let hits = 0;
  for (const t of new Set(aTokens)) if (b.has(t)) hits++;
  return hits;
}

// Extra symptom vocabulary per subcategory name (beyond the name itself).
const SYNONYMS = {
  battery: ['drain', 'draining', 'charge', 'dies', 'dying'],
  charging: ['charger', 'charge', 'adapter', 'plug'],
  display: ['screen', 'flicker', 'flickering', 'black', 'blank', 'lines', 'dim'],
  keyboard: ['key', 'keys', 'typing', 'sticky'],
  touchpad: ['trackpad', 'cursor', 'pointer', 'mouse'],
  power: ['turn', 'boot', 'dead', 'start'],
  camera: ['webcam', 'video'],
  speaker: ['audio', 'sound', 'volume'],
  microphone: ['mic', 'audio'],
  usb: ['port', 'pendrive', 'drive'],
  'physical damage': ['broken', 'crack', 'cracked', 'drop', 'dropped', 'hinge', 'spill'],
  'boot issue': ['boot', 'start', 'starting', 'stuck', 'restart'],
  'blue screen': ['bsod', 'crash', 'blue'],
  'windows update': ['update', 'updates', 'patch'],
  driver: ['drivers', 'device'],
  login: ['signin', 'sign', 'password', 'locked'],
  performance: ['slow', 'lag', 'lagging', 'freeze', 'freezes', 'freezing', 'hang', 'hangs'],
  outlook: ['email', 'mail', 'mailbox'],
  teams: ['meeting', 'call', 'calls'],
  office: ['word', 'excel', 'powerpoint'],
  browser: ['chrome', 'edge', 'firefox', 'website', 'websites'],
  'application crash': ['crash', 'crashes', 'crashing', 'closes'],
  'wi-fi': ['wifi', 'wireless', 'disconnect', 'disconnects', 'disconnecting', 'network'],
  lan: ['ethernet', 'cable'],
  vpn: ['remote', 'tunnel', 'connect'],
  internet: ['network', 'connection', 'connectivity', 'browsing'],
  antivirus: ['defender', 'virus'],
  malware: ['virus', 'infected', 'popup', 'popups'],
  bitlocker: ['encryption', 'recovery'],
  'suspicious activity': ['phishing', 'hacked', 'suspicious'],
  password: ['reset', 'forgot', 'expired'],
  mfa: ['authenticator', 'otp', '2fa'],
  'account lock': ['locked', 'lockout', 'disabled'],
  'application access': ['access', 'permission', 'denied'],
  monitor: ['screen', 'display', 'hdmi'],
  dock: ['docking', 'station'],
  headset: ['headphone', 'headphones', 'audio', 'mic'],
};

const P1_WORDS = ['cannot work', 'completely', 'dead', 'urgent', 'blocked', 'production', 'nothing works', 'will not boot', 'wont boot', 'not boot'];
const P2_WORDS = ['crash', 'crashes', 'blue screen', 'bsod', 'malware', 'virus', 'hacked', 'locked', 'broken'];
const P4_WORDS = ['question', 'request', 'minor', 'sometimes', 'occasionally', 'cosmetic'];

// ---------- AI Ticket Classification (BRD 8.7) ----------
function classify(title, description) {
  const text = tokens(`${title} ${description}`);
  const raw = `${title} ${description}`.toLowerCase();

  const subs = db.prepare(`
    SELECT sc.id, sc.name, sc.category_id, c.name AS category_name
    FROM subcategories sc JOIN categories c ON c.id = sc.category_id
    WHERE sc.active = 1 AND c.active = 1`).all();

  let best = null;
  let bestScore = 0;
  for (const s of subs) {
    const vocab = [...tokens(s.name), ...(SYNONYMS[s.name.toLowerCase()] || [])];
    const score = overlap(text, vocab) * 2 + (raw.includes(s.name.toLowerCase()) ? 3 : 0);
    if (score > bestScore) { best = s; bestScore = score; }
  }

  let priority_id = 3; // default P3
  if (P1_WORDS.some((w) => raw.includes(w))) priority_id = 1;
  else if (P2_WORDS.some((w) => raw.includes(w))) priority_id = 2;
  else if (P4_WORDS.some((w) => raw.includes(w))) priority_id = 4;

  let group = null;
  if (best) {
    const rule = db.prepare(`SELECT r.*, g.name AS group_name FROM assignment_rules r
      JOIN support_groups g ON g.id = r.target_group_id
      WHERE r.active = 1 AND r.category_id = ? ORDER BY r.sort ASC LIMIT 1`).get(best.category_id);
    if (rule) group = { id: rule.target_group_id, name: rule.group_name };
  }

  return {
    confident: bestScore >= 2,
    category: best ? { id: best.category_id, name: best.category_name } : null,
    subcategory: best ? { id: best.id, name: best.name } : null,
    priority_id,
    priority_code: `P${priority_id}`,
    assignment_group: group,
    engine: 'builtin',
  };
}

// ---------- AI Resolution Recommendation (BRD 8.8) ----------
function recommend(text, limit = 3) {
  const queryTokens = tokens(text);

  const articles = db.prepare(`SELECT id, article_number, title, body FROM kb_articles
    WHERE status = 'PUBLISHED'`).all()
    .map((a) => ({ ...a, score: overlap(queryTokens, tokens(`${a.title} ${a.body}`)) }))
    .filter((a) => a.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((a) => ({ id: a.id, article_number: a.article_number, title: a.title, score: a.score }));

  const resolved = db.prepare(`SELECT id, ticket_number, title, resolution_note FROM tickets
    WHERE resolution_note IS NOT NULL ORDER BY resolved_at DESC LIMIT 400`).all()
    .map((t) => ({ ...t, score: overlap(queryTokens, tokens(`${t.title} ${t.resolution_note}`)) }))
    .filter((t) => t.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((t) => ({ id: t.id, ticket_number: t.ticket_number, title: t.title, resolution_note: t.resolution_note, score: t.score }));

  const cls = classify(text, '');
  const steps = TROUBLESHOOTING[cls.subcategory?.name?.toLowerCase()] || GENERIC_STEPS;
  return { articles, similar_resolved: resolved, suggested_steps: steps, classification: cls };
}

const GENERIC_STEPS = [
  'Restart the laptop and check whether the issue persists.',
  'Install pending Windows/OS updates.',
  'Note any error message exactly and attach a screenshot to the ticket.',
];
const TROUBLESHOOTING = {
  battery: ['Check battery health report', 'Close background processes with high usage', 'Check power plan configuration', 'Update BIOS'],
  'wi-fi': ['Toggle Wi-Fi off/on and rejoin the network', 'Update the wireless driver', 'Forget and re-add the network', 'Test on a hotspot to isolate the network'],
  performance: ['Check Task Manager for CPU/memory above 90%', 'Disable heavy startup apps', 'Install pending updates and restart', 'Check free disk space (need 15%+)'],
  vpn: ['Verify internet works without VPN', 'Re-enter credentials/MFA', 'Switch VPN gateway/protocol', 'Reinstall the VPN client'],
  outlook: ['Restart Outlook in safe mode', 'Check mailbox storage quota', 'Re-create the Outlook profile', 'Verify with Outlook Web Access'],
  'boot issue': ['Hard reset: hold power 10s, remove peripherals', 'Try safe mode', 'Check for BIOS/firmware messages', 'If disk errors appear, stop and escalate — possible data risk'],
};

// ---------- AI Ticket Summary (BRD 8.9) ----------
async function summarize(ticketId) {
  const t = db.prepare(`SELECT t.*, c.name AS category_name, p.code AS priority_code,
      u.full_name AS requester_name, ag.full_name AS agent_name, g.name AS group_name
    FROM tickets t
    JOIN categories c ON c.id = t.category_id
    JOIN priorities p ON p.id = t.priority_id
    JOIN users u ON u.id = t.requester_id
    LEFT JOIN users ag ON ag.id = t.assigned_agent_id
    LEFT JOIN support_groups g ON g.id = t.support_group_id
    WHERE t.id = ?`).get(ticketId);
  if (!t) return null;

  const history = db.prepare(`SELECT th.action, th.detail, th.created_at, u.full_name AS actor
    FROM ticket_history th LEFT JOIN users u ON u.id = th.actor_id
    WHERE th.ticket_id = ? ORDER BY th.created_at ASC`).all(ticketId);

  const actionLabels = {
    CREATED: 'Ticket created', ASSIGNED: 'Assigned', REASSIGNED: 'Reassigned',
    AUTO_ASSIGNED: 'Auto-routed', COMMENT: 'Requester/agent comment', WORK_NOTE: 'Internal note',
    ATTACHMENT: 'Evidence attached', UPDATED: 'Reclassified', WORKFLOW: 'Workflow action',
    STATUS_IN_PROGRESS: 'Investigation started', STATUS_PENDING: 'Put on hold',
    STATUS_RESOLVED: 'Resolved', STATUS_CLOSED: 'Closed', STATUS_REOPENED: 'Reopened',
    SLA_WARNING: 'SLA warning raised', SLA_BREACH: 'SLA breached', SLA_ESCALATION: 'Escalated',
    MAJOR_DECLARED: 'Declared a major incident',
  };
  const actions = [];
  for (const h of history) {
    const label = actionLabels[h.action] || h.action;
    const line = h.detail ? `${label} — ${h.detail}` : label;
    if (actions[actions.length - 1] !== line) actions.push(line);
  }

  const builtin = {
    issue: `${t.title} (${t.category_name}, ${t.priority_code}) reported by ${t.requester_name}.`,
    description_excerpt: String(t.description).slice(0, 280),
    actions: actions.slice(-10),
    current_status: `${t.status.replace('_', ' ')}${t.agent_name ? ` — with ${t.agent_name}` : ''}${t.group_name ? ` (${t.group_name})` : ''}${t.resolution_note ? `. Resolution: ${t.resolution_note}` : ''}`,
    engine: 'builtin',
  };

  if (externalEnabled()) {
    try {
      const text = await externalComplete(
        'Summarize this IT ticket concisely for a support engineer: 2-line issue, bullet actions taken, one-line current status.',
        JSON.stringify({ ticket: t, history }));
      return { ...builtin, narrative: text, engine: 'external' };
    } catch { /* fall through to builtin */ }
  }
  return builtin;
}

// ---------- AI Chatbot (BRD 8.10) ----------
// Stateless: the client sends the transcript; we reply and, when appropriate,
// return a prefilled ticket draft. The ticket itself is only created by the
// normal POST /api/tickets after the user confirms (BRD: "after user confirmation").
function chatReply(messages) {
  const lastUser = [...(messages || [])].reverse().find((m) => m.role === 'user');
  const text = lastUser?.text || '';
  const t = text.toLowerCase();

  if (!text || /^(hi|hello|hey)\b/.test(t)) {
    return {
      reply: "Hello! I'm the IT Support Assistant. Describe your laptop issue (for example: “my laptop is very slow” or “Wi-Fi keeps disconnecting”) and I'll suggest what to try.",
    };
  }

  const cls = classify(text, '');
  const steps = TROUBLESHOOTING[cls.subcategory?.name?.toLowerCase()] || GENERIC_STEPS;
  const rec = recommend(text, 2);

  const draft = {
    title: text.length > 80 ? `${text.slice(0, 77)}...` : text,
    description: `Reported via IT Support Assistant:\n${text}`,
    category_id: cls.category?.id ?? null,
    subcategory_id: cls.subcategory?.id ?? null,
    priority_id: cls.priority_id,
  };

  let reply = cls.subcategory
    ? `This looks like a ${cls.category.name} / ${cls.subcategory.name} issue. Try these steps:\n`
    : 'Let me suggest some general steps:\n';
  reply += steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  if (rec.articles.length) {
    reply += `\n\nThese knowledge articles may help: ${rec.articles.map((a) => `${a.article_number} “${a.title}”`).join(', ')}.`;
  }
  reply += '\n\nIf that does not fix it, would you like me to create an IT ticket for you?';

  return { reply, suggested_articles: rec.articles, ticket_draft: draft, classification: cls };
}

// ---------- Intelligent assignment recommendation (BRD 8.11) ----------
// Recommendation only — actual assignment stays with the existing
// rule/permission-governed endpoints.
function recommendAssignment(ticket) {
  const agents = db.prepare(`
    SELECT u.id, u.full_name, u.support_group_id, u.location_id, g.name AS group_name
    FROM users u LEFT JOIN support_groups g ON g.id = u.support_group_id
    WHERE u.active = 1 AND u.role IN ('AGENT','TEAM_LEAD')`).all();

  const scored = agents.map((a) => {
    const resolvedInCategory = db.prepare(`SELECT COUNT(*) AS n FROM tickets
      WHERE assigned_agent_id = ? AND category_id = ? AND resolved_at IS NOT NULL`)
      .get(a.id, ticket.category_id).n;
    const openLoad = db.prepare(`SELECT COUNT(*) AS n FROM tickets
      WHERE assigned_agent_id = ? AND status NOT IN ('RESOLVED','CLOSED')`).get(a.id).n;
    const sameGroup = ticket.support_group_id && a.support_group_id === ticket.support_group_id ? 2 : 0;
    const sameLocation = ticket.location_id && a.location_id === ticket.location_id ? 1 : 0;
    const score = resolvedInCategory * 2 + sameGroup + sameLocation - openLoad * 0.5;
    const reasons = [];
    if (resolvedInCategory) reasons.push(`resolved ${resolvedInCategory} ticket(s) in this category`);
    if (sameGroup) reasons.push('in the assignment group');
    if (sameLocation) reasons.push('same location');
    reasons.push(`${openLoad} open ticket(s) now`);
    return { agent_id: a.id, agent_name: a.full_name, group_name: a.group_name, score: Math.round(score * 10) / 10, reasons };
  }).sort((x, y) => y.score - x.score);

  return scored.slice(0, 3);
}

module.exports = { aiStatus, classify, recommend, summarize, chatReply, recommendAssignment };
