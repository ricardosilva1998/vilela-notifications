const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const db = require('../db');
const config = require('../config');
const router = express.Router();

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c]);

// Email transporter (lazy init)
let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  if (!config.email.user || !config.email.pass) return null;
  _transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: config.email.user, pass: config.email.pass },
  });
  return _transporter;
}

// POST /racing/auth/signup
router.post('/signup', express.json(), express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const username = req.body.username;
    const password = req.body.password;
    const iracing_name = req.body.iracing_name;
    const bridge_id = req.body.bridge_id;

    if (!username || !password) {
      if (req.is('json')) return res.status(400).json({ error: 'Username and password required' });
      return res.redirect('/racing/signup?error=' + encodeURIComponent('Username and password required'));
    }
    if (username.length < 3 || username.length > 30) {
      if (req.is('json')) return res.status(400).json({ error: 'Username must be 3-30 characters' });
      return res.redirect('/racing/signup?error=' + encodeURIComponent('Username must be 3-30 characters'));
    }
    if (password.length < 8) {
      if (req.is('json')) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      return res.redirect('/racing/signup?error=' + encodeURIComponent('Password must be at least 8 characters'));
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
      if (req.is('json')) return res.status(400).json({ error: 'Username can only contain letters, numbers, dots, dashes, underscores' });
      return res.redirect('/racing/signup?error=' + encodeURIComponent('Username can only contain letters, numbers, dots, dashes, underscores'));
    }

    const existing = db.getRacingUserByUsername(username);
    if (existing) {
      db.logAuthAttempt('signup', username, req.ip, false, 'username_taken', req.headers['user-agent']);
      if (req.is('json')) return res.status(400).json({ error: 'Could not create account. Please try a different username.' });
      return res.redirect('/racing/signup?error=' + encodeURIComponent('Could not create account. Please try a different username.'));
    }

    const email = req.body.email;
    const passwordHash = await bcrypt.hash(password, 10);
    const result = db.createRacingUser(username, passwordHash, iracing_name || null, bridge_id || null);
    const userId = result.lastInsertRowid;
    if (email) {
      try { db.db.prepare('UPDATE racing_users SET email = ? WHERE id = ?').run(email.trim(), userId); } catch(e) {}
    }

    const sid = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    db.createRacingSession(sid, userId, expiresAt);
    req.app.locals.secureCookie(res, 'session', sid, { maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' });

    db.logAuthAttempt('signup', username, req.ip, true, null, req.headers['user-agent']);
    if (req.is('json')) return res.json({ ok: true, id: userId, username });
    res.redirect('/racing');
  } catch(e) {
    console.error('[Racing Signup]', e.message);
    if (req.is('json')) return res.status(500).json({ error: 'Signup failed' });
    res.redirect('/racing/signup?error=' + encodeURIComponent('Signup failed'));
  }
});

// POST /racing/auth/login
router.post('/login', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.redirect('/racing?error=' + encodeURIComponent('Username and password required'));
    }

    const user = db.getRacingUserByUsername(username);
    if (!user) {
      db.logAuthAttempt('login', username, req.ip, false, 'user_not_found', req.headers['user-agent']);
      return res.redirect('/racing?error=' + encodeURIComponent('Invalid username or password'));
    }

    if (db.isAccountLocked(user)) {
      db.logAuthAttempt('login', username, req.ip, false, 'account_locked', req.headers['user-agent']);
      const minsLeft = Math.ceil((user.locked_until - Date.now()) / 60000);
      return res.redirect('/racing?error=' + encodeURIComponent(`Account locked. Try again in ${minsLeft} minute${minsLeft === 1 ? '' : 's'}`));
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      db.recordFailedLogin(user.id);
      db.logAuthAttempt('login', username, req.ip, false, 'wrong_password', req.headers['user-agent']);
      return res.redirect('/racing?error=' + encodeURIComponent('Invalid username or password'));
    }

    db.resetLoginAttempts(user.id);
    db.logAuthAttempt('login', username, req.ip, true, null, req.headers['user-agent']);
    const sid = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;

    if (user.streamer_id) {
      db.createLinkedSession(sid, user.streamer_id, user.id, expiresAt);
    } else {
      db.createRacingSession(sid, user.id, expiresAt);
    }

    req.app.locals.secureCookie(res, 'session', sid, { maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' });
    res.redirect('/racing');
  } catch(e) {
    console.error('[Racing Login]', e.message);
    res.redirect('/racing?error=' + encodeURIComponent('Login failed'));
  }
});

