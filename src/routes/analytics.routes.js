const express = require('express');
const { authenticate, requireRole, IT_ROLES } = require('../auth');
const { advancedAnalytics, slaRiskList } = require('../predict');

const router = express.Router();
router.use(authenticate, requireRole(...IT_ROLES));

// BRD 8.13: advanced dashboards — forecast, recurring prediction, asset
// failure trends, workload, team performance, cost, resolution trend, CSAT.
router.get('/advanced', (_req, res) => res.json(advancedAnalytics()));

// BRD 8.12: open tickets ranked by predicted SLA breach probability.
router.get('/sla-risk', (_req, res) => res.json(slaRiskList()));

module.exports = router;
