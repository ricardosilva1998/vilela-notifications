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
