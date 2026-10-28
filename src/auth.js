const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { db } = require('./db');

// In production the server refuses to start without JWT_SECRET (see server.js);
// the hard-coded fallback is for development/tests only.
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const TOKEN_TTL = process.env.TOKEN_TTL || '12h';

// Endpoints a user with must_change_password may still reach before changing it.
const PASSWORD_CHANGE_ALLOWLIST = ['/api/auth/change-password', '/api/auth/me', '/api/auth/logout'];

// Cryptographically-random temporary password (admin create / reset).
function generateTempPassword() {
  return `Tmp-${crypto.randomBytes(9).toString('base64url')}`;
}

function signToken(user) {
  return jwt.sign(
    // `epoch` ties the token to the user's current session generation; logout and
    // password change bump it so older tokens are rejected (see authenticate).
    { sub: user.id, role: user.role, name: user.full_name, epoch: user.tokens_valid_after || 0 },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

// Attaches req.user (fresh from DB so role/active changes apply immediately).
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare(
      'SELECT id, email, full_name, role, department_id, location_id, support_group_id, active, must_change_password, tokens_valid_after FROM users WHERE id = ?'
    ).get(payload.sub);
    if (!user || !user.active) return res.status(401).json({ error: 'Account is inactive' });
    // Revoked by a logout or password change: the token's session epoch is older
    // than the user's current one.
    if ((payload.epoch || 0) < (user.tokens_valid_after || 0)) {
      return res.status(401).json({ error: 'Session has been revoked. Please sign in again.' });
    }
    req.user = user;
    // Force a password change before anything else can be done with the session
    // (default/reset passwords must not stay usable). The user can still reach
    // /me, /logout and /change-password.
    if (user.must_change_password && !PASSWORD_CHANGE_ALLOWLIST.includes(req.originalUrl.split('?')[0])) {
      return res.status(403).json({ error: 'You must change your password before continuing.', code: 'PASSWORD_CHANGE_REQUIRED' });
    }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

const IT_ROLES = ['AGENT', 'TEAM_LEAD', 'ADMIN'];

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission for this action' });
    }
    next();
  };
}

module.exports = { signToken, authenticate, requireRole, IT_ROLES, generateTempPassword };
