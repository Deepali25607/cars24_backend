const http = require('http');
const crypto = require('crypto');
const { SMTPServer } = require('smtp-server');
const MailComposer = require('nodemailer/lib/mail-composer');
const { getConfig } = require('./email/config');
const { sanitizeHtml } = require('./email/parser');
const elog = require('./email/log');

// ================= Demo SMTP bridge (local, self-contained) =================
// NOT a product feature and never runs in production or tests. It exists only
// to make the already-built email channel (Standard S10 + the 2026-09-20
// extension) tangible in a client demo WITHOUT the customer's real mailbox:
//
//   App  --SMTP(localhost:2525)-->  bridge  -->  web inbox (localhost:5000)
//                                      |
//      mail addressed to the support mailbox is fed into the SAME inbound
//      pipeline the live IMAP listener uses (enqueue INBOUND + kick), so a
//      "customer" reply creates / updates a real incident live.
//
// Activated only when MAIL_BRIDGE=1 (and NODE_ENV !== 'test'). Point the app's
// outbound transport at it with SMTP_HOST=localhost / SMTP_PORT=2525.
// Everything stays on the machine and works offline.

const MAX_KEEP = 500; // ring buffer of captured messages (newest last)
const captured = [];
let seq = 0;
let smtpServer = null;
let webServer = null;

function bridgeEnabled() {
  return process.env.MAIL_BRIDGE === '1' && process.env.NODE_ENV !== 'test';
}

function messageIdFromSource(source) {
  const m = /^Message-ID:\s*(<[^>]+>)/im.exec(source.slice(0, 20000));
  if (m) return m[1].trim();
  const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 32);
  return `<itsm-raw-${hash}@local>`;
}

function headerValue(source, name) {
  const re = new RegExp(`^${name}:\\s*([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)`, 'im');
  const m = re.exec(source.slice(0, 60000));
  return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : null;
}

function firstAddress(value) {
  if (!value) return null;
  const m = /<([^>]+)>/.exec(value) || /([^\s,<>]+@[^\s,<>]+)/.exec(value);
  return (m ? m[1] : value).trim().toLowerCase();
}

// A support-mailbox recipient means the message is INBOUND to the ITSM (a
// customer writing in or replying). Anything else is the app's own outbound
// mail to a requester — captured for viewing only.
function isInboundTo(recipients) {
  const config = getConfig();
  const mailbox = (config.mailboxAddress || '').toLowerCase();
  const system = config.systemAddresses;
  return recipients.some((r) => r && (r === mailbox || system.has(r)));
}

// Ingest one raw RFC822 message: capture it for the web inbox and, when it is
// addressed to the support mailbox, hand it to the tested inbound pipeline.
function ingestRaw(raw, envelope = {}) {
  const rcpt = (envelope.rcptTo && envelope.rcptTo.length
    ? envelope.rcptTo.map((r) => String(r.address || r).toLowerCase())
    : [firstAddress(headerValue(raw, 'To')), firstAddress(headerValue(raw, 'Cc'))].filter(Boolean));
  const inbound = isInboundTo(rcpt);
  const messageId = messageIdFromSource(raw);
  const record = {
    id: ++seq,
    direction: inbound ? 'INBOUND' : 'OUTBOUND',
    from: firstAddress(headerValue(raw, 'From')) || (envelope.mailFrom && String(envelope.mailFrom.address || '').toLowerCase()) || '',
    to: headerValue(raw, 'To') || rcpt.join(', '),
    cc: headerValue(raw, 'Cc') || '',
    subject: headerValue(raw, 'Subject') || '(no subject)',
    message_id: messageId,
    in_reply_to: headerValue(raw, 'In-Reply-To'),
    references: headerValue(raw, 'References'),
    received_at: new Date().toISOString(),
    raw,
  };
  captured.push(record);
  while (captured.length > MAX_KEEP) captured.shift();

  if (inbound) {
    // Exactly what the IMAP listener does with a fetched message.
    const { enqueue, kick } = require('./email/queue');
    enqueue('INBOUND', { raw }, { message_id: messageId });
    kick();
    elog.info('bridge.inbound', { message_id: messageId, from: record.from, subject: record.subject });
  } else {
    elog.info('bridge.captured', { message_id: messageId, to: record.to, subject: record.subject });
  }
  return record;
}

