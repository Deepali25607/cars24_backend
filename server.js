require('dotenv').config();

const { seed, seedStandard, seedAdvanced, seedEmailChannel } = require('./src/seed');
seed();
seedStandard();
seedAdvanced();
seedEmailChannel();

const { buildApp } = require('./src/app');
const app = buildApp();

const PORT = process.env.PORT || 4100;
app.listen(PORT, () => {
  console.log(`ITSM backend (Phase: ADVANCED) listening on http://localhost:${PORT}`);
});

// STANDARD S2/S8: periodic SLA sweep (warnings, breaches, escalations) and
// deferred workflow jobs. Interval configurable via SLA_SWEEP_SECONDS.
const { sweepSla } = require('./src/sla');
const { runDueJobs } = require('./src/workflow');
// BRD 6.14: automated database backup (daily by default; see src/backup.js)
require('./src/backup').startBackupTimer();

// STANDARD S10 (extended): email channel job worker (inbound processing +
// outbound threaded replies with retries) and the live IMAP listener, which
// activates only when MAIL_IN_* is configured.
require('./src/email/queue').startWorker(Number(process.env.EMAIL_WORKER_SECONDS || 30));
require('./src/mailin').startMailPoller();

const sweepSeconds = Number(process.env.SLA_SWEEP_SECONDS || 60);
setInterval(() => {
  try {
    sweepSla();
    runDueJobs();
  } catch (err) {
    console.error('[sla] sweep failed:', err.message);
  }
}, sweepSeconds * 1000).unref();
