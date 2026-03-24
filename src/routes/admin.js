const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');

const router = Router();

// Admin auth middleware — uses Discord session, checks isAdmin
function requireAdmin(req, res, next) {
  if (req.streamer && db.isAdmin(req.streamer.id)) {
    return next();
  }
  res.redirect('/dashboard');
}

// Main admin dashboard (tabbed)
router.get('/', requireAdmin, (req, res) => {
  res.redirect('/admin/dashboard');
});

router.get('/dashboard', requireAdmin, (req, res) => {
  const activeTab = req.query.tab || 'stats';

  // Stats tab data
  const stats = db.getGlobalStats();
  const users = db.getUsersOverTime('%Y-%m', 12);
  const notifications = db.getNotificationsOverTime('%Y-%m', 12);
  const servers = db.getServersOverTime('%Y-%m', 12);
  const tierBreakdown = db.getSubscriptionsByTier();
  const revenueStats = db.getRevenueStats();

  // Users tab data
  const streamers = db.getAllStreamersAdmin();

  // Issues tab data
  const issues = db.getAllIssues();

  // Feedback tab data
  const feedback = db.getAllFeedback();

  // Discounts tab data
  const codes = db.getAllDiscountCodes();

  // System stats
  const uptime = process.uptime();
  const memory = process.memoryUsage();
  let dbSize = 0;
  try {
    const dbPath = path.join(__dirname, '..', 'data', 'bot.db');
    dbSize = fs.statSync(dbPath).size;
  } catch (e) {}

  res.render('admin-dashboard', {
    streamer: req.streamer,
    title: 'Admin Panel',
    activeTab,
    stats,
    users,
    notifications,
    servers,
    tierBreakdown,
    revenueStats,
    streamers,
    issues,
    feedback,
    codes,
    system: { uptime, memory, dbSize },
    msg: req.query.msg,
  });
});

// --- User management ---

router.post('/streamers/:id/toggle', requireAdmin, (req, res) => {
  const s = db.getStreamerById(parseInt(req.params.id));
  if (!s) return res.redirect('/admin/dashboard?tab=users');

  if (s.enabled) {
    db.disableStreamer(s.id, req.body.note || 'Disabled by admin');
    console.log(`[Admin] Disabled streamer ${s.discord_username} (${s.id})`);
  } else {
    db.enableStreamer(s.id);
    console.log(`[Admin] Enabled streamer ${s.discord_username} (${s.id})`);
  }
  res.redirect('/admin/dashboard?tab=users');
});

router.post('/streamers/:id/remove', requireAdmin, (req, res) => {
  const s = db.getStreamerById(parseInt(req.params.id));
  if (!s) return res.redirect('/admin/dashboard?tab=users');

  db.deleteStreamer(s.id);
  console.log(`[Admin] Removed streamer ${s.discord_username} (${s.id})`);
  res.redirect('/admin/dashboard?tab=users&msg=removed');
});

router.post('/streamers/:id/set-tier', requireAdmin, (req, res) => {
  const s = db.getStreamerById(parseInt(req.params.id));
  if (!s) return res.redirect('/admin/dashboard?tab=users');

  const tier = req.body.tier;
  if (!['free', 'starter', 'pro', 'enterprise'].includes(tier)) {
    return res.redirect('/admin/dashboard?tab=users');
  }

  db.createSubscription(s.id, tier, null, null);
  console.log(`[Admin] Set ${s.discord_username} tier to ${tier}`);
  res.redirect('/admin/dashboard?tab=users&msg=tier_updated');
});

// --- Issues ---

router.post('/issues/:id', requireAdmin, (req, res) => {
  const issue = db.getIssueById(parseInt(req.params.id));
  if (!issue) return res.redirect('/admin/dashboard?tab=issues');

  db.updateIssueStatus(issue.id, req.body.status || 'open', req.body.admin_reply);
  console.log(`[Admin] Issue ${issue.id} updated to ${req.body.status}`);
  res.redirect('/admin/dashboard?tab=issues&msg=updated');
});

// --- Discounts ---

router.post('/discounts', requireAdmin, (req, res) => {
  const { code, discount_percent, max_uses } = req.body;
  if (!code || !discount_percent) return res.redirect('/admin/dashboard?tab=discounts');
  db.createDiscountCode(code, parseInt(discount_percent), max_uses ? parseInt(max_uses) : null);
  console.log(`[Admin] Created discount code ${code} (${discount_percent}%)`);
  res.redirect('/admin/dashboard?tab=discounts&msg=created');
});

router.post('/discounts/:id/toggle', requireAdmin, (req, res) => {
  const codes = db.getAllDiscountCodes();
  const code = codes.find((c) => c.id === parseInt(req.params.id));
  if (code) db.toggleDiscountCode(code.id, !code.active);
  res.redirect('/admin/dashboard?tab=discounts');
});

module.exports = router;
