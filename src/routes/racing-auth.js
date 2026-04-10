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
    if (password.length < 6) {
      if (req.is('json')) return res.status(400).json({ error: 'Password must be at least 6 characters' });
      return res.redirect('/racing/signup?error=' + encodeURIComponent('Password must be at least 6 characters'));
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
      if (req.is('json')) return res.status(400).json({ error: 'Username can only contain letters, numbers, dots, dashes, underscores' });
      return res.redirect('/racing/signup?error=' + encodeURIComponent('Username can only contain letters, numbers, dots, dashes, underscores'));
    }

    const existing = db.getRacingUserByUsername(username);
    if (existing) {
      if (req.is('json')) return res.status(409).json({ error: 'Username already taken' });
      return res.redirect('/racing/signup?error=' + encodeURIComponent('Username already taken'));
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = db.createRacingUser(username, passwordHash, iracing_name || null, bridge_id || null);
    const userId = result.lastInsertRowid;

    const sid = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    db.createRacingSession(sid, userId, expiresAt);
    res.cookie('session', sid, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' });

    if (req.is('json')) return res.json({ ok: true, id: userId, username });
    res.redirect('/racing/dashboard');
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
    if (!user) return res.redirect('/racing?error=' + encodeURIComponent('Invalid username or password'));

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.redirect('/racing?error=' + encodeURIComponent('Invalid username or password'));

    const sid = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;

    if (user.streamer_id) {
      db.createLinkedSession(sid, user.streamer_id, user.id, expiresAt);
    } else {
      db.createRacingSession(sid, user.id, expiresAt);
    }

    res.cookie('session', sid, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' });
    res.redirect('/racing/dashboard');
  } catch(e) {
    console.error('[Racing Login]', e.message);
    res.redirect('/racing?error=' + encodeURIComponent('Login failed'));
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
