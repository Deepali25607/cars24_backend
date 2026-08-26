require('dotenv').config();

const { seed, seedStandard, seedAdvanced } = require('./src/seed');
seed();
seedStandard();
seedAdvanced();

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

// STANDARD S10 → live mailbox poller (activates only when MAIL_IN_* is configured)
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
