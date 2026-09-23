const { db } = require('../db');
const { getConfig } = require('./config');
const { enqueue, kick } = require('./queue');
const elog = require('./log');

// ================= Mailbox listener (FR1) =================
// Generic IMAP (Microsoft 365 / Google Workspace / any IMAP server).
// Event-driven via IMAP IDLE (the server pushes "exists" when mail arrives),
// with a periodic poll as the fallback and automatic reconnection.
// Activates only when MAIL_IN_HOST / MAIL_IN_USER / MAIL_IN_PASS are set.
// Optional: MAIL_IN_PORT (993), MAIL_IN_SECURE (true), MAIL_IN_POLL_SECONDS
// (overrides the admin polling interval), MAIL_IN_FOLDER (INBOX),
// MAIL_IN_OAUTH_TOKEN (XOAUTH2 access token instead of a password).

const state = {
  configured: false, connected: false, mode: 'idle', host: null, user: null, folder: 'INBOX',
  processedFolder: null, lastPollAt: null, lastMessageAt: null, lastError: null,
  fetched: 0, reconnects: 0, startedAt: null,
};
let client = null;
let pollTimer = null;
let reconnectTimer = null;
let stopping = false;
let draining = false;

function mailPollerEnabled() {
  return !!(process.env.MAIL_IN_HOST && process.env.MAIL_IN_USER && (process.env.MAIL_IN_PASS || process.env.MAIL_IN_OAUTH_TOKEN));
}

// Message-ID from the raw headers; clients that omit it get a stable hash of
// the source so the same mail is never enqueued twice.
function messageIdFromSource(source) {
  const m = /^Message-ID:\s*(<[^>]+>)/im.exec(source.slice(0, 20000));
  if (m) return m[1].trim();
  const hash = require('crypto').createHash('sha256').update(source).digest('hex').slice(0, 32);
  return `<itsm-raw-${hash}@local>`;
}

function alreadyHandled(messageId) {
  if (!messageId) return false;
  const done = db.prepare("SELECT id FROM email_message_log WHERE message_id = ? AND direction = 'INBOUND' AND processing_status IN ('PROCESSED','IGNORED','QUARANTINED','DISCARDED')").get(messageId);
  if (done) return true;
  const queued = db.prepare("SELECT id FROM email_jobs WHERE message_id = ? AND status IN ('QUEUED','RUNNING','DONE')").get(messageId);
  return !!queued;
}

// Servers without folder support (or without CREATE permission) fall back to
// flagging messages \Seen; retry folder creation at most every 10 minutes.
let folderRetryAt = 0;
async function ensureProcessedFolder(folder) {
  if (!folder || Date.now() < folderRetryAt) return null;
  try {
    const list = await client.list();
    if (list.some((m) => m.path === folder)) return folder;
    await client.mailboxCreate(folder);
    return folder;
  } catch (err) {
    folderRetryAt = Date.now() + 10 * 60 * 1000;
    elog.warn('listener.folder', { folder, error: err.message, note: 'falling back to \\Seen flag; retry in 10 min' });
    return null;
  }
}

// Fetch every unseen message, enqueue it durably, then move it out of INBOX.
async function drain() {
  if (!client || draining || stopping) return 0;
  draining = true;
  let count = 0;
  try {
    const config = getConfig();
    const lock = await client.getMailboxLock(state.folder);
    try {
      if (state.processedFolder === null) state.processedFolder = await ensureProcessedFolder(config.processed_folder);
      // With a Processed folder, INBOX only holds new mail → unseen search.
      // Without one (dev servers, no CREATE permission) a message opened in a
      // webmail UI is already \Seen, so look at recent mail instead and rely
      // on Message-ID dedupe (alreadyHandled).
      let uids;
      if (state.processedFolder) {
        uids = await client.search({ seen: false }, { uid: true });
      } else {
        try { uids = await client.search({ since: new Date(Date.now() - 7 * 86400000) }, { uid: true }); }
        catch { uids = await client.search({ seen: false }, { uid: true }); }
      }
      for (const uid of uids || []) {
        // Cheap header check first so already-handled mail is not re-downloaded.
        const head = await client.fetchOne(String(uid), { headers: ['message-id'], uid: true }, { uid: true });
        const headerId = head?.headers ? messageIdFromSource(head.headers.toString('utf8')) : null;
        if (headerId && !headerId.startsWith('<itsm-raw-') && alreadyHandled(headerId)) continue;
        const msg = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
        if (!msg?.source) continue;
        const source = msg.source.toString('utf8');
        const messageId = messageIdFromSource(source);
        if (alreadyHandled(messageId)) continue;
        enqueue('INBOUND', { raw: source }, { message_id: messageId });
        count += 1;
        state.lastMessageAt = new Date().toISOString();
        const target = state.processedFolder;
        let moved = false;
        if (target) {
          try { await client.messageMove(String(uid), target, { uid: true }); moved = true; } catch (err) {
            elog.warn('listener.move_failed', { uid, error: err.message });
          }
        }
        if (!moved) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      }
    } finally {
      lock.release();
    }
    state.lastPollAt = new Date().toISOString();
    state.fetched += count;
    state.lastError = null;
    if (count) { elog.info('listener.fetched', { count }); kick(); }
  } catch (err) {
    state.lastError = err.message;
    elog.error('listener.drain_failed', { error: err.message });
    scheduleReconnect();
  } finally {
    draining = false;
  }
  return count;
}

