// ================= Email-to-ticket (BRD 7.13) — compatibility shim =================
// The Standard S10 implementation lived here. It has been superseded by the
// two-way email channel under src/email/ (parser, thread matcher, classifier,
// pipeline, outbound sync, job queue, IMAP listener). This module keeps the
// original exports so existing callers and docs keep working.

const { processInboundEmail } = require('./email/pipeline');
const { startListener, mailPollerEnabled, listenerStatus } = require('./email/listener');

module.exports = {
  processInboundEmail,
  startMailPoller: startListener,
  mailPollerEnabled,
  listenerStatus,
};
