const { Router } = require('express');
const config = require('../config');
const db = require('../db');

const router = Router();

// Admin auth middleware
function requireAdmin(req, res, next) {
  if (req.cookies?.admin_session === config.app.adminPassword && config.app.adminPassword) {
    return next();
  }
  res.redirect('/admin');
}

// Login page
router.get('/', (req, res) => {
  if (req.cookies?.admin_session === config.app.adminPassword && config.app.adminPassword) {
    return res.redirect('/admin/dashboard');
  }
  const error = req.query.error;
  res.render('admin-login', { streamer: null, title: 'Admin Login', error });
});

router.post('/login', (req, res) => {
  const { password } = req.body;
  if (!config.app.adminPassword) {
    return res.redirect('/admin?error=not_configured');
  }
  if (password === config.app.adminPassword) {
    res.cookie('admin_session', password, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
    return res.redirect('/admin/dashboard');
  }
  res.redirect('/admin?error=invalid');
});

router.get('/logout', (req, res) => {
  res.clearCookie('admin_session');
  res.redirect('/admin');
});

// Dashboard
router.get('/dashboard', requireAdmin, (req, res) => {
  const stats = db.getGlobalStats();
  const recentNotifications = db.getRecentNotifications();
  res.render('admin-dashboard', { streamer: null, title: 'Admin Dashboard', stats, recentNotifications });
});

// Streamers list
router.get('/streamers', requireAdmin, (req, res) => {
  const streamers = db.getAllStreamersAdmin();
  res.render('admin-streamers', { streamer: null, title: 'Manage Streamers', streamers });
});

// Toggle enable/disable
router.post('/streamers/:id/toggle', requireAdmin, (req, res) => {
  const s = db.getStreamerById(parseInt(req.params.id));
  if (!s) return res.redirect('/admin/streamers');

  if (s.enabled) {
    db.disableStreamer(s.id, req.body.note || 'Disabled by admin');
    console.log(`[Admin] Disabled streamer ${s.discord_username} (${s.id})`);
  } else {
    db.enableStreamer(s.id);
    console.log(`[Admin] Enabled streamer ${s.discord_username} (${s.id})`);
  }
  res.redirect('/admin/streamers');
});

// Remove streamer
router.post('/streamers/:id/remove', requireAdmin, (req, res) => {
  const s = db.getStreamerById(parseInt(req.params.id));
  if (!s) return res.redirect('/admin/streamers');

  db.deleteStreamer(s.id);
  console.log(`[Admin] Removed streamer ${s.discord_username} (${s.id})`);
  res.redirect('/admin/streamers');
});

// Analytics
router.get('/analytics', requireAdmin, (req, res) => {
  const users = db.getUsersOverTime('%Y-%m', 12);
  const notifications = db.getNotificationsOverTime('%Y-%m', 12);
  const servers = db.getServersOverTime('%Y-%m', 12);
  const revenue = db.getMonthlyRevenue();
  const tierBreakdown = db.getSubscriptionsByTier();
  res.render('admin-analytics', { streamer: null, title: 'Analytics', users, notifications, servers, revenue, tierBreakdown });
});

// Revenue
router.get('/revenue', requireAdmin, (req, res) => {
  const revenueStats = db.getRevenueStats();
  const transactions = db.getRecentTransactions();
  res.render('admin-revenue', { streamer: null, title: 'Revenue', revenueStats, transactions });
});

// Discount codes
router.get('/discounts', requireAdmin, (req, res) => {
  const codes = db.getAllDiscountCodes();
  res.render('admin-discounts', { streamer: null, title: 'Discount Codes', codes, msg: req.query.msg });
});

router.post('/discounts', requireAdmin, (req, res) => {
  const { code, discount_percent, max_uses } = req.body;
  if (!code || !discount_percent) return res.redirect('/admin/discounts');
  db.createDiscountCode(code, parseInt(discount_percent), max_uses ? parseInt(max_uses) : null);
  console.log(`[Admin] Created discount code ${code} (${discount_percent}%)`);
  res.redirect('/admin/discounts?msg=created');
});

router.post('/discounts/:id/toggle', requireAdmin, (req, res) => {
  const codes = db.getAllDiscountCodes();
  const code = codes.find((c) => c.id === parseInt(req.params.id));
  if (code) db.toggleDiscountCode(code.id, !code.active);
  res.redirect('/admin/discounts');
});

// Issues list
router.get('/issues', requireAdmin, (req, res) => {
  const issues = db.getAllIssues();
  res.render('admin-issues', { streamer: null, title: 'Reported Issues', issues, msg: req.query.msg });
});

// Update issue
router.post('/issues/:id', requireAdmin, (req, res) => {
  const issue = db.getIssueById(parseInt(req.params.id));
  if (!issue) return res.redirect('/admin/issues');

  db.updateIssueStatus(issue.id, req.body.status || 'open', req.body.admin_reply);
  console.log(`[Admin] Issue ${issue.id} updated to ${req.body.status}`);
  res.redirect('/admin/issues?msg=updated');
});

module.exports = router;
