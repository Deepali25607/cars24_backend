const { simpleParser } = require('mailparser');
const sanitize = require('sanitize-html');

// ================= Email parsing & cleaning =================
// Turns either a raw RFC 5322 message or the relay-endpoint JSON payload into
// one normalised shape used by the rest of the pipeline:
// {
//   message_id, in_reply_to, references[], from {address,name}, to[], cc[],
//   subject, date, text, html, headers {lowercase-name: value}, attachments[],
//   raw
// }

const TOKEN_RE = /\[?\bINC-?(\d{6})\b\]?/gi;
const PREFIX_RE = /^\s*((re|fw|fwd|aw|sv|wg|tr|vs|antw|rif|res)\s*(\[\d+\])?\s*:\s*)+/i;

function addr(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const m = value.match(/<([^>]+)>/);
    const address = (m ? m[1] : value).trim().toLowerCase();
    const name = m ? value.slice(0, m.index).replace(/["']/g, '').trim() : '';
    return address ? { address, name } : null;
  }
  if (value.address) return { address: String(value.address).trim().toLowerCase(), name: value.name || '' };
  return null;
}

function addrList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(addr).filter(Boolean);
  if (typeof value === 'string') {
    return value.split(',').map(addr).filter(Boolean);
  }
  if (value.value) return value.value.map(addr).filter(Boolean); // mailparser AddressObject
  const one = addr(value);
  return one ? [one] : [];
}

function normalizeMessageId(id) {
  if (!id) return null;
  const s = String(id).trim();
  if (!s) return null;
  return s.startsWith('<') ? s : `<${s.replace(/^<|>$/g, '')}>`;
}

function splitReferences(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(/\s+/);
  return list.map(normalizeMessageId).filter(Boolean);
}

function headersToObject(headers) {
  const out = {};
  if (!headers) return out;
  if (headers instanceof Map) {
    for (const [k, v] of headers) out[k.toLowerCase()] = headerValueToString(v);
  } else if (typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = headerValueToString(v);
  }
  return out;
}

function headerValueToString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(headerValueToString).join(', ');
  if (v.text) return v.text;
  if (v.value !== undefined) {
    return typeof v.value === 'string' ? v.value : JSON.stringify(v.value);
  }
  return String(v);
}

async function parseRawEmail(source) {
  const buf = Buffer.isBuffer(source) ? source : Buffer.from(String(source), 'utf8');
  const parsed = await simpleParser(buf, { skipImageLinks: true });
  const headers = headersToObject(parsed.headers);
  return {
    message_id: normalizeMessageId(parsed.messageId),
    in_reply_to: normalizeMessageId(parsed.inReplyTo),
    references: splitReferences(parsed.references),
    from: addrList(parsed.from)[0] || null,
    to: addrList(parsed.to),
    cc: addrList(parsed.cc),
    subject: parsed.subject || '',
    date: parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString(),
    text: parsed.text || '',
    html: typeof parsed.html === 'string' ? parsed.html : '',
    headers,
    attachments: (parsed.attachments || []).map((a) => ({
      filename: a.filename || 'attachment',
      contentType: a.contentType || 'application/octet-stream',
      size: a.size || (a.content ? a.content.length : 0),
      content: a.content,
      inline: a.contentDisposition === 'inline' || !!a.cid || a.related === true,
    })),
    raw: buf.toString('utf8'),
  };
}

