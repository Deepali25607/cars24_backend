const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { signToken, authenticate } = require('../auth');
const { audit } = require('../services');

const router = express.Router();

function publicUser(u) {
  const { password_hash, ...rest } = u;
  return rest;
}

// ---------- Login throttling (brute-force protection) ----------
// In-memory sliding lockout keyed by email+IP: after MAX_FAILS failures within
// WINDOW_MS, further attempts are refused for LOCK_MS. Cleared on success.
const MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS || 5);
const WINDOW_MS = Number(process.env.LOGIN_WINDOW_MS || 15 * 60 * 1000);
const LOCK_MS = Number(process.env.LOGIN_LOCK_MS || 15 * 60 * 1000);
const attempts = new Map(); // key -> { fails, first, lockedUntil }

function loginKey(req, email) {
  return `${String(email || '').trim().toLowerCase()}|${req.ip}`;
}
function checkLock(key) {
  const rec = attempts.get(key);
  if (rec?.lockedUntil && rec.lockedUntil > Date.now()) {
    return Math.ceil((rec.lockedUntil - Date.now()) / 1000);
  }
  return 0;
}
function recordFail(key) {
  const now = Date.now();
  let rec = attempts.get(key);
  if (!rec || now - rec.first > WINDOW_MS) rec = { fails: 0, first: now, lockedUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= MAX_FAILS) rec.lockedUntil = now + LOCK_MS;
  attempts.set(key, rec);
}
function clearFails(key) { attempts.delete(key); }
// Opportunistic cleanup so the map cannot grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, r] of attempts) {
    if ((r.lockedUntil || 0) < now && now - r.first > WINDOW_MS) attempts.delete(k);
  }
}, WINDOW_MS).unref?.();

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const key = loginKey(req, email);
  const lockedFor = checkLock(key);
  if (lockedFor) {
    audit(null, 'LOGIN_LOCKED', 'user', email, `locked ${lockedFor}s`, req);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(lockedFor / 60)} minute(s).` });
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    recordFail(key);
    audit(null, 'LOGIN_FAILED', 'user', email, null, req);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (!user.active) return res.status(401).json({ error: 'Account is inactive' });
  clearFails(key);
  audit(user.id, 'LOGIN', 'user', user.id, null, req);
  res.json({ token: signToken(user), user: publicUser(user) });
});

router.get('/me', authenticate, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json(publicUser(user));
});

router.post('/change-password', authenticate, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(currentPassword || '', user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  // Changing the password bumps the session epoch, revoking every outstanding JWT.
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, tokens_valid_after = tokens_valid_after + 1 WHERE id = ?')
    .run(bcrypt.hashSync(newPassword, 10), user.id);
  audit(user.id, 'PASSWORD_CHANGED', 'user', user.id, null, req);
  // Issue a fresh token so the caller is not immediately logged out by the
  // revocation above (its iat is >= tokens_valid_after).
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ ok: true, token: signToken(updated) });
});

router.post('/logout', authenticate, (req, res) => {
  // Bump the session epoch so all outstanding JWTs for this user are rejected.
  db.prepare('UPDATE users SET tokens_valid_after = tokens_valid_after + 1 WHERE id = ?').run(req.user.id);
  audit(req.user.id, 'LOGOUT', 'user', req.user.id, null, req);
  res.json({ ok: true });
});

// ---------- STANDARD S14: SSO via OIDC (BRD 7.14) ----------
// Config-driven; disabled until the customer confirms the identity provider.
// Required env: OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI
// Optional: OIDC_PROVIDER_NAME (display), OIDC_SCOPES (default 'openid email profile')
// Only pre-provisioned active users may sign in via SSO (no auto-provisioning).

function ssoEnabled() {
  return !!(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID &&
    process.env.OIDC_CLIENT_SECRET && process.env.OIDC_REDIRECT_URI);
}

let oidcConfig = null;
async function oidcDiscover() {
  if (oidcConfig) return oidcConfig;
  const issuer = process.env.OIDC_ISSUER.replace(/\/$/, '');
  const resp = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!resp.ok) throw new Error('OIDC discovery failed');
  oidcConfig = await resp.json();
  return oidcConfig;
}

router.get('/sso', (_req, res) => {
  res.json({ enabled: ssoEnabled(), provider: process.env.OIDC_PROVIDER_NAME || 'Enterprise SSO' });
});

// Short-lived anti-CSRF "state" values issued at /sso/start and consumed once at
// /sso/callback (login-CSRF protection). In-memory is fine for the single-node
// SSO deployment; they expire after 10 minutes.
const ssoStates = new Map();
function issueState() {
  const s = require('crypto').randomBytes(16).toString('hex');
  ssoStates.set(s, Date.now() + 10 * 60 * 1000);
  return s;
}
function consumeState(s) {
  const exp = ssoStates.get(s);
  ssoStates.delete(s);
  return !!exp && exp > Date.now();
}
setInterval(() => { const now = Date.now(); for (const [s, e] of ssoStates) if (e < now) ssoStates.delete(s); }, 10 * 60 * 1000).unref?.();

router.get('/sso/start', async (_req, res) => {
  if (!ssoEnabled()) return res.status(404).json({ error: 'SSO is not configured' });
  try {
    const cfg = await oidcDiscover();
    const params = new URLSearchParams({
      client_id: process.env.OIDC_CLIENT_ID,
      redirect_uri: process.env.OIDC_REDIRECT_URI,
      response_type: 'code',
      scope: process.env.OIDC_SCOPES || 'openid email profile',
      state: issueState(),
    });
    res.redirect(`${cfg.authorization_endpoint}?${params}`);
  } catch (err) {
    res.status(502).json({ error: `Could not reach the identity provider: ${err.message}` });
  }
});

router.get('/sso/callback', async (req, res) => {
  if (!ssoEnabled()) return res.status(404).json({ error: 'SSO is not configured' });
  const { code, state } = req.query;
  if (!code) return res.status(400).json({ error: 'Missing authorization code' });
  if (!state || !consumeState(String(state))) {
    audit(null, 'SSO_LOGIN_FAILED', 'user', '', 'Invalid or missing state (possible login CSRF)', req);
    return res.status(400).json({ error: 'Invalid or expired SSO state' });
  }
  try {
    const cfg = await oidcDiscover();
    const tokenResp = await fetch(cfg.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: process.env.OIDC_REDIRECT_URI,
        client_id: process.env.OIDC_CLIENT_ID,
        client_secret: process.env.OIDC_CLIENT_SECRET,
      }),
    });
    if (!tokenResp.ok) throw new Error('token exchange failed');
    const tokens = await tokenResp.json();
    const userResp = await fetch(cfg.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!userResp.ok) throw new Error('userinfo request failed');
    const info = await userResp.json();
    // Require a verified email claim; never fall back to preferred_username
    // (which is not a verified identity and can be attacker-controlled).
    if (!info.email) throw new Error('identity provider returned no email');
    if (info.email_verified === false) throw new Error('identity provider reports the email is not verified');
    const email = info.email;

    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(String(email));
    if (!user) {
      audit(null, 'SSO_LOGIN_DENIED', 'user', email, 'No matching active user', req);
      return res.status(403).json({ error: 'Your SSO account is not provisioned in ITSM. Contact your administrator.' });
    }
    audit(user.id, 'SSO_LOGIN', 'user', user.id, null, req);
    const appUrl = process.env.APP_URL || 'http://localhost:5173';
    res.redirect(`${appUrl}/login#sso_token=${encodeURIComponent(signToken(user))}`);
  } catch (err) {
    audit(null, 'SSO_LOGIN_FAILED', 'user', '', err.message, req);
    res.status(502).json({ error: `SSO sign-in failed: ${err.message}` });
  }
});

module.exports = router;
