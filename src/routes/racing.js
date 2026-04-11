const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const router = express.Router();

// /racing — landing (if not logged in) or dashboard (if logged in)
router.get('/', (req, res) => {
  if (req.racingUser) {
    const teams = db.getTeamsForUser(req.racingUser.id);
    const pendingTeamInvites = db.getPendingInvitesForUser(req.racingUser.id);
    return res.render('racing-dashboard', {
      streamer: req.streamer || null,
      racingUser: req.racingUser,
      teams,
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
  const bridgeId = req.racingUser.bridge_id || '';
  let sessions = [];
  try {
    sessions = db.getRecentSessionsByUser ? db.getRecentSessionsByUser(req.racingUser.id, bridgeId, 20) : [];
  } catch(e) {}
  res.render('racing-account', { streamer: req.streamer || null, racingUser: req.racingUser, msg: req.query.msg || null, error: req.query.error || null, sessions });
});

// Pitwall — live telemetry viewer
router.get('/pitwall', (req, res) => {
  const teams = db.getTeamsForUser(req.racingUser.id);
  if (teams.length === 0) return res.redirect('/racing/teams');

  // If only 1 team, go straight to pitwall
  if (teams.length === 1) {
    const members = db.getTeamMembers(teams[0].team_id);
    return res.render('racing-pitwall', {
      streamer: req.streamer || null,
      racingUser: req.racingUser,
      team: teams[0],
      members,
    });
  }

  // Multiple teams — show team picker
  const enrichedTeams = teams.map(t => ({
    ...t,
    member_count: db.getTeamMemberCount(t.team_id),
  }));
  res.render('racing-pitwall-picker', {
    streamer: req.streamer || null,
    racingUser: req.racingUser,
    teams: enrichedTeams,
  });
});

// Pitwall for a specific team
router.get('/pitwall/:teamId', (req, res) => {
  const teamId = parseInt(req.params.teamId);
  const membership = db.getTeamsForUser(req.racingUser.id).find(t => t.team_id === teamId);
  if (!membership) return res.redirect('/racing/pitwall');
  const members = db.getTeamMembers(teamId);
  res.render('racing-pitwall', {
    streamer: req.streamer || null,
    racingUser: req.racingUser,
    team: membership,
    members,
  });
});

// Notification actions
router.post('/notifications/:id/dismiss', (req, res) => {
  db.dismissNotification(parseInt(req.params.id), req.racingUser.id);
  if (req.is('json') || req.xhr) return res.json({ ok: true });
  res.redirect('back');
});

router.post('/notifications/dismiss-all', (req, res) => {
  db.dismissAllNotifications(req.racingUser.id);
  if (req.is('json') || req.xhr) return res.json({ ok: true });
  res.redirect('back');
});

router.post('/notifications/:id/read', (req, res) => {
  db.markNotificationRead(parseInt(req.params.id), req.racingUser.id);
  res.json({ ok: true });
});

// Admin — Racing accounts + Bridge users
router.get('/admin', (req, res) => {
  if (!res.locals.isAdmin) return res.redirect('/racing');
  const racingUsers = db.getAllRacingUsers();
  const bridgeUsers = db.getBridgeUserStats();
  const suspicious = db.getSuspiciousActivity(24);
  const authLog = db.getRecentAuthLog(30);
  res.render('racing-admin', { streamer: req.streamer || null, racingUser: req.racingUser, racingUsers, bridgeUsers, suspicious, authLog, msg: req.query.msg || null, error: req.query.error || null });
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

// Admin — Generate password reset link
router.post('/admin/reset-password/:id', (req, res) => {
  if (!res.locals.isAdmin) return res.redirect('/racing');
  const userId = parseInt(req.params.id);
  const user = db.getRacingUserById(userId);
  if (!user) return res.redirect('/racing/admin');
  const crypto = require('crypto');
  const config = require('../config');
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
  db.db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(userId, token, expiresAt);
  const resetUrl = config.app.url + '/racing/auth/reset?token=' + token;
  res.send(`
    <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Reset Link</title>
    <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'DM Sans',sans-serif;background:#0c0d14;color:#e8e6f0;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{background:#141520;border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:32px;max-width:500px;width:100%;text-align:center}
    h2{font-size:20px;margin-bottom:12px}p{color:#8b8a9e;font-size:13px;margin-bottom:16px}
    .url{background:#1a1b2e;border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:12px;font-size:12px;word-break:break-all;color:#3ecf8e;margin-bottom:16px;user-select:all;cursor:text}
    a{color:#9146ff;font-size:13px}</style></head><body>
    <div class="card">
      <h2>Password Reset Link</h2>
      <p>Send this link to <strong>${user.username}</strong>. It expires in 24 hours.</p>
      <div class="url">${resetUrl}</div>
      <button onclick="navigator.clipboard.writeText('${resetUrl}');this.textContent='Copied!'" style="padding:8px 20px;background:#3ecf8e;color:#000;font-weight:700;border:none;border-radius:8px;cursor:pointer;font-size:13px;margin-bottom:16px;">Copy Link</button>
      <br><a href="/racing/admin">Back to Admin</a>
    </div></body></html>
  `);
});

// Admin — Announcements & Bridge updates
router.post('/admin/announcement', express.urlencoded({ extended: true }), (req, res) => {
  if (!res.locals.isAdmin) return res.redirect('/racing');
  const title = (req.body.title || '').trim();
  const message = (req.body.message || '').trim();
  const link = (req.body.link || '').trim() || null;
  if (!title || !message) return res.redirect('/racing/admin?error=' + encodeURIComponent('Title and message required'));
  const count = db.createNotificationForAllUsers('announcement', title, message, link);
  res.redirect('/racing/admin?msg=' + encodeURIComponent('Announcement sent to ' + count + ' users'));
});

router.post('/admin/bridge-update', express.urlencoded({ extended: true }), (req, res) => {
  if (!res.locals.isAdmin) return res.redirect('/racing');
  const version = (req.body.version || '').trim();
  if (!version) return res.redirect('/racing/admin?error=' + encodeURIComponent('Version required'));
  const message = (req.body.message || '').trim() || 'Atleta Bridge v' + version + ' is available — update in the app';
  const count = db.createNotificationForBridgeUsers('bridge_update', 'Bridge update', message, null);
  res.redirect('/racing/admin?msg=' + encodeURIComponent('Bridge update notification sent to ' + count + ' users'));
});

// Update profile
router.post('/account/profile', express.urlencoded({ extended: true }), (req, res) => {
  const displayName = (req.body.display_name || '').trim().slice(0, 32);
  const iracingName = (req.body.iracing_name || '').trim().slice(0, 64);
  const email = (req.body.email || '').trim().slice(0, 120);
  db.updateRacingProfile(req.racingUser.id, displayName || null, iracingName || null);
  try { db.db.prepare('UPDATE racing_users SET email = ? WHERE id = ?').run(email || null, req.racingUser.id); } catch(e) {}
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
