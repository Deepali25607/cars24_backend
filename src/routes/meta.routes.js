const express = require('express');
const { db } = require('../db');
const { authenticate, IT_ROLES } = require('../auth');

const router = express.Router();
router.use(authenticate);

// Reference data every logged-in user needs for forms and filters.
router.get('/', (req, res) => {
  const categories = db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY name').all();
  const subcategories = db.prepare('SELECT * FROM subcategories WHERE active = 1 ORDER BY name').all();
  const priorities = db.prepare('SELECT * FROM priorities ORDER BY sort').all();
  const locations = db.prepare('SELECT * FROM locations WHERE active = 1 ORDER BY name').all();
  const groups = db.prepare('SELECT * FROM support_groups WHERE active = 1 ORDER BY name').all();
  const departments = db.prepare('SELECT * FROM departments WHERE active = 1 ORDER BY name').all();

  const myAssets = db.prepare(
    'SELECT id, asset_tag, manufacturer, model, hostname, operating_system, warranty_until FROM assets WHERE assigned_user_id = ? AND active = 1'
  ).all(req.user.id);

  let agents = [];
  if (IT_ROLES.includes(req.user.role)) {
    agents = db.prepare(`
      SELECT u.id, u.full_name, u.role, u.support_group_id, g.name AS group_name
      FROM users u LEFT JOIN support_groups g ON g.id = u.support_group_id
      WHERE u.active = 1 AND u.role IN ('AGENT','TEAM_LEAD','ADMIN')
      ORDER BY u.full_name`).all();
  }

  // STANDARD: catalog items for the request form (BRD 7.7)
  const catalogItems = db.prepare(
    'SELECT id, name, description, icon, requires_approval FROM catalog_items WHERE active = 1 ORDER BY name'
  ).all();

  res.json({ categories, subcategories, priorities, locations, groups, departments, myAssets, agents, catalogItems });
});

module.exports = router;