// ---------------- SMTP side (receives app outbound + injected customer mail) --
function startSmtp(port) {
  smtpServer = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    hideSTARTTLS: true,
    onConnect(_session, cb) { cb(); },
    onMailFrom(_addr, _session, cb) { cb(); },
    onRcptTo(_addr, _session, cb) { cb(); },
    onData(stream, session, callback) {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        try {
          ingestRaw(Buffer.concat(chunks).toString('utf8'), session.envelope);
        } catch (err) {
          elog.error('bridge.ingest_failed', { error: err.message });
        }
        callback();
      });
      stream.on('error', (err) => { elog.error('bridge.stream_error', { error: err.message }); callback(); });
    },
  });
  smtpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[mail-bridge] SMTP port ${port} is already in use — is another bridge running?`);
    } else {
      elog.error('bridge.smtp_error', { error: err.message });
    }
  });
  smtpServer.listen(port, '127.0.0.1', () => {
    console.log(`[mail-bridge] SMTP server listening on localhost:${port} (point SMTP_HOST/SMTP_PORT here)`);
  });
}

// ---------------- Web inbox + compose/reply --------------------------------
function buildRaw({ from, to, cc, subject, text, inReplyTo, references }) {
  const domain = (String(from || '').split('@')[1] || 'cars24.com').trim();
  const messageId = `<demo-${crypto.randomUUID()}@${domain}>`;
  const mail = { from, to, subject, text: text || '', messageId };
  if (cc) mail.cc = cc;
  if (inReplyTo) mail.inReplyTo = inReplyTo;
  if (references) mail.references = references;
  return new Promise((resolve, reject) => {
    new MailComposer(mail).compile().build((err, buf) => (err ? reject(err) : resolve(buf.toString('utf8'))));
  });
}

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { resolve({}); }
    });
  });
}

const WEB_PORT_DEFAULT = 8025;

function startWeb(port) {
  webServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(INBOX_HTML);
      }
      if (req.method === 'GET' && url.pathname === '/api/messages') {
        return sendJson(res, 200, captured.slice().reverse().map((m) => ({
          id: m.id, direction: m.direction, from: m.from, to: m.to, cc: m.cc,
          subject: m.subject, received_at: m.received_at, message_id: m.message_id,
        })));
      }
      if (req.method === 'GET' && /^\/api\/messages\/\d+$/.test(url.pathname)) {
        const id = Number(url.pathname.split('/').pop());
        const rec = captured.find((m) => m.id === id);
        if (!rec) return sendJson(res, 404, { error: 'Not found' });
        const bodyText = extractTextBody(rec.raw);
        const bodyHtml = extractHtmlBody(rec.raw);
        return sendJson(res, 200, {
          id: rec.id, direction: rec.direction, from: rec.from, to: rec.to, cc: rec.cc,
          subject: rec.subject, message_id: rec.message_id, in_reply_to: rec.in_reply_to,
          references: rec.references, received_at: rec.received_at,
          body_text: bodyText,
          body_html_safe: bodyHtml ? sanitizeHtml(bodyHtml) : null,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/send') {
        const body = await readBody(req);
        if (!body.from || !body.to || !body.subject) {
          return sendJson(res, 400, { error: 'from, to and subject are required' });
        }
        const raw = await buildRaw(body);
        const rec = ingestRaw(raw, { rcptTo: [{ address: body.to }, ...String(body.cc || '').split(',').map((a) => ({ address: a.trim() })).filter((a) => a.address)] });
        return sendJson(res, 200, { ok: true, id: rec.id, direction: rec.direction, message_id: rec.message_id });
      }
      if (req.method === 'POST' && url.pathname === '/api/clear') {
        captured.length = 0;
        return sendJson(res, 200, { ok: true });
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });
  webServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[mail-bridge] web port ${port} is already in use.`);
    } else {
      elog.error('bridge.web_error', { error: err.message });
    }
  });
  webServer.listen(port, '127.0.0.1', () => {
    console.log(`[mail-bridge] web inbox at http://localhost:${port}`);
  });
}