// Relay-endpoint payload (backward compatible with the Standard S10 shape:
// { message_id, from_email, subject, body }) plus the extended optional fields.
async function normalizeInput(input) {
  if (!input) return null;
  if (input.raw) {
    const parsed = await parseRawEmail(input.raw);
    // Explicit fields override what the raw source says (rare; used by tests).
    if (input.from_email) parsed.from = { address: String(input.from_email).toLowerCase(), name: input.from_name || '' };
    return parsed;
  }
  const from = input.from_email ? addr(input.from_email) : null;
  if (from && input.from_name) from.name = input.from_name;
  return {
    message_id: normalizeMessageId(input.message_id),
    in_reply_to: normalizeMessageId(input.in_reply_to),
    references: splitReferences(input.references),
    from,
    to: addrList(input.to),
    cc: addrList(input.cc),
    subject: input.subject || '',
    date: input.received_at ? new Date(input.received_at).toISOString() : new Date().toISOString(),
    text: input.body || input.text || '',
    html: input.html || '',
    headers: headersToObject(input.headers || {}),
    attachments: (input.attachments || []).map((a) => ({
      filename: a.filename || 'attachment',
      contentType: a.content_type || a.contentType || 'application/octet-stream',
      size: a.size || (a.content_base64 ? Buffer.byteLength(a.content_base64, 'base64') : 0),
      content: a.content_base64 ? Buffer.from(a.content_base64, 'base64') : a.content || null,
      inline: !!a.inline,
    })),
    raw: null,
  };
}

// ---------- Subject helpers ----------
function stripSubjectPrefixes(subject) {
  return String(subject || '').replace(PREFIX_RE, '').trim();
}

function extractTokens(subject) {
  const out = [];
  const re = new RegExp(TOKEN_RE.source, 'gi');
  let m;
  while ((m = re.exec(String(subject || ''))) !== null) out.push(`INC-${m[1]}`);
  return out;
}

