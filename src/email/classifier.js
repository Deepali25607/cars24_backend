const { db } = require('../db');
const { getConfig } = require('./config');

// ================= Classification (FR3) =================
// IncidentClassifier is the interface every classifier implements; callers
// only ever use getClassifier().classify(...). The default is a keyword
// scorer driven by admin-editable rules (email_classification_rules).
// An ML/LLM implementation can be plugged in with setClassifier().

class IncidentClassifier {
  // eslint-disable-next-line no-unused-vars
  classify({ subject, body }) {
    throw new Error('classify() not implemented');
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordRegex(keyword) {
  const k = keyword.trim();
  // Word-boundary match; allow simple plural "s".
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(k)}s?(?=$|[^\\p{L}\\p{N}])`, 'iu');
}

function fallback(config, reason) {
  const general = config.general_category_id
    ? db.prepare('SELECT id FROM categories WHERE id = ? AND active = 1').get(config.general_category_id)
    : db.prepare("SELECT id FROM categories WHERE name = 'General' AND active = 1").get();
  const anyCat = general || db.prepare('SELECT id FROM categories WHERE active = 1 ORDER BY id LIMIT 1').get();
  const triage = config.triage_group_id
    ? db.prepare('SELECT id FROM support_groups WHERE id = ? AND active = 1').get(config.triage_group_id)
    : db.prepare("SELECT id FROM support_groups WHERE name = 'Service Desk Triage' AND active = 1").get();
  return {
    category_id: anyCat?.id ?? null,
    subcategory_id: null,
    assignment_group_id: triage?.id ?? null,
    priority_id: 3,
    score: 0,
    matched: [],
    reason,
  };
}

class KeywordClassifier extends IncidentClassifier {
  classify({ subject, body }) {
    const config = getConfig();
    const rules = db.prepare(`
      SELECT r.*, c.name AS category_name FROM email_classification_rules r
      JOIN categories c ON c.id = r.category_id
      WHERE r.is_active = 1 AND c.active = 1`).all();
    if (!rules.length) return fallback(config, 'No classification rules configured');

    const subj = String(subject || '');
    const text = String(body || '').slice(0, 20000);
    const scores = new Map(); // category_id -> { score, matched: [] }
    for (const rule of rules) {
      const re = keywordRegex(rule.keyword);
      let contribution = 0;
      const where = [];
      if (re.test(subj)) { contribution += rule.weight * config.subject_weight; where.push('subject'); }
      if (re.test(text)) { contribution += rule.weight * config.body_weight; where.push('body'); }
      if (!contribution) continue;
      const entry = scores.get(rule.category_id) || { score: 0, matched: [] };
      entry.score += contribution;
      entry.matched.push({ rule, contribution, where });
      scores.set(rule.category_id, entry);
    }
    if (!scores.size) return fallback(config, 'No keyword matched');

    const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
    if (ranked.length > 1 && ranked[0][1].score === ranked[1][1].score) {
      return fallback(config, `Tie between categories (${ranked[0][1].matched[0].rule.category_name} / ${ranked[1][1].matched[0].rule.category_name})`);
    }
    const [categoryId, entry] = ranked[0];
    const matched = entry.matched.sort((a, b) => b.contribution - a.contribution);
    const pick = (field) => matched.map((m) => m.rule[field]).find((v) => v !== null && v !== undefined);
    return {
      category_id: categoryId,
      subcategory_id: pick('subcategory_id') ?? null,
      assignment_group_id: pick('assignment_group_id') ?? null,
      priority_id: pick('default_priority_id') ?? 3,
      score: entry.score,
      matched: matched.map((m) => ({ keyword: m.rule.keyword, category: m.rule.category_name, where: m.where, contribution: m.contribution })),
      reason: `Matched ${matched.map((m) => `"${m.rule.keyword}"`).join(', ')}`,
    };
  }
}

let current = new KeywordClassifier();
function getClassifier() { return current; }
function setClassifier(instance) {
  if (!instance || typeof instance.classify !== 'function') throw new Error('Classifier must implement classify()');
  current = instance;
}

// Seed keywords (FR3). Keywords route to the closest existing category so the
// existing assignment rules keep working; group/priority come from the
// category → rule mapping and may be edited by admins.
// Entries are "keyword" (weight 1) or ["keyword", weight]. Specific product
// words outrank generic ones (e.g. "vpn" beats "access" in "VPN access").
const SEED_RULES = {
  Hardware: ['laptop', 'desktop', 'pc', 'charger', 'battery', 'hard disk', 'ram', 'projector', 'phone', ['not charging', 2], ['not turning on', 2]],
  Peripheral: ['printer', 'scanner', 'monitor', 'screen', 'keyboard', 'mouse', 'docking', 'headset', 'webcam'],
  Software: ['install', 'installation', 'license', ['outlook', 2], 'excel', 'word', ['teams', 2], 'error', 'crash', 'update', 'upgrade', 'application', ['sap', 2], 'browser'],
  Network: [['vpn', 2], ['wifi', 2], ['wi-fi', 2], 'internet', 'network'],
  Access: ['password', 'reset', 'access', 'login', ['mfa', 2], ['locked out', 2]],
};

function seedClassificationRules() {
  if (db.prepare('SELECT COUNT(*) AS n FROM email_classification_rules').get().n > 0) return;
  const cat = (name) => db.prepare('SELECT id FROM categories WHERE name = ?').get(name)?.id ?? null;
  const grp = (name) => db.prepare('SELECT id FROM support_groups WHERE name = ?').get(name)?.id ?? null;
  const groupFor = { Hardware: 'Desktop Support', Peripheral: 'Desktop Support', Software: 'Desktop Support', Network: 'Network Team', Access: 'Security Team' };
  const ins = db.prepare(`INSERT INTO email_classification_rules
    (category_id, keyword, weight, assignment_group_id, default_priority_id) VALUES (?,?,?,?,?)`);
  for (const [category, keywords] of Object.entries(SEED_RULES)) {
    const cid = cat(category);
    if (!cid) continue;
    for (const entry of keywords) {
      const [k, weight] = Array.isArray(entry) ? entry : [entry, 1];
      ins.run(cid, k, weight, grp(groupFor[category]), 3);
    }
  }
}

module.exports = { IncidentClassifier, KeywordClassifier, getClassifier, setClassifier, seedClassificationRules, SEED_RULES };