// POST /racing/auth/login-api — JSON login for Bridge app
router.post('/login-api', express.json(), async (req, res) => {
  try {
    const { username, password, bridge_id } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const user = db.getRacingUserByUsername(username);
    if (!user) {
      db.logAuthAttempt('login-api', username, req.ip, false, 'user_not_found', req.headers['user-agent']);
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (db.isAccountLocked(user)) {
      db.logAuthAttempt('login-api', username, req.ip, false, 'account_locked', req.headers['user-agent']);
      const minsLeft = Math.ceil((user.locked_until - Date.now()) / 60000);
      return res.status(429).json({ error: `Account locked. Try again in ${minsLeft} minute${minsLeft === 1 ? '' : 's'}` });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      db.recordFailedLogin(user.id);
      db.logAuthAttempt('login-api', username, req.ip, false, 'wrong_password', req.headers['user-agent']);
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    db.resetLoginAttempts(user.id);
    db.logAuthAttempt('login-api', username, req.ip, true, null, req.headers['user-agent']);
    // Link bridge_id if provided and not already linked
    if (bridge_id && !user.bridge_id) {
      try { db.db.prepare('UPDATE racing_users SET bridge_id = ? WHERE id = ?').run(bridge_id, user.id); } catch(e) {}
    }

    // Generate pitwall token for WebSocket auth (avoids storing password)
    let pitwallToken = user.pitwall_token;
    if (!pitwallToken) {
      pitwallToken = crypto.randomBytes(32).toString('hex');
      try { db.db.prepare('UPDATE racing_users SET pitwall_token = ? WHERE id = ?').run(pitwallToken, user.id); } catch(e) {}
    }

    res.json({ ok: true, id: user.id, username: user.username, pitwallToken });
  } catch(e) {
    console.error('[Racing Login API]', e.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /racing/auth/logout
router.get('/logout', (req, res) => {
  const sid = req.cookies?.session;
  if (sid) {
    try { db.deleteSession(sid); } catch(e) {}
  }
  res.clearCookie('session');
  res.redirect('/racing');
});

// GET /racing/auth/forgot — show forgot password form
router.get('/forgot', (req, res) => {
  const message = escapeHtml(req.query.message || '');
  const error = escapeHtml(req.query.error || '');
  res.send(`
    <!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>Reset Password — Atleta Racing</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
    <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'DM Sans',sans-serif;background:#0c0d14;color:#e8e6f0;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{background:#141520;border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:32px;max-width:380px;width:100%}
    h2{font-family:'Outfit',sans-serif;font-size:22px;font-weight:700;margin-bottom:8px}
    p{color:#8b8a9e;font-size:13px;margin-bottom:20px}
    label{font-size:12px;color:#8b8a9e;margin-bottom:4px;display:block}
    input{width:100%;padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);background:#1a1b2e;color:#e8e6f0;font-size:14px;margin-bottom:12px}
    button{width:100%;padding:10px;background:#3ecf8e;color:#000;font-weight:700;border:none;border-radius:8px;cursor:pointer;font-size:14px}
    .msg{padding:10px 16px;border-radius:8px;font-size:13px;margin-bottom:16px}
    .msg.ok{color:#3ecf8e;background:rgba(62,207,142,0.1)}.msg.err{color:#f04438;background:rgba(240,68,56,0.1)}
    a{color:#3ecf8e;font-size:13px}</style></head><body>
    <div class="card">
      <h2>Reset Password</h2>
      <p>Enter your username and the email address on your account. We'll send you a recovery link.</p>
      ${message ? '<div class="msg ok">' + message + '</div>' : ''}
      ${error ? '<div class="msg err">' + error + '</div>' : ''}
      <form method="POST" action="/racing/auth/forgot">
        <label>Username</label><input name="username" type="text" required>
        <label>Email</label><input name="email" type="email" required>
        <button type="submit">Send Recovery Link</button>
      </form>
      <p style="margin-top:16px;"><a href="/racing">Back to login</a></p>
    </div></body></html>
  `);
});

// POST /racing/auth/forgot — send recovery email
router.post('/forgot', express.urlencoded({ extended: true }), async (req, res) => {
  const { username, email } = req.body;
  const genericMsg = 'If an account with that username and email exists, a recovery link has been sent.';

  if (!username || !email) {
    return res.redirect('/racing/auth/forgot?error=' + encodeURIComponent('Username and email required'));
  }

  const transporter = getTransporter();
  if (!transporter) {
    return res.redirect('/racing/auth/forgot?error=' + encodeURIComponent('Email service not configured. Contact an admin.'));
  }

  const user = db.getRacingUserByUsername(username);
  if (!user || !user.email || user.email.toLowerCase() !== email.toLowerCase()) {
    // Don't reveal whether user exists
    return res.redirect('/racing/auth/forgot?message=' + encodeURIComponent(genericMsg));
  }

  // Generate token (1 hour expiry)
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 60 * 60 * 1000;
  db.db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, token, expiresAt);

  const resetUrl = config.app.url + '/racing/auth/reset?token=' + token;

  try {
    await transporter.sendMail({
      from: config.email.from,
      to: user.email,
      subject: 'Atleta Racing — Password Reset',
      html: '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#141520;border-radius:12px;color:#e8e6f0;">' +
        '<h2 style="margin:0 0 12px;color:#e8e6f0;">Password Reset</h2>' +
        '<p style="color:#8b8a9e;font-size:14px;">Hi <strong>' + user.username + '</strong>, click the link below to reset your password. This link expires in 1 hour.</p>' +
        '<a href="' + resetUrl + '" style="display:inline-block;margin:16px 0;padding:12px 24px;background:#3ecf8e;color:#000;font-weight:700;text-decoration:none;border-radius:8px;">Reset Password</a>' +
        '<p style="color:#5c5b6e;font-size:12px;">If you didn\'t request this, you can ignore this email.</p></div>',
    });
  } catch(e) {
    console.error('[Password Reset] Email error:', e.message);
    return res.redirect('/racing/auth/forgot?error=' + encodeURIComponent('Failed to send email. Try again later.'));
  }

  res.redirect('/racing/auth/forgot?message=' + encodeURIComponent(genericMsg));
});

// GET /racing/auth/reset — show reset password form
router.get('/reset', (req, res) => {
  const token = req.query.token || '';
  const error = escapeHtml(req.query.error || '');

  // Token must look like a hex token before we even hit the DB; this also
  // closes the XSS hole from interpolating it into the form below.
  if (!token || !/^[a-f0-9]{32,128}$/.test(token)) {
    return res.redirect('/racing/auth/forgot?error=' + encodeURIComponent('Invalid reset link'));
  }

  const row = db.db.prepare('SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > ?').get(token, Date.now());
  if (!row) return res.redirect('/racing/auth/forgot?error=' + encodeURIComponent('Reset link expired or already used'));

  res.send(`
    <!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>New Password — Atleta Racing</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
    <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'DM Sans',sans-serif;background:#0c0d14;color:#e8e6f0;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{background:#141520;border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:32px;max-width:380px;width:100%}
    h2{font-family:'Outfit',sans-serif;font-size:22px;font-weight:700;margin-bottom:8px}
    p{color:#8b8a9e;font-size:13px;margin-bottom:20px}
    label{font-size:12px;color:#8b8a9e;margin-bottom:4px;display:block}
    input{width:100%;padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);background:#1a1b2e;color:#e8e6f0;font-size:14px;margin-bottom:12px}
    button{width:100%;padding:10px;background:#3ecf8e;color:#000;font-weight:700;border:none;border-radius:8px;cursor:pointer;font-size:14px}
    .msg.err{color:#f04438;background:rgba(240,68,56,0.1);padding:10px 16px;border-radius:8px;font-size:13px;margin-bottom:16px}</style></head><body>
    <div class="card">
      <h2>Set New Password</h2>
      <p>Choose a new password for your account.</p>
      ${error ? '<div class="msg err">' + error + '</div>' : ''}
      <form method="POST" action="/racing/auth/reset">
        <input type="hidden" name="token" value="${token}">
        <label>New Password</label><input name="password" type="password" required minlength="8" placeholder="Minimum 8 characters">
        <label>Confirm Password</label><input name="confirm" type="password" required minlength="8">
        <button type="submit">Reset Password</button>
      </form>
    </div></body></html>
  `);
});

// POST /racing/auth/reset — apply new password
router.post('/reset', express.urlencoded({ extended: true }), async (req, res) => {
  const { token, password, confirm } = req.body;

  if (!token) return res.redirect('/racing/auth/forgot?error=' + encodeURIComponent('Invalid reset link'));
  if (!password || password.length < 8) return res.redirect('/racing/auth/reset?token=' + token + '&error=' + encodeURIComponent('Password must be at least 8 characters'));
  if (password !== confirm) return res.redirect('/racing/auth/reset?token=' + token + '&error=' + encodeURIComponent('Passwords do not match'));

  const row = db.db.prepare('SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > ?').get(token, Date.now());
  if (!row) return res.redirect('/racing/auth/forgot?error=' + encodeURIComponent('Reset link expired or already used'));

  const hash = await bcrypt.hash(password, 10);
  db.db.prepare('UPDATE racing_users SET password_hash = ? WHERE id = ?').run(hash, row.user_id);
  db.db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(row.id);

  res.redirect('/racing?error=' + encodeURIComponent('Password reset successful. Please login with your new password.'));
});

module.exports = router;
