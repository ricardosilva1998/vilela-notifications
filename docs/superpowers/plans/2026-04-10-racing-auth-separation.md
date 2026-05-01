# Racing Auth Separation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate Racing features from Streamer so Racing users can sign up with username/password without needing Discord. Existing Bridge users auto-migrate. Accounts optionally linkable.

**Architecture:** New `racing_users` table with bcrypt passwords. Extend existing session table with `racing_user_id` column. Session middleware loads both `req.streamer` (Discord) and `req.racingUser` (Racing), cross-loading linked accounts. New `/racing/*` routes with Racing-specific auth middleware. Shared header.ejs sidebar shows product sections based on which accounts exist. Bridge control panel gets account creation UI.

**Tech Stack:** bcryptjs, Express, SQLite, EJS (existing stack)

**Spec:** `docs/superpowers/specs/2026-04-10-racing-auth-separation-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `package.json` | Modify | Add `bcryptjs` dependency |
| `src/db.js` | Modify | `racing_users` table + session column + query functions |
| `src/routes/racing-auth.js` | Create | Signup, login, logout, account linking routes |
| `src/routes/racing.js` | Create | Racing dashboard, sessions, account settings routes |
| `src/server.js` | Modify | Extended session middleware, mount Racing routes, homepage logic |
| `src/views/header.ejs` | Modify | Dual-product sidebar sections |
| `src/views/login.ejs` | Modify | Remove login buttons, cards link to product pages |
| `src/views/streamer-landing.ejs` | Create | Streamer product landing with Discord login |
| `src/views/racing-landing.ejs` | Create | Racing landing with login/signup forms |
| `src/views/racing-signup.ejs` | Create | Signup form page |
| `src/views/racing-dashboard.ejs` | Create | Racing home dashboard |
| `src/views/racing-account.ejs` | Create | Account settings + password change + linking |
| `bridge/control-panel.html` | Modify | Account section for signup/status |

---

### Task 1: Add bcryptjs dependency + DB migration

**Files:**
- Modify: `package.json` (root, not bridge)
- Modify: `src/db.js`

- [ ] **Step 1: Install bcryptjs**

```bash
npm install bcryptjs --save
```

- [ ] **Step 2: Add racing_users table and session column to src/db.js**

After the session capture tables (racing_sessions, session_laps, lap_telemetry), add:

```js
// ── Racing users (standalone auth, no Discord required) ─────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS racing_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    iracing_name TEXT,
    bridge_id TEXT,
    streamer_id INTEGER,
    created_at DATETIME DEFAULT (datetime('now'))
  )
`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_racing_users_bridge ON racing_users(bridge_id)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_racing_users_streamer ON racing_users(streamer_id)'); } catch(e) {}
```

Add session column migration:

```js
try { db.exec('ALTER TABLE sessions ADD COLUMN racing_user_id INTEGER'); } catch(e) {}
```

- [ ] **Step 3: Add query functions for racing_users**

Before `module.exports`, add:

