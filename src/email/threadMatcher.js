const { db } = require('../db');
const { extractTokens } = require('./parser');

// ================= Thread detection (FR2) =================
// Order: 1) INC token in the subject (last one wins if several),
//        2) In-Reply-To / References matching a logged Message-ID,
//        3) otherwise a new request.

function matchThread(msg) {
  const warnings = [];
  const tokens = extractTokens(msg.subject);
  if (tokens.length > 1) {
    warnings.push(`Subject carries ${tokens.length} incident tokens (${tokens.join(', ')}); using ${tokens[tokens.length - 1]}`);
  }
  if (tokens.length) {
    const token = tokens[tokens.length - 1];
    const ticket = db.prepare('SELECT * FROM tickets WHERE ticket_number = ?').get(token);
    if (ticket) return { kind: 'UPDATE', ticket, via: 'TOKEN', token, warnings };
    warnings.push(`Subject token ${token} does not match any incident; treating as a new request`);
  }

  const ids = [msg.in_reply_to, ...(msg.references || [])].filter(Boolean);
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const hit = db.prepare(`
      SELECT ticket_id, message_id FROM email_message_log
      WHERE ticket_id IS NOT NULL AND message_id IN (${placeholders})
      ORDER BY id DESC LIMIT 1`).get(...ids);
    let ticketId = hit?.ticket_id;
    if (!ticketId) {
      const byOrigin = db.prepare(`SELECT id FROM tickets WHERE original_message_id IN (${placeholders}) LIMIT 1`).get(...ids);
      ticketId = byOrigin?.id;
    }
    if (ticketId) {
      const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
      if (ticket) return { kind: 'UPDATE', ticket, via: 'HEADER', matched: hit?.message_id || null, warnings };
    }
  }
  return { kind: 'NEW', ticket: null, via: null, warnings };
}

module.exports = { matchThread };
