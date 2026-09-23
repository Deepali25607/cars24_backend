const { db } = require('../db');
const elog = require('./log');

// ================= Job queue (FR1) =================
// SQLite-backed, in-process worker. Inbound messages and outbound sends are
// jobs with retries + exponential backoff; exhausted jobs go to the
// dead-letter state (status = DEAD) and are visible / retryable by admins.

const BASE_DELAY_SECONDS = 30;
const MAX_DELAY_SECONDS = 3600;
let running = false;
let timer = null;
let kickTimer = null;

function enqueue(kind, payload, { message_id = null, maxAttempts = 5 } = {}) {
  if (message_id) {
    const dupe = db.prepare(
      "SELECT id FROM email_jobs WHERE kind = ? AND message_id = ? AND status IN ('QUEUED','RUNNING')"
    ).get(kind, message_id);
    if (dupe) return dupe.id;
  }
  const info = db.prepare(`INSERT INTO email_jobs (kind, message_id, payload_json, max_attempts)
    VALUES (?,?,?,?)`).run(kind, message_id, JSON.stringify(payload), maxAttempts);
  return info.lastInsertRowid;
}

function backoffSeconds(attempt) {
  return Math.min(MAX_DELAY_SECONDS, BASE_DELAY_SECONDS * 2 ** Math.max(0, attempt - 1));
}

async function runJob(job) {
  const payload = JSON.parse(job.payload_json);
  if (job.kind === 'INBOUND') {
    const { processInboundEmail } = require('./pipeline');
    const result = await processInboundEmail(payload, { jobId: job.id });
    if (result.http >= 500) throw new Error(result.payload?.error || 'Inbound processing failed');
    return result.payload;
  }
  if (job.kind === 'OUTBOUND') {
    const { deliverOutbound } = require('./outbound');
    return deliverOutbound(payload);
  }
  throw new Error(`Unknown job kind ${job.kind}`);
}

function notifyAdmins(message) {
  const { notifyUser } = require('../services');
  const admins = db.prepare("SELECT id FROM users WHERE role = 'ADMIN' AND active = 1").all();
  for (const a of admins) notifyUser(a.id, null, 'EMAIL_CHANNEL_ALERT', message);
}

// Process due jobs. Returns the number of jobs attempted. Safe to call from
// tests, the poller and the timer concurrently (serialised via `running`).
async function runEmailJobs({ limit = 50 } = {}) {
  if (running) return 0;
  running = true;
  let attempted = 0;
  try {
    const due = db.prepare(`SELECT * FROM email_jobs WHERE status = 'QUEUED' AND next_run_at <= datetime('now')
      ORDER BY id ASC LIMIT ?`).all(limit);
    for (const job of due) {
      attempted += 1;
      db.prepare("UPDATE email_jobs SET status = 'RUNNING', attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?")
        .run(job.id);
      const attempt = job.attempts + 1;
      try {
        const result = await runJob({ ...job, attempts: attempt });
        db.prepare("UPDATE email_jobs SET status = 'DONE', result_json = ?, last_error = NULL, updated_at = datetime('now') WHERE id = ?")
          .run(JSON.stringify(result ?? null).slice(0, 4000), job.id);
      } catch (err) {
        const message = String(err?.message || err).slice(0, 1000);
        if (attempt >= job.max_attempts) {
          db.prepare("UPDATE email_jobs SET status = 'DEAD', last_error = ?, updated_at = datetime('now') WHERE id = ?")
            .run(message, job.id);
          elog.inc('jobs_dead');
          elog.error('job.dead', { job: job.id, kind: job.kind, message_id: job.message_id, error: message });
          if (job.kind === 'OUTBOUND') {
            try { require('./outbound').markOutboundFailed(JSON.parse(job.payload_json).logId, message); } catch { /* ignore */ }
          }
          notifyAdmins(`Email ${job.kind.toLowerCase()} job #${job.id} failed permanently: ${message}`);
        } else {
          const delay = backoffSeconds(attempt);
          db.prepare(`UPDATE email_jobs SET status = 'QUEUED', last_error = ?,
            next_run_at = datetime('now', '+' || ? || ' seconds'), updated_at = datetime('now') WHERE id = ?`)
            .run(message, delay, job.id);
          elog.warn('job.retry', { job: job.id, kind: job.kind, attempt, delay_seconds: delay, error: message });
        }
      }
    }
  } finally {
    running = false;
  }
  return attempted;
}

// Debounced "run soon" used after enqueueing (keeps the 2-minute SLA without
// waiting for the periodic timer). No-op in tests: they drive the queue.
function kick() {
  if (process.env.NODE_ENV === 'test' || kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    runEmailJobs().catch((err) => elog.error('worker.error', { error: err.message }));
  }, 50);
  kickTimer.unref?.();
}

function startWorker(intervalSeconds = 30) {
  if (timer || process.env.NODE_ENV === 'test') return null;
  timer = setInterval(() => {
    runEmailJobs().catch((err) => elog.error('worker.error', { error: err.message }));
  }, intervalSeconds * 1000);
  timer.unref();
  kick();
  return timer;
}

function listJobs({ status } = {}) {
  const where = status ? 'WHERE status = ?' : "WHERE status IN ('DEAD','QUEUED','RUNNING')";
  const rows = db.prepare(`SELECT id, kind, message_id, status, attempts, max_attempts, next_run_at, last_error, created_at, updated_at
    FROM email_jobs ${where} ORDER BY id DESC LIMIT 200`).all(...(status ? [status] : []));
  return rows;
}

function retryJob(id) {
  const job = db.prepare('SELECT * FROM email_jobs WHERE id = ?').get(id);
  if (!job) throw new Error('Job not found');
  db.prepare(`UPDATE email_jobs SET status = 'QUEUED', attempts = 0, next_run_at = datetime('now'),
    last_error = NULL, updated_at = datetime('now') WHERE id = ?`).run(id);
  kick();
  return db.prepare('SELECT * FROM email_jobs WHERE id = ?').get(id);
}

function discardJob(id) {
  const job = db.prepare('SELECT * FROM email_jobs WHERE id = ?').get(id);
  if (!job) throw new Error('Job not found');
  db.prepare("UPDATE email_jobs SET status = 'DISCARDED', updated_at = datetime('now') WHERE id = ?").run(id);
  if (job.kind === 'OUTBOUND') {
    try {
      const { logId } = JSON.parse(job.payload_json);
      db.prepare("UPDATE email_message_log SET processing_status = 'DISCARDED' WHERE id = ? AND processing_status <> 'PROCESSED'").run(logId);
    } catch { /* ignore */ }
  }
  return { ok: true };
}

module.exports = { enqueue, runEmailJobs, kick, startWorker, listJobs, retryJob, discardJob, backoffSeconds };
