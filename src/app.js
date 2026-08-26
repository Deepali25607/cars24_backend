const express = require('express');
const cors = require('cors');

// Express app without the listener, so tests can mount it on an ephemeral port.
function buildApp() {
  const app = express();
  app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173' }));
  app.use(express.json({ limit: '1mb' }));
  app.set('trust proxy', true);

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
    console.error('[error]', err);
    res.status(err.status || 500).json({ error: err.message || 'Unexpected server error' });
  });

  return app;
}

module.exports = { buildApp };
