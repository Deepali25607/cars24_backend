const path = require('path');
const fs = require('fs');
const { db } = require('./db');

// ================= Automated database backup (BRD 6.14) =================
// Online SQLite backup via better-sqlite3's backup API (safe under WAL).
// Config:
//   BACKUP_DIR             target directory (default <backend>/backups)
//   BACKUP_INTERVAL_HOURS  schedule (default 24; 0 disables the timer)
//   BACKUP_RETENTION_DAYS  prune backups older than this (default 14;
//                          the customer-approved retention overrides it)

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 14);

async function runBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = path.join(BACKUP_DIR, `itsm-${stamp}.db`);
  await db.backup(file);

  // Retention pruning
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  let pruned = 0;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    if (!/^itsm-.*\.db$/.test(f)) continue;
    const full = path.join(BACKUP_DIR, f);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) { fs.unlinkSync(full); pruned++; }
    } catch { /* file may be gone already */ }
  }
  return { file: path.basename(file), size_bytes: fs.statSync(file).size, pruned };
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^itsm-.*\.db$/.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { file: f, size_bytes: st.size, created_at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function startBackupTimer() {
  const hours = Number(process.env.BACKUP_INTERVAL_HOURS ?? 24);
  if (!hours || process.env.NODE_ENV === 'test') return null;
  const timer = setInterval(() => {
    runBackup()
      .then((r) => console.log(`[backup] wrote ${r.file} (${r.size_bytes} bytes), pruned ${r.pruned}`))
      .catch((err) => console.error('[backup] failed:', err.message));
  }, hours * 3600 * 1000);
  timer.unref();
  return timer;
}

module.exports = { runBackup, listBackups, startBackupTimer, BACKUP_DIR };