// Very small MIME helpers — enough to show the body of our own templated mail
// (text + optional html part) in the demo inbox; not a general MIME parser.
function decodePart(block, encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (enc === 'base64') return Buffer.from(block.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (enc === 'quoted-printable') {
    const unfolded = block.replace(/=\r?\n/g, '');
    const bytes = [];
    for (let i = 0; i < unfolded.length; i += 1) {
      if (unfolded[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(unfolded.substr(i + 1, 2))) {
        bytes.push(parseInt(unfolded.substr(i + 1, 2), 16));
        i += 2;
      } else {
        bytes.push(unfolded.charCodeAt(i) & 0xff);
      }
    }
    return Buffer.from(bytes).toString('utf8'); // reassemble multi-byte UTF-8
  }
  return block;
}

function extractPart(raw, type) {
  // Split headers from body.
  const idx = raw.search(/\r?\n\r?\n/);
  if (idx === -1) return null;
  const topHeaders = raw.slice(0, idx);
  const body = raw.slice(idx).replace(/^\r?\n\r?\n/, '');
  const boundaryMatch = /boundary="?([^"\r\n;]+)"?/i.exec(topHeaders);
  if (!boundaryMatch) {
    // Single part — only usable if it matches the requested type.
    if (new RegExp(`Content-Type:\\s*${type}`, 'i').test(topHeaders) || type === 'text/plain') {
      return decodePart(body, /Content-Transfer-Encoding:\s*([^\r\n]+)/i.exec(topHeaders)?.[1]);
    }
    return null;
  }
  const boundary = boundaryMatch[1];
  const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?\r?\n?`));
  for (const part of parts) {
    if (!new RegExp(`Content-Type:\\s*${type}`, 'i').test(part)) continue;
    const pIdx = part.search(/\r?\n\r?\n/);
    if (pIdx === -1) continue;
    const pHeaders = part.slice(0, pIdx);
    const pBody = part.slice(pIdx).replace(/^\r?\n\r?\n/, '');
    return decodePart(pBody, /Content-Transfer-Encoding:\s*([^\r\n]+)/i.exec(pHeaders)?.[1]).trim();
  }
  return null;
}

function extractTextBody(raw) {
  return extractPart(raw, 'text/plain') || '';
}
function extractHtmlBody(raw) {
  return extractPart(raw, 'text/html');
}

function startMailBridge() {
  if (!bridgeEnabled()) return null;
  const smtpPort = Number(process.env.MAIL_BRIDGE_SMTP_PORT || 2526);
  const webPort = Number(process.env.MAIL_BRIDGE_WEB_PORT || WEB_PORT_DEFAULT);
  startSmtp(smtpPort);
  startWeb(webPort);
  console.log('[mail-bridge] demo bridge active — outbound mail is captured locally and visible in the web inbox');
  return { smtpServer, webServer };
}

function stopMailBridge() {
  try { smtpServer?.close(); } catch { /* ignore */ }
  try { webServer?.close(); } catch { /* ignore */ }
  smtpServer = null;
  webServer = null;
}

const INBOX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ITSM Demo Mailbox</title>
<style>
  :root { color-scheme: light dark; --bg:#f4f5f7; --card:#fff; --line:#e3e6ea; --ink:#1b2733; --muted:#64748b; --accent:#2563eb; --in:#0a7d33; --out:#6b4ec9; }
  @media (prefers-color-scheme: dark){ :root{ --bg:#0f141a; --card:#1a222c; --line:#2a3340; --ink:#e7edf3; --muted:#93a1b0; --accent:#5b9dff; } }
  * { box-sizing: border-box; } body { margin:0; font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--ink); }
  header { padding:12px 16px; background:var(--card); border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  header h1 { font-size:16px; margin:0; } header .sub { color:var(--muted); font-size:12px; }
  button { font:inherit; border:1px solid var(--line); background:var(--card); color:var(--ink); border-radius:8px; padding:6px 12px; cursor:pointer; }
  button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
  .layout { display:grid; grid-template-columns: 340px 1fr; gap:0; height: calc(100vh - 54px); }
  @media (max-width:720px){ .layout{ grid-template-columns:1fr; height:auto; } }
  .list { border-right:1px solid var(--line); overflow:auto; background:var(--card); }
  .row { padding:10px 14px; border-bottom:1px solid var(--line); cursor:pointer; }
  .row:hover { background:rgba(127,127,127,.08); } .row.active { background:rgba(37,99,235,.12); }
  .row .top { display:flex; justify-content:space-between; gap:8px; }
  .row .subj { font-weight:600; } .row .meta { color:var(--muted); font-size:12px; }
  .tag { font-size:10px; font-weight:700; padding:1px 6px; border-radius:10px; color:#fff; }
  .tag.INBOUND{ background:var(--in);} .tag.OUTBOUND{ background:var(--out);}
  .view { padding:18px; overflow:auto; } .view h2 { margin:0 0 6px; font-size:18px; }
  .kv { color:var(--muted); font-size:12px; margin:2px 0; }
  .body { margin-top:14px; padding:14px; background:var(--card); border:1px solid var(--line); border-radius:10px; }
  pre { white-space:pre-wrap; word-break:break-word; font:inherit; margin:0; }
  dialog { border:1px solid var(--line); border-radius:12px; padding:0; width:min(560px,92vw); background:var(--card); color:var(--ink); }
  form { padding:16px; display:grid; gap:8px; } form label { font-size:12px; color:var(--muted); }
  input, textarea, select { font:inherit; width:100%; padding:7px 9px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--ink); }
  textarea { min-height:120px; resize:vertical; } .actions { display:flex; gap:8px; justify-content:flex-end; margin-top:6px; }
  .empty { padding:40px; text-align:center; color:var(--muted); }
  .mode { padding:8px 10px; border-radius:8px; font-size:12.5px; margin:2px 0 4px; }
  .mode.new { background:rgba(10,125,51,.12); border:1px solid rgba(10,125,51,.35); }
  .mode.reply { background:rgba(107,78,201,.12); border:1px solid rgba(107,78,201,.35); }
</style></head><body>
<header>
  <h1>📬 ITSM Demo Mailbox</h1>
  <span class="sub">Local SMTP bridge · outbound captured · reply to the support address to raise/thread a ticket</span>
  <span style="flex:1"></span>
  <button class="primary" onclick="compose()">✉ Compose as customer</button>
  <button onclick="load()">↻ Refresh</button>
  <button onclick="clearAll()">Clear</button>
</header>
<div class="layout">
  <div class="list" id="list"><div class="empty">No mail yet. Trigger an action in ITSM (create/assign/resolve a ticket) and it appears here.</div></div>
  <div class="view" id="view"><div class="empty">Select a message.</div></div>
</div>
<dialog id="dlg"><form id="f" onsubmit="send(event)">
  <h2 id="dlgTitle" style="margin:0 0 4px">Send mail as customer</h2>
  <div id="mode" class="mode new"></div>
  <label>From (customer)</label><input name="from" value="priya.sharma@cars24.com" required>
  <label>To (support mailbox)</label><input name="to" required>
  <label>Cc (optional)</label><input name="cc">
  <label>Subject</label><input name="subject" required>
  <label>Message</label><textarea name="text" required></textarea>
  <input type="hidden" name="inReplyTo"><input type="hidden" name="references">
  <div class="actions"><button type="button" onclick="document.getElementById('dlg').close()">Cancel</button><button class="primary" type="submit">Send</button></div>
</form></dialog>
<script>
let items=[], current=null, supportAddr='';
async function load(){
  items = await (await fetch('/api/messages')).json();
  const el=document.getElementById('list');
  if(!items.length){ el.innerHTML='<div class="empty">No mail yet. Trigger an action in ITSM and it appears here.</div>'; return; }
  el.innerHTML = items.slice().reverse().map(m=>\`<div class="row \${current===m.id?'active':''}" onclick="open_(\${m.id})">
    <div class="top"><span class="subj">\${esc(m.subject)}</span><span class="tag \${m.direction}">\${m.direction}</span></div>
    <div class="meta">\${esc(m.from)} → \${esc(m.to)}</div>
    <div class="meta">\${new Date(m.received_at).toLocaleString()}</div></div>\`).join('');
}
async function open_(id){
  current=id; load();
  const m = await (await fetch('/api/messages/'+id)).json();
  // Remember the support address from the first outbound mail (its From).
  if(m.direction==='OUTBOUND' && m.from) supportAddr=m.from;
  const v=document.getElementById('view');
  v.innerHTML = \`<h2>\${esc(m.subject)}</h2>
    <div class="kv"><b>From:</b> \${esc(m.from)}</div>
    <div class="kv"><b>To:</b> \${esc(m.to)}</div>
    \${m.cc?\`<div class="kv"><b>Cc:</b> \${esc(m.cc)}</div>\`:''}
    <div class="kv"><b>Date:</b> \${new Date(m.received_at).toLocaleString()}</div>
    <div class="kv"><b>Message-ID:</b> \${esc(m.message_id||'')}</div>
    \${m.in_reply_to?\`<div class="kv"><b>In-Reply-To:</b> \${esc(m.in_reply_to)}</div>\`:''}
    <div style="margin-top:12px"><button class="primary" onclick='reply(\${JSON.stringify(m).replace(/'/g,"&#39;")})'>↩ Reply as customer</button></div>
    <div class="body">\${m.body_html_safe || '<pre>'+esc(m.body_text||'(no body)')+'</pre>'}</div>\`;
}
function compose(prefill){
  const f=document.getElementById('f');
  f.reset();
  // Always start clean: a NEW email must never carry thread headers, or ITSM
  // would thread it onto the referenced incident instead of raising a new one.
  f.inReplyTo.value=''; f.references.value='';
  const isReply = !!(prefill && prefill.inReplyTo);
  f.to.value = (prefill&&prefill.to) || supportAddr || '';
  if(prefill){ for(const k in prefill){ if(f[k]!==undefined) f[k].value = prefill[k]; } }
  const banner=document.getElementById('mode'), title=document.getElementById('dlgTitle');
  if(isReply){
    const inc=((prefill.subject||'').match(/\\[(INC-\\d+)\\]/)||[])[1]||'the incident';
    title.textContent='Reply as customer';
    banner.className='mode reply';
    banner.innerHTML='↪ <b>Reply</b> — this threads onto <b>'+inc+'</b> (adds a comment, and reopens it if closed). No new incident is created.';
  } else {
    title.textContent='New email as customer';
    banner.className='mode new';
    banner.innerHTML='✚ <b>New email</b> — this raises a <b>new incident</b> and sends an acknowledgement. Not linked to any existing ticket.';
  }
  document.getElementById('dlg').showModal();
}
function reply(m){
  // Customer replies: From = whoever the mail was addressed to (the customer),
  // To = the support mailbox (the mail's From), subject RE:, thread headers set.
  const customer = (m.to||'').split(',')[0].trim();
  const support = m.from;
  const subject = /^re:/i.test(m.subject)? m.subject : 'RE: '+m.subject;
  const refs = [m.references, m.message_id].filter(Boolean).join(' ');
  compose({ from: customer, to: support, subject, inReplyTo: m.message_id||'', references: refs });
}
async function send(e){
  e.preventDefault();
  const f=e.target, data=Object.fromEntries(new FormData(f).entries());
  const r = await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const j = await r.json();
  document.getElementById('dlg').close();
  if(!r.ok){ alert(j.error||'Send failed'); return; }
  setTimeout(load, 400);
}
async function clearAll(){ if(confirm('Clear the demo mailbox view? (Tickets already created stay.)')){ await fetch('/api/clear',{method:'POST'}); current=null; document.getElementById('view').innerHTML='<div class="empty">Select a message.</div>'; load(); } }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
load(); setInterval(load, 4000);
</script>
</body></html>`;

module.exports = { startMailBridge, stopMailBridge, bridgeEnabled };
