const express = require('express');
const { authenticate, requireRole, IT_ROLES } = require('../auth');
const { advancedAnalytics, slaRiskList } = require('../predict');
const { dashboardAnalytics } = require('../dashboard');

const router = express.Router();
router.use(authenticate, requireRole(...IT_ROLES));

// BRD 8.13: advanced dashboards — forecast, recurring prediction, asset
// failure trends, workload, team performance, cost, resolution trend, CSAT.
router.get('/advanced', (_req, res) => res.json(advancedAnalytics()));

// BRD 8.12: open tickets ranked by predicted SLA breach probability.
router.get('/sla-risk', (_req, res) => res.json(slaRiskList()));

// KPI & analytics dashboard (BRD 6.13 / 8.13): one aggregated payload for the
// Overview page. Query: from, to (YYYY-MM-DD), group_id, category_id,
// priority_id, status. Role scope mirrors /reports/dashboard.
router.get('/dashboard', (req, res) => {
  try {
    res.json(dashboardAnalytics(req.user, req.query));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

module.exports = router;
