// ================= Attachment MIME policy (shared) =================
// One allowlist for BOTH portal uploads and inbound-email attachments, so an
// email cannot smuggle in a type (text/html, image/svg+xml) that the portal
// would reject. Anything off the list is stored/served as octet-stream so the
// browser can never render it inline as script.

const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'text/csv', 'application/zip',
]);

const SAFE_FALLBACK = 'application/octet-stream';

// Map a declared content type to a safe one for storage/serving.
function safeMime(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  return ALLOWED_MIME.has(m) ? m : SAFE_FALLBACK;
}

module.exports = { ALLOWED_MIME, SAFE_FALLBACK, safeMime };
