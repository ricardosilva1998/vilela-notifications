const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const router = express.Router();

// /racing — landing (if not logged in) or dashboard (if logged in)
router.get('/', (req, res) => {
  if (req.racingUser) {
    // Logged in — show dashboard with user's sessions
    const bridgeId = req.racingUser.bridge_id || '';
    const sessions = db.getSessionsByTrack ? [] : []; // all tracks
    // Get recent sessions across all tracks
    let recentSessions = [];
    try {
      const stmt = db.db ? null : null; // fallback
      // Query recent sessions for this user (by bridge_id or racing_user_id)
      recentSessions = db.getRecentSessionsByUser ? db.getRecentSessionsByUser(req.racingUser.id, bridgeId, 20) : [];
    } catch(e) {}
    const teamMembership = db.getTeamForUser(req.racingUser.id);
    const pendingTeamInvites = db.getPendingInvitesForUser(req.racingUser.id);
    return res.render('racing-dashboard', {
      streamer: req.streamer || null,
      racingUser: req.racingUser,
      sessions: recentSessions,
      team: teamMembership,
      pendingTeamInvites,
    });
  }
  res.render('racing-landing', { streamer: req.streamer || null, racingUser: null, error: req.query.error || null });
});

router.get('/signup', (req, res) => {
  if (req.racingUser) return res.redirect('/racing');
  res.render('racing-signup', { streamer: req.streamer || null, racingUser: null, error: req.query.error || null });
});

// Redirect old URL
router.get('/dashboard', (req, res) => res.redirect('/racing'));

// Auth wall — everything below requires Racing login
router.use((req, res, next) => {
  if (!req.racingUser) return res.redirect('/racing');
  next();
});

router.get('/account', (req, res) => {
  res.render('racing-account', { streamer: req.streamer || null, racingUser: req.racingUser, msg: req.query.msg || null, error: req.query.error || null });
});

// Admin — Racing accounts + Bridge users
router.get('/admin', (req, res) => {
  if (!res.locals.isAdmin) return res.redirect('/racing');
  const racingUsers = db.getAllRacingUsers();
  const bridgeUsers = db.getBridgeUserStats();
  const suspicious = db.getSuspiciousActivity(24);
  const authLog = db.getRecentAuthLog(30);
  res.render('racing-admin', { streamer: req.streamer || null, racingUser: req.racingUser, racingUsers, bridgeUsers, suspicious, authLog });
});

router.post('/admin/unlock/:id', (req, res) => {
  if (!res.locals.isAdmin) return res.redirect('/racing');
  db.unlockRacingAccount(parseInt(req.params.id));
  res.redirect('/racing/admin');
});

router.post('/admin/lock/:id', (req, res) => {
  if (!res.locals.isAdmin) return res.redirect('/racing');
  db.lockRacingAccount(parseInt(req.params.id));
  res.redirect('/racing/admin');
});

router.post('/admin/delete/:id', (req, res) => {
  if (!res.locals.isAdmin) return res.redirect('/racing');
  const userId = parseInt(req.params.id);
  // Don't allow deleting your own account
  if (req.racingUser && req.racingUser.id === userId) {
    return res.redirect('/racing/admin');
  }
  db.deleteRacingUser(userId);
  res.redirect('/racing/admin');
});

// Update profile
router.post('/account/profile', express.urlencoded({ extended: true }), (req, res) => {
  const displayName = (req.body.display_name || '').trim().slice(0, 32);
  const iracingName = (req.body.iracing_name || '').trim().slice(0, 64);
  db.updateRacingProfile(req.racingUser.id, displayName || null, iracingName || null);
  res.redirect('/racing/account?msg=Profile updated');
});

// Upload avatar (base64 data URL)
router.post('/account/avatar', express.json({ limit: '2mb' }), (req, res) => {
  try {
    const { avatar } = req.body;
    if (!avatar || !avatar.startsWith('data:image/')) return res.status(400).json({ error: 'Invalid image' });
    // Limit to 500KB base64
    if (avatar.length > 700000) return res.status(400).json({ error: 'Image too large (max 500KB)' });
    db.updateRacingAvatar(req.racingUser.id, avatar);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'Failed to upload avatar' });
  }
});

// Change password
router.post('/account/password', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { current_password, new_password, confirm_password } = req.body;
    if (!current_password || !new_password) return res.redirect('/racing/account?error=All fields required');
    if (new_password !== confirm_password) return res.redirect('/racing/account?error=Passwords do not match');
    if (new_password.length < 8) return res.redirect('/racing/account?error=Password must be at least 8 characters');

    const valid = await bcrypt.compare(current_password, req.racingUser.password_hash);
    if (!valid) return res.redirect('/racing/account?error=Current password is incorrect');

    const hash = await bcrypt.hash(new_password, 10);
    db.updateRacingPassword(req.racingUser.id, hash);
    // Invalidate all other sessions so stolen sessions can't persist
    const currentSid = req.cookies?.session;
    if (currentSid) db.deleteOtherSessions(currentSid, { racingUserId: req.racingUser.id });
    res.redirect('/racing/account?msg=Password updated');
  } catch(e) {
    res.redirect('/racing/account?error=Failed to update password');
  }
});

module.exports = router;
