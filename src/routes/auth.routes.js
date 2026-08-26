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

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    audit(null, 'LOGIN_FAILED', 'user', email, null, req);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (!user.active) return res.status(401).json({ error: 'Account is inactive' });
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
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(bcrypt.hashSync(newPassword, 10), user.id);
  audit(user.id, 'PASSWORD_CHANGED', 'user', user.id, null, req);
  res.json({ ok: true });
});

router.post('/logout', authenticate, (req, res) => {
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

router.get('/sso/start', async (_req, res) => {
  if (!ssoEnabled()) return res.status(404).json({ error: 'SSO is not configured' });
  try {
    const cfg = await oidcDiscover();
    const params = new URLSearchParams({
      client_id: process.env.OIDC_CLIENT_ID,
      redirect_uri: process.env.OIDC_REDIRECT_URI,
      response_type: 'code',
      scope: process.env.OIDC_SCOPES || 'openid email profile',
    });
    res.redirect(`${cfg.authorization_endpoint}?${params}`);
  } catch (err) {
    res.status(502).json({ error: `Could not reach the identity provider: ${err.message}` });
  }
});

router.get('/sso/callback', async (req, res) => {
  if (!ssoEnabled()) return res.status(404).json({ error: 'SSO is not configured' });
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'Missing authorization code' });
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
    const email = info.email || info.preferred_username;
    if (!email) throw new Error('identity provider returned no email');

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
