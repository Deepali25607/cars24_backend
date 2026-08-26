const jwt = require('jsonwebtoken');
const { db } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const TOKEN_TTL = process.env.TOKEN_TTL || '12h';

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, name: user.full_name },
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
      'SELECT id, email, full_name, role, department_id, location_id, support_group_id, active, must_change_password FROM users WHERE id = ?'
    ).get(payload.sub);
    if (!user || !user.active) return res.status(401).json({ error: 'Account is inactive' });
    req.user = user;
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

module.exports = { signToken, authenticate, requireRole, IT_ROLES };