function cleanSubject(subject) {
  return stripSubjectPrefixes(subject)
    .replace(new RegExp(TOKEN_RE.source, 'gi'), '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s:\-–]+|[\s:\-–]+$/g, '')
    .trim();
}

// ---------- HTML ----------
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function htmlToText(html) {
  if (!html) return '';
  const withBreaks = String(html)
    .replace(/<\s*(style|script)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|tr|h[1-6]|blockquote|pre|table)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ');
  const text = sanitize(withBreaks, { allowedTags: [], allowedAttributes: {} });
  return decodeEntities(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function sanitizeHtml(html) {
  if (!html) return '';
  return sanitize(String(html), {
    allowedTags: sanitize.defaults.allowedTags.concat(['img', 'span', 'u']),
    allowedAttributes: {
      ...sanitize.defaults.allowedAttributes,
      img: ['src', 'alt', 'width', 'height'],
      '*': ['style'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid', 'data'],
    allowedStyles: { '*': { color: [/^.*$/], 'font-weight': [/^.*$/], 'text-decoration': [/^.*$/] } },
  });
}

// ---------- Quoted-reply and signature stripping ----------
const CUT_PATTERNS = [
  /^On\b[^\n]{0,200}(\n[^\n]{0,200})?\bwrote:\s*$/m,            // Gmail / Apple Mail
  /^-{2,}\s*Original Message\s*-{2,}\s*$/mi,                    // Outlook classic
  /^-{2,}\s*Ursprüngliche Nachricht\s*-{2,}\s*$/mi,
  /^_{5,}\s*$/m,                                                // Outlook separator
  /^From:\s[^\n]+\n(\s*)?(Sent|Date):\s/mi,                     // Outlook header block
  /^Le\b[^\n]{0,200}a écrit\s*:\s*$/m,                          // French
  /^Am\b[^\n]{0,200}schrieb\b[^\n]{0,100}:\s*$/m,               // German
  /^El\b[^\n]{0,200}escribió:\s*$/m,                            // Spanish
  /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}[^\n]{0,80}<[^>]+>\s*:?\s*$/m, // "01/02/2026 10:00 Name <a@b>:"
];
const SIGNATURE_PATTERNS = [
  /^--\s*$/,
  /^(thanks|thank you|many thanks|thanks & regards|thanks and regards|regards|best regards|kind regards|warm regards|best|cheers|sincerely|yours sincerely|yours faithfully|with regards|br|rgds)[,!.]*\s*$/i,
  /^sent from (my|the) /i,
  /^get outlook for /i,
];
const DISCLAIMER_PATTERNS = [
  /^(disclaimer|confidentiality notice|legal notice)\b/i,
  /^this (e-?mail|message|communication)( and any (attachments|files))? (is|are|may be|contains?) (confidential|intended|privileged|for the (sole|exclusive) use)/i,
  /^the (information|contents?) (contained )?in this (e-?mail|message)/i,
  /^if you are not the intended recipient/i,
];

function stripQuotedReply(text) {
  let body = String(text || '').replace(/\r\n?/g, '\n');
  let cut = body.length;
  for (const re of CUT_PATTERNS) {
    const m = re.exec(body);
    if (m && m.index < cut) cut = m.index;
  }
  let head = body.slice(0, cut);

  // Drop '>'-quoted lines wherever they occur.
  let lines = head.split('\n').filter((l) => !/^\s*>/.test(l));

  // Signature / disclaimer: cut at the first matching line (keep at least one
  // content line so a one-word reply such as "Thanks" is not blanked).
  const firstContent = lines.findIndex((l) => l.trim());
  for (let i = firstContent + 1; i < lines.length; i += 1) {
    const l = lines[i].trim();
    if (SIGNATURE_PATTERNS.some((re) => re.test(l)) || DISCLAIMER_PATTERNS.some((re) => re.test(l))) {
      lines = lines.slice(0, i);
      break;
    }
  }
  let result = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!result) result = head.trim();
  if (!result) result = body.trim();
  return result;
}

// ---------- Loop / noise detection ----------
function isAutoReply(msg) {
  const h = msg.headers || {};
  const autoSubmitted = (h['auto-submitted'] || '').trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return { ignore: true, reason: `Auto-Submitted: ${autoSubmitted}` };
  if (h['x-auto-response-suppress']) return { ignore: true, reason: 'X-Auto-Response-Suppress header' };
  if (h['x-autoreply'] || h['x-autorespond']) return { ignore: true, reason: 'Auto-responder header' };
  const precedence = (h.precedence || '').trim().toLowerCase();
  if (['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) {
    return { ignore: true, reason: `Precedence: ${precedence}` };
  }
  if (h['list-id'] || h['list-unsubscribe']) return { ignore: true, reason: 'Mailing-list message' };
  const subject = String(msg.subject || '');
  if (/\b(automatic reply|auto-?reply|autoreply|out of (the )?office|abwesenheitsnotiz|réponse automatique)\b/i.test(subject)) {
    return { ignore: true, reason: 'Out-of-office / auto-reply subject' };
  }
  return { ignore: false };
}

function isBounce(msg) {
  const from = (msg.from?.address || '').toLowerCase();
  const h = msg.headers || {};
  if (/^(mailer-daemon|postmaster)@/.test(from)) return { bounce: true, reason: `Bounce from ${from}` };
  if (/multipart\/report/i.test(h['content-type'] || '')) return { bounce: true, reason: 'Delivery status report' };
  if (h['x-failed-recipients']) return { bounce: true, reason: 'Non-delivery report' };
  if (/^(undeliverable|undelivered mail|delivery (status )?(notification|failure)|mail delivery failed|returned mail)/i
    .test(String(msg.subject || '').trim())) {
    return { bounce: true, reason: 'Non-delivery report subject' };
  }
  return { bounce: false };
}

// Authentication-Results: "mx.example.com; spf=pass ...; dkim=fail ...; dmarc=pass ..."
function parseAuthResults(headers) {
  const raw = (headers || {})['authentication-results'] || '';
  const out = { present: !!raw, spf: null, dkim: null, dmarc: null, failed: [] };
  if (!raw) return out;
  for (const key of ['spf', 'dkim', 'dmarc']) {
    const m = new RegExp(`\\b${key}=([a-z]+)`, 'i').exec(raw);
    if (m) {
      out[key] = m[1].toLowerCase();
      if (out[key] === 'fail') out.failed.push(key);
    }
  }
  return out;
}

function domainOf(address) {
  const at = String(address || '').lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1).toLowerCase() : '';
}

module.exports = {
  parseRawEmail, normalizeInput, stripSubjectPrefixes, extractTokens, cleanSubject,
  htmlToText, sanitizeHtml, stripQuotedReply, isAutoReply, isBounce, parseAuthResults,
  normalizeMessageId, domainOf, addrList,
};