```js
// ── Racing users queries ────────────────────────────────────────────
const _insertRacingUser = db.prepare(`INSERT INTO racing_users (username, password_hash, iracing_name, bridge_id) VALUES (@username, @password_hash, @iracing_name, @bridge_id)`);
const _getRacingUserByUsername = db.prepare(`SELECT * FROM racing_users WHERE username = @username COLLATE NOCASE`);
const _getRacingUserById = db.prepare(`SELECT * FROM racing_users WHERE id = @id`);
const _getRacingUserByBridgeId = db.prepare(`SELECT * FROM racing_users WHERE bridge_id = @bridge_id`);
const _getRacingUserByStreamerId = db.prepare(`SELECT * FROM racing_users WHERE streamer_id = @streamer_id`);
const _linkRacingUserToStreamer = db.prepare(`UPDATE racing_users SET streamer_id = @streamer_id WHERE id = @id`);
const _updateRacingPassword = db.prepare(`UPDATE racing_users SET password_hash = @password_hash WHERE id = @id`);
const _updateRacingIracingName = db.prepare(`UPDATE racing_users SET iracing_name = @iracing_name WHERE id = @id`);

// Extended session creation for racing users
const _createRacingSession = db.prepare(`INSERT INTO sessions (sid, racing_user_id, expires_at) VALUES (?, ?, ?)`);
const _createLinkedSession = db.prepare(`INSERT INTO sessions (sid, streamer_id, racing_user_id, expires_at) VALUES (?, ?, ?, ?)`);

function createRacingUser(username, passwordHash, iracingName, bridgeId) {
  return _insertRacingUser.run({ username, password_hash: passwordHash, iracing_name: iracingName || null, bridge_id: bridgeId || null });
}
function getRacingUserByUsername(username) { return _getRacingUserByUsername.get({ username }); }
function getRacingUserById(id) { return _getRacingUserById.get({ id }); }
function getRacingUserByBridgeId(bridgeId) { return _getRacingUserByBridgeId.get({ bridge_id: bridgeId }); }
function getRacingUserByStreamerId(streamerId) { return _getRacingUserByStreamerId.get({ streamer_id: streamerId }); }
function linkRacingUserToStreamer(racingUserId, streamerId) { return _linkRacingUserToStreamer.run({ id: racingUserId, streamer_id: streamerId }); }
function updateRacingPassword(id, passwordHash) { return _updateRacingPassword.run({ id, password_hash: passwordHash }); }
function updateRacingIracingName(id, iracingName) { return _updateRacingIracingName.run({ id, iracing_name: iracingName }); }
function createRacingSession(sid, racingUserId, expiresAt) { return _createRacingSession.run(sid, racingUserId, expiresAt); }
function createLinkedSession(sid, streamerId, racingUserId, expiresAt) { return _createLinkedSession.run(sid, streamerId, racingUserId, expiresAt); }
```

Export all new functions in `module.exports`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/db.js
git commit -m "feat: add racing_users table + bcryptjs for standalone Racing auth"
```

---

### Task 2: Racing auth routes (signup, login, logout)

**Files:**
- Create: `src/routes/racing-auth.js`

- [ ] **Step 1: Create the Racing auth router**

```js
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const router = express.Router();

