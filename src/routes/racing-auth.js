const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const router = express.Router();

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

    const passwordHash = await bcrypt.hash(password, 10);
    const result = db.createRacingUser(username, passwordHash, iracing_name || null, bridge_id || null);
    const userId = result.lastInsertRowid;

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

    res.json({ ok: true, id: user.id, username: user.username });
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

module.exports = router;
