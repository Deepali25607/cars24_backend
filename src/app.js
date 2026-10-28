const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

// Express app without the listener, so tests can mount it on an ephemeral port.
function buildApp() {
  const app = express();
  // Baseline security headers (no CSP here — this is a JSON API; the SPA sets
  // its own CSP via vercel.json). nosniff, no framing, no referrer leakage.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }));
  // Known frontends are always allowed; CORS_ORIGIN (or CLIENT_ORIGIN) can add
  // more as a comma-separated list, e.g. "https://staging.example.com"
  const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:3000',
    'https://cars24-frontend.vercel.app',
    ...(process.env.CORS_ORIGIN || process.env.CLIENT_ORIGIN || '')
      .split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean),
  ];
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
  }));
  app.use(express.json({ limit: '1mb' }));
  // Trust only the actual number of proxy hops in front of the app (default 1,
  // e.g. one load balancer / Vercel/Render edge). Setting `true` would let any
  // client spoof its IP via X-Forwarded-For and poison the audit log.
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));

  app.get('/api/health', (_req, res) => res.json({ ok: true, phase: 'ADVANCED' }));

  app.use('/api/auth', require('./routes/auth.routes'));
  app.use('/api/meta', require('./routes/meta.routes'));
  app.use('/api/tickets', require('./routes/tickets.routes'));
  app.use('/api/assets', require('./routes/assets.routes'));
  app.use('/api/notifications', require('./routes/notifications.routes'));
  app.use('/api/reports', require('./routes/reports.routes'));
  app.use('/api/admin', require('./routes/admin.routes'));
  // STANDARD phase routers (BRD section 7)
  app.use('/api/sla', require('./routes/sla.routes'));
  app.use('/api/kb', require('./routes/kb.routes'));
  app.use('/api/catalog', require('./routes/catalog.routes'));
  app.use('/api/requests', require('./routes/requests.routes'));
  app.use('/api/search', require('./routes/search.routes'));
  app.use('/api/integrations', require('./routes/integrations.routes'));
  app.use('/api/email', require('./routes/email.routes')); // S10 extension: two-way email channel
  // ADVANCED phase routers (BRD section 8)
  app.use('/api/cmdb', require('./routes/cmdb.routes'));
  app.use('/api/problems', require('./routes/problems.routes'));
  app.use('/api/changes', require('./routes/changes.routes'));
  app.use('/api/major', require('./routes/major.routes'));
  app.use('/api/ai', require('./routes/ai.routes'));
  app.use('/api/analytics', require('./routes/analytics.routes'));

  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid request body' });
    }
    // CORS rejections are a client problem, not a server fault.
    if (/not allowed by CORS/.test(err.message || '')) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }
    console.error('[error]', err);
    const status = err.status || err.statusCode || 500;
    // Never leak internal error detail/stack to clients on a 5xx. Deliberate
    // 4xx errors (with an explicit status) may carry a user-facing message.
    if (status >= 500) {
      return res.status(status).json({ error: 'Unexpected server error' });
    }
    res.status(status).json({ error: err.message || 'Request failed' });
  });

  return app;
}

module.exports = { buildApp };
