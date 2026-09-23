// Structured logging + in-memory metrics for the email channel.
// Every log line carries the Message-ID as the correlation id when known.

const counters = {
  received: 0, processed: 0, created: 0, threaded: 0, reopened: 0, linked: 0,
  ignored: 0, quarantined: 0, failed: 0, duplicates: 0, outbound_sent: 0,
  outbound_failed: 0, jobs_dead: 0,
};
const startedAt = new Date().toISOString();

function inc(name, by = 1) {
  if (name in counters) counters[name] += by;
}

function snapshot() {
  return { since: startedAt, ...counters };
}

function elog(level, event, fields = {}) {
  if (process.env.NODE_ENV === 'test' && !process.env.EMAIL_DEBUG) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(), component: 'email', level, event, ...fields,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = {
  inc, snapshot,
  info: (event, fields) => elog('info', event, fields),
  warn: (event, fields) => elog('warn', event, fields),
  error: (event, fields) => elog('error', event, fields),
};