// POST /racing/auth/signup
router.post('/signup', express.json(), async (req, res) => {
  try {
    const { username, password, iracing_name, bridge_id } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (username.length < 3 || username.length > 30) return res.status(400).json({ error: 'Username must be 3-30 characters' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return res.status(400).json({ error: 'Username can only contain letters, numbers, dots, dashes, underscores' });

    const existing = db.getRacingUserByUsername(username);
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    const passwordHash = await bcrypt.hash(password, 10);
    const result = db.createRacingUser(username, passwordHash, iracing_name || null, bridge_id || null);
    const userId = result.lastInsertRowid;

    // Create session
    const sid = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    db.createRacingSession(sid, userId, expiresAt);
    res.cookie('session', sid, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' });

    // If called from Bridge (JSON), return JSON. If form, redirect.
    if (req.headers['content-type']?.includes('application/json')) {
      return res.json({ ok: true, id: userId, username });
    }
    res.redirect('/racing/dashboard');
  } catch(e) {
    console.error('[Racing Signup]', e.message);
    if (req.headers['content-type']?.includes('application/json')) {
      return res.status(500).json({ error: 'Signup failed' });
    }
    res.redirect('/racing?error=' + encodeURIComponent(e.message));
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

    // If user has a linked streamer account, create a linked session
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
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/racing-auth.js
git commit -m "feat: add Racing auth routes (signup, login, logout)"
```

---

### Task 3: Session middleware extension

**Files:**
- Modify: `src/server.js` (session middleware at lines 48-69)

- [ ] **Step 1: Extend session middleware to load Racing users**

Replace the session middleware block (lines 48-69) with:

```js
// Session middleware — attach streamer AND/OR racingUser to request
app.use((req, res, next) => {
  const sid = req.cookies?.session;
  if (sid) {
    const session = db.getSession(sid);
    if (session) {
      if (session.streamer_id) {
        req.streamer = db.getStreamerById(session.streamer_id);
      }
      if (session.racing_user_id) {
        req.racingUser = db.getRacingUserById(session.racing_user_id);
      }
    }
  }

  // Cross-load linked accounts
  if (req.streamer && !req.racingUser) {
    const linked = db.getRacingUserByStreamerId(req.streamer.id);
    if (linked) req.racingUser = linked;
  }
  if (req.racingUser && req.racingUser.streamer_id && !req.streamer) {
    req.streamer = db.getStreamerById(req.racingUser.streamer_id);
  }

  res.locals.streamer = req.streamer || null;
  res.locals.racingUser = req.racingUser || null;
  res.locals.streamerTier = req.streamer ? db.getStreamerTier(req.streamer.id) : 'free';
  res.locals.isAdmin = req.streamer ? db.isAdmin(req.streamer.id) : false;
  res.locals.features = config.features;

  // i18n
  const lang = SUPPORTED_LANGS.includes(req.cookies?.lang) ? req.cookies.lang : 'en';
  req.lang = lang;
  res.locals.lang = lang;
  res.locals.SUPPORTED_LANGS = SUPPORTED_LANGS;
  res.locals.t = (key, params) => t(lang, key, params);

  next();
});
```

- [ ] **Step 2: Update homepage route to handle both auth types**

Replace the `GET /` route (line ~72):

```js
app.get('/', (req, res) => {
  if (req.streamer && req.racingUser) return res.redirect('/dashboard');
  if (req.streamer) return res.redirect('/dashboard');
  if (req.racingUser) return res.redirect('/racing/dashboard');
  res.render('login', { streamer: null, racingUser: null });
});
```

- [ ] **Step 3: Mount Racing routes**

After the existing route mounts (~line 94-98), add:

```js
const racingAuthRoutes = require('./routes/racing-auth');
const racingRoutes = require('./routes/racing');
app.use('/racing/auth', racingAuthRoutes);
app.use('/racing', racingRoutes);
```

Add the streamer landing route:

```js
app.get('/streamer', (req, res) => {
  if (req.streamer) return res.redirect('/dashboard');
  res.render('streamer-landing', { streamer: null, racingUser: null });
});
```

- [ ] **Step 4: Commit**

```bash
git add src/server.js
git commit -m "feat: extend session middleware for dual auth, mount Racing routes"
```

---

### Task 4: Racing landing page + signup page

**Files:**
- Create: `src/views/racing-landing.ejs`
- Create: `src/views/racing-signup.ejs`

- [ ] **Step 1: Create Racing landing page**

`src/views/racing-landing.ejs` — Racing product landing with login form. Includes `header.ejs` with `streamer: null`. Shows feature highlights, login form (username + password), link to signup, and Bridge download button. Shows `error` query param as a red alert if present.

Follow the existing dark theme from `header.ejs`. Use the green accent (`#3ecf8e`) for Racing branding. Login form POSTs to `/racing/auth/login`.

- [ ] **Step 2: Create Racing signup page**

`src/views/racing-signup.ejs` — Signup form with fields: username, password, confirm password, iRacing name (optional). POSTs to `/racing/auth/signup` as form (not JSON). Shows validation errors from query params.

- [ ] **Step 3: Commit**

```bash
git add src/views/racing-landing.ejs src/views/racing-signup.ejs
git commit -m "feat: add Racing landing and signup pages"
```

---

### Task 5: Racing dashboard + account pages + routes

**Files:**
- Create: `src/views/racing-dashboard.ejs`
- Create: `src/views/racing-account.ejs`
- Create: `src/routes/racing.js`

- [ ] **Step 1: Create Racing router with auth middleware**

```js
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const router = express.Router();

// Racing landing (public)
router.get('/', (req, res) => {
  if (req.racingUser) return res.redirect('/racing/dashboard');
  res.render('racing-landing', { streamer: req.streamer || null, racingUser: null, error: req.query.error || null });
});

router.get('/signup', (req, res) => {
  res.render('racing-signup', { streamer: req.streamer || null, racingUser: null, error: req.query.error || null });
});

// Auth wall — everything below requires Racing login
router.use((req, res, next) => {
  if (!req.racingUser) return res.redirect('/racing');
  next();
});

router.get('/dashboard', (req, res) => {
  res.render('racing-dashboard', { streamer: req.streamer || null, racingUser: req.racingUser });
});

router.get('/account', (req, res) => {
  res.render('racing-account', { streamer: req.streamer || null, racingUser: req.racingUser, msg: req.query.msg || null, error: req.query.error || null });
});

// Change password
router.post('/account/password', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { current_password, new_password, confirm_password } = req.body;
    if (!current_password || !new_password) return res.redirect('/racing/account?error=All fields required');
    if (new_password !== confirm_password) return res.redirect('/racing/account?error=Passwords do not match');
    if (new_password.length < 6) return res.redirect('/racing/account?error=Password must be at least 6 characters');

    const valid = await bcrypt.compare(current_password, req.racingUser.password_hash);
    if (!valid) return res.redirect('/racing/account?error=Current password is incorrect');

    const hash = await bcrypt.hash(new_password, 10);
    db.updateRacingPassword(req.racingUser.id, hash);
    res.redirect('/racing/account?msg=Password updated');
  } catch(e) {
    res.redirect('/racing/account?error=Failed to update password');
  }
});

module.exports = router;
```

- [ ] **Step 2: Create Racing dashboard view**

`src/views/racing-dashboard.ejs` — Welcome page showing: username, iRacing name, quick links to Track Database and My Sessions, Bridge download section. Follow existing card/grid patterns from `dashboard.ejs`.

- [ ] **Step 3: Create Racing account view**

`src/views/racing-account.ejs` — Account settings: username (read-only), iRacing name (editable), password change form, "Link Discord" button (if not linked, links to `/auth/login?link_racing=1`), linked status display. Show success/error messages from query params.

- [ ] **Step 4: Commit**

```bash
git add src/routes/racing.js src/views/racing-dashboard.ejs src/views/racing-account.ejs
git commit -m "feat: add Racing dashboard, account pages, and routes"
```

---

### Task 6: Streamer landing page

**Files:**
- Create: `src/views/streamer-landing.ejs`

- [ ] **Step 1: Create Streamer landing page**

`src/views/streamer-landing.ejs` — Streamer product landing with Discord login button. Shows streaming feature highlights (alerts, chatbot, overlays, donations, etc.) and a prominent "Login with Discord" button linking to `/auth/login`. Purple accent theme. Follow same layout as Racing landing but with streaming content.

- [ ] **Step 2: Commit**

```bash
git add src/views/streamer-landing.ejs
git commit -m "feat: add Streamer landing page"
```

---

### Task 7: Homepage + sidebar changes

**Files:**
- Modify: `src/views/login.ejs`
- Modify: `src/views/header.ejs`

- [ ] **Step 1: Update homepage to remove login buttons**

In `login.ejs`, update the Streamer card to link to `/streamer` and the Racing card to link to `/racing`. Remove the Discord login button at the bottom. Keep the "How It Works" button.

- [ ] **Step 2: Update sidebar for dual-product support**

In `header.ejs`, update the sidebar navigation section (~line 582-605) to show sections based on both `streamer` and `racingUser`:

```ejs
<div class="sidebar-nav">
  <div class="sidebar-section"><%= t('nav.navigation') %></div>

  <% if (typeof racingUser !== 'undefined' && racingUser) { %>
    <a href="/racing/dashboard" class="sidebar-link">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2c4 4 6 8 6 14H6c0-6 2-10 6-14z"/><path d="M8 16h8"/><line x1="12" y1="2" x2="12" y2="8"/></svg>
      Racing
    </a>
    <a href="/tracks" class="sidebar-link">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
      Track Database
    </a>
    <a href="/racing/account" class="sidebar-link">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      Account
    </a>
  <% } %>

  <% if (typeof streamer !== 'undefined' && streamer) { %>
    <% if (typeof racingUser !== 'undefined' && racingUser) { %>
      <div class="sidebar-divider"></div>
    <% } %>
    <a href="/dashboard" class="sidebar-link">
      <svg viewBox="0 0 24 24"><path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>
      Streamer
    </a>
    <!-- existing streamer-only links here -->
  <% } %>

  <a href="/tutorial" class="sidebar-link">
    <!-- existing tutorial link -->
  </a>
  <!-- rest of existing nav -->
</div>
```

Also update the user display in top nav to handle Racing users (show username if no Discord avatar).

- [ ] **Step 3: Commit**

```bash
git add src/views/login.ejs src/views/header.ejs
git commit -m "feat: homepage two-card layout + dual-product sidebar"
```

---

### Task 8: Account linking (Racing ↔ Discord)

**Files:**
- Modify: `src/routes/auth.js` (Discord callback to handle linking)
- Modify: `src/routes/racing.js` (link endpoint)
- Modify: `src/db.js` (if needed for session updates)

- [ ] **Step 1: Discord OAuth linking for Racing users**

In `src/routes/auth.js`, modify the `/auth/login/callback` to detect when a Racing user is linking Discord. Check if the `link_racing` query param was passed or if `req.racingUser` already exists. After Discord auth succeeds, link the accounts:

```js
// After successful Discord auth and streamer upsert:
if (req.racingUser) {
  // Racing user is linking their Discord account
  db.linkRacingUserToStreamer(req.racingUser.id, streamer.id);
  // Create linked session
  const sid = crypto.randomBytes(32).toString('hex');
  db.createLinkedSession(sid, streamer.id, req.racingUser.id, expiresAt);
  // ... set cookie, redirect
}
```

- [ ] **Step 2: Racing account page link button**

The Racing account page should have a "Link Discord Account" button that goes to `/auth/login?link_racing=1`. The auth callback detects this param and links after successful Discord auth.

- [ ] **Step 3: Commit**

```bash
git add src/routes/auth.js src/routes/racing.js
git commit -m "feat: account linking between Racing and Discord"
```

---

### Task 9: Move /tracks to Racing-accessible

**Files:**
- Modify: `src/server.js`

- [ ] **Step 1: Make /tracks accessible to Racing users**

Currently `/tracks` is only accessible to logged-in streamers. Update the route to allow Racing users too. The tracks route should check for either `req.streamer` or `req.racingUser`:

```js
app.get('/tracks', (req, res) => {
  if (!req.streamer && !req.racingUser) return res.redirect('/racing');
  res.render('tracks', { streamer: req.streamer || null, racingUser: req.racingUser || null });
});
```

Do the same for `/tracks/:trackName` if it exists as a separate route.

- [ ] **Step 2: Commit**

```bash
git add src/server.js
git commit -m "feat: make /tracks accessible to Racing users"
```

---

### Task 10: Bridge control panel — Account section

**Files:**
- Modify: `bridge/control-panel.html`

- [ ] **Step 1: Add Account section to Bridge sidebar**

In `bridge/control-panel.html`, add an "Account" tab in the sidebar (above Updates). When clicked, shows:
- If no account: signup form (username, password, confirm password) with "Create Account" button
- If account exists: shows username, iRacing name, account status

The signup form POSTs to `https://atletanotifications.com/racing/auth/signup` as JSON with `{ username, password, iracing_name, bridge_id }`.

On success, stores `racingUsername` and `racingUserId` in settings.

- [ ] **Step 2: Commit**

```bash
git add bridge/control-panel.html
git commit -m "feat: add Racing account section to Bridge control panel"
```

---

### Task 11: Session upload — associate with racing_user_id

**Files:**
- Modify: `src/server.js` (POST /api/session endpoint)

- [ ] **Step 1: Look up racing user from bridge_id on session upload**

In the `POST /api/session` endpoint, after extracting `bridge_id`, look up the Racing user:

```js
// After extracting bridge_id from req.body:
let racingUserId = null;
if (bridge_id) {
  const racingUser = db.getRacingUserByBridgeId(bridge_id);
  if (racingUser) racingUserId = racingUser.id;
}
```

Pass `racingUserId` into the session insert if desired (add column to `racing_sessions` table if needed), or use it for the `getSessionsByTrack` query to show user's own sessions.

- [ ] **Step 2: Commit**

```bash
git add src/server.js
git commit -m "feat: associate session uploads with Racing user via bridge_id"
```

---

## Verification

| Check | How |
|-------|-----|
| Homepage shows 2 cards, no login | Visit `/` logged out |
| Streamer card → `/streamer` with Discord login | Click Streamer card |
| Racing card → `/racing` with login form | Click Racing card |
| Racing signup works | Create account at `/racing/signup` |
| Racing login works | Log in at `/racing` |
| Racing sidebar shows Racing links | Check sidebar after Racing login |
| Streamer sidebar shows Streamer links | Check sidebar after Discord login |
| Account linking works | Racing account → Link Discord → OAuth flow |
| Linked account shows both sidebars | Check sidebar after linking |
| Bridge account creation | Open Bridge control panel → Account tab |
| `/tracks` accessible to Racing users | Navigate to Track Database |
| Session uploads link to Racing user | Upload session, check DB for racing_user association |
| Logout works for both | Logout from Racing and Streamer separately |