async function connect() {
  if (stopping) return;
  const { ImapFlow } = require('imapflow');
  const auth = process.env.MAIL_IN_OAUTH_TOKEN
    ? { user: process.env.MAIL_IN_USER, accessToken: process.env.MAIL_IN_OAUTH_TOKEN }
    : { user: process.env.MAIL_IN_USER, pass: process.env.MAIL_IN_PASS };
  client = new ImapFlow({
    host: process.env.MAIL_IN_HOST,
    port: Number(process.env.MAIL_IN_PORT || 993),
    secure: process.env.MAIL_IN_SECURE !== 'false',
    auth,
    logger: false,
    emitLogs: false,
  });
  client.on('error', (err) => {
    state.lastError = err.message;
    elog.error('listener.error', { error: err.message });
    scheduleReconnect();
  });
  client.on('close', () => {
    state.connected = false;
    if (!stopping) scheduleReconnect();
  });
  client.on('exists', () => { drain().catch(() => {}); }); // IMAP IDLE push
  await client.connect();
  await client.mailboxOpen(state.folder);
  state.connected = true;
  state.mode = 'idle+poll';
  state.lastError = null;
  elog.info('listener.connected', { host: state.host, user: state.user, folder: state.folder });
  await drain();
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;
  state.connected = false;
  const delay = Math.min(300, 10 * 2 ** Math.min(5, state.reconnects)) * 1000;
  state.reconnects += 1;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try { await client?.logout(); } catch { /* ignore */ }
    client = null;
    try { await connect(); state.reconnects = 0; } catch (err) {
      state.lastError = err.message;
      elog.error('listener.reconnect_failed', { error: err.message });
      scheduleReconnect();
    }
  }, delay);
  reconnectTimer.unref?.();
}

function startListener() {
  state.configured = mailPollerEnabled();
  if (!state.configured || process.env.NODE_ENV === 'test') {
    if (!state.configured && process.env.NODE_ENV !== 'test') {
      console.log('[mail-in] mailbox listener idle — set MAIL_IN_HOST/USER/PASS to enable live email-to-ticket');
    }
    return null;
  }
  const config = getConfig();
  state.host = process.env.MAIL_IN_HOST;
  state.user = process.env.MAIL_IN_USER;
  state.folder = process.env.MAIL_IN_FOLDER || 'INBOX';
  state.startedAt = new Date().toISOString();
  const seconds = Number(process.env.MAIL_IN_POLL_SECONDS || config.polling_interval_seconds || 60);
  connect().catch((err) => {
    state.lastError = err.message;
    elog.error('listener.connect_failed', { error: err.message });
    scheduleReconnect();
  });
  pollTimer = setInterval(() => {
    if (client && state.connected) drain().catch(() => {});
  }, Math.max(15, seconds) * 1000);
  pollTimer.unref();
  console.log(`[mail-in] listening on ${state.user}@${state.host} (IMAP IDLE + ${seconds}s poll)`);
  return pollTimer;
}

async function stopListener() {
  stopping = true;
  if (pollTimer) clearInterval(pollTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try { await client?.logout(); } catch { /* ignore */ }
  client = null;
  state.connected = false;
}

function listenerStatus() {
  return { ...state, configured: mailPollerEnabled() };
}

module.exports = { startListener, stopListener, listenerStatus, mailPollerEnabled, drain };
