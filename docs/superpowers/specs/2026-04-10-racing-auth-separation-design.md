# Racing Auth Separation — Design Spec

## Context

Currently all features require Discord OAuth login. Racing users (iRacing Bridge) shouldn't need Discord — they just want telemetry overlays, track database, session history, and lap comparison. This spec separates Racing into its own product with standalone username/password auth, while keeping the shared layout and allowing account linking.

## Decisions

- **Racing auth:** Username + password (bcrypt hashed). No Discord required.
- **Existing Bridge users:** Auto-prompted on next Bridge launch to create a Racing account using their iRacing name as default username.
- **Homepage:** `/` shows two product cards (no login buttons). Each card links to its product landing page.
- **Product landings:** `/streamer` has Discord login. `/racing` has username/password login + signup.
- **Shared layout:** Same `header.ejs` sidebar and CSS. Sidebar shows different links based on which product(s) the user has access to.
- **Account linking:** Racing account can link to Discord (and vice versa). Linked accounts see both Streamer + Racing in one sidebar.

## 1. Database Schema

### `racing_users` table

```sql
CREATE TABLE IF NOT EXISTS racing_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  iracing_name TEXT,
  bridge_id TEXT,
  streamer_id INTEGER,                -- FK to streamers.id if linked to Discord account
  created_at DATETIME DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_racing_users_bridge ON racing_users(bridge_id);
CREATE INDEX IF NOT EXISTS idx_racing_users_streamer ON racing_users(streamer_id);
```

### Modify `sessions` table

The existing `sessions` table stores Discord auth sessions. Extend it to support Racing sessions:

```sql
ALTER TABLE sessions ADD COLUMN racing_user_id INTEGER;
```

A session has either `streamer_id` (Discord login) or `racing_user_id` (Racing login) or both (linked account).

## 2. Auth Flows

### Racing Signup

1. User visits `/racing` → sees landing page with login form + signup link
2. Clicks "Create Account" → `/racing/signup` page
3. Fills: username, password, confirm password, iRacing name (optional)
4. `POST /racing/auth/signup` → validates, hashes password (bcrypt), creates `racing_users` row
5. Auto-creates session with `racing_user_id`, sets cookie
6. Redirects to `/racing/dashboard`

### Racing Login

1. User visits `/racing` → login form
2. Enters username + password
3. `POST /racing/auth/login` → validates credentials, creates session
4. Redirects to `/racing/dashboard`

### Bridge Migration (Existing Users)

1. Bridge detects `settings.json` has `bridgeId` but no `racingUsername`
2. Shows prompt in control panel: "Create your Racing account" with fields: username (default: iRacing name), password
3. Bridge sends `POST /racing/auth/signup` with `{ username, password, iracing_name, bridge_id }`
4. Server creates account with `bridge_id` pre-linked
5. Bridge stores `racingUsername` in settings (to not prompt again)
6. All future session uploads include the `racing_user_id` via the `bridge_id` link

### Account Linking

**Racing → Discord:** On Racing account settings page, "Link Discord" button → standard Discord OAuth → on callback, sets `racing_users.streamer_id = streamer.id`

**Discord → Racing:** On Streamer account page, "Link Racing Account" → enter Racing username + password → verifies credentials → sets `racing_users.streamer_id = streamer.id`

When linked, the session middleware loads BOTH `req.streamer` and `req.racingUser`. Sidebar shows both product sections.

## 3. Session Middleware Changes

Current middleware (server.js ~line 48-68) loads `req.streamer` from Discord sessions. Extend to also load Racing users:

```js
// Existing: load streamer from session
if (session && session.streamer_id) {
  req.streamer = db.getStreamerById(session.streamer_id);
}

// New: load racing user from session
if (session && session.racing_user_id) {
  req.racingUser = db.getRacingUserById(session.racing_user_id);
}

// Cross-load linked accounts
if (req.streamer && !req.racingUser) {
  req.racingUser = db.getRacingUserByStreamerId(req.streamer.id);
}
if (req.racingUser && req.racingUser.streamer_id && !req.streamer) {
  req.streamer = db.getStreamerById(req.racingUser.streamer_id);
}

// Template locals
res.locals.racingUser = req.racingUser || null;
```

## 4. Route Structure

### Public routes (no auth)

```
GET  /                      — Homepage (two product cards)
GET  /streamer               — Streamer landing + Discord login button
GET  /racing                 — Racing landing + login/signup forms
POST /racing/auth/signup     — Create Racing account
POST /racing/auth/login      — Racing login
GET  /racing/auth/logout     — Racing logout
GET  /tutorial               — Setup guide
GET  /donate                 — Donation page
```

### Racing-protected routes (require `req.racingUser`)

```
GET  /racing/dashboard       — Racing home (Bridge download, quick stats)
GET  /tracks                 — Track database (move from streamer to racing)
GET  /tracks/:trackName      — Track detail page
GET  /racing/sessions        — All my sessions
GET  /racing/account         — Account settings, password change, linking
```

### Streamer-protected routes (require `req.streamer`, unchanged)

```
GET  /dashboard              — Streamer dashboard
GET  /dashboard/account      — Streamer account
GET  /dashboard/guild/:id    — Guild config
GET  /dashboard/iracing      — iRacing tab (Bridge users who logged in via Discord)
... all existing dashboard routes
```

### API routes

Session data APIs (`/api/session*`) change from `bridge_id` auth to `racing_user_id`:
- Upload: Bridge includes `racing_user_id` (looked up via `bridge_id` on server)
- Query: Uses `req.racingUser.id` instead of `bridge_id` query param

Track stats APIs remain public (Bridge uploads without auth).

## 5. Homepage Changes

`/` (`login.ejs`) — Already has two product cards from earlier change. Remove any login buttons. Cards link to:
- Streamer card → `/streamer`
- Racing card → `/racing`

If user is already logged in to either product, redirect to their dashboard instead of showing homepage.

## 6. Racing Landing Page (`/racing`)

New view: `src/views/racing-landing.ejs`

Layout:
- Hero section with Racing branding (green accent)
- Feature highlights (telemetry overlays, session history, track database, lap comparison)
- Login form (username + password) with "Login" button
- "Don't have an account? Sign up" link → `/racing/signup`
- "Download Bridge" button for new users

## 7. Sidebar Changes (`header.ejs`)

The sidebar currently shows links based on `streamer` being defined. Extend:

```
IF racingUser:
  Racing section:
    - Racing Dashboard
    - Track Database
    - My Sessions

IF streamer:
  Streamer section:
    - Streamer Dashboard
    - (existing streamer links)

IF both:
  Show both sections with a divider
```

The user avatar/name in the top nav shows:
- Racing user: username + generic avatar
- Streamer: Discord avatar + display name
- Both linked: Discord avatar + display name (Discord takes precedence for display)

## 8. Bridge Changes

### Control panel: Account section

Add an "Account" section to the Bridge control panel sidebar (above Updates):
- If no Racing account linked: show "Create Account" form (username, password)
- If account exists: show username, "Change Password" link, account status

### Settings changes

Add to `settings.json`:
- `racingUsername` — set after account creation (prevents re-prompting)
- `racingUserId` — server-assigned ID for API calls

### Session upload changes

Currently `POST /api/session` uses `bridge_id` for identity. After this change:
- Bridge still sends `bridge_id` in the payload
- Server looks up `racing_users` by `bridge_id` to associate the session with the Racing account
- If no Racing account is linked to this `bridge_id`, session is still stored (orphaned, can be claimed later)

## 9. New Files

- `src/views/racing-landing.ejs` — Racing product landing page with login/signup
- `src/views/racing-signup.ejs` — Signup form page
- `src/views/racing-dashboard.ejs` — Racing home dashboard
- `src/views/racing-account.ejs` — Racing account settings + linking
- `src/routes/racing-auth.js` — Racing signup, login, logout, account linking routes
- `src/routes/racing.js` — Racing dashboard, sessions routes

### Modified files

- `src/db.js` — `racing_users` table + query functions
- `src/server.js` — Extended session middleware, mount Racing routes, homepage redirect logic
- `src/views/header.ejs` — Sidebar dual-product support
- `src/views/login.ejs` — Remove login buttons, cards link to product pages
- `bridge/control-panel.html` — Account section for signup/status
- `bridge/settings.js` — New fields

## 10. Dependencies

- `bcrypt` (or `bcryptjs`) — for password hashing. Add to main `package.json` (server side, not Bridge).

## 11. Implementation Order

1. Add `bcryptjs` dependency + `racing_users` table + session column migration
2. Racing auth routes (signup, login, logout)
3. Session middleware extension (load racingUser, cross-load linked)
4. Racing landing page + signup page
5. Racing dashboard + account pages
6. Sidebar changes (dual-product sections)
7. Homepage changes (redirect if logged in, cards link to product pages)
8. `/tracks` route moved to Racing-protected (or accessible by both)
9. Account linking (Racing ↔ Discord)
10. Bridge control panel account section
11. Bridge migration prompt for existing users
12. Session upload API: associate with racing_user_id via bridge_id

## Verification

1. Visit `/` → see two product cards, no login buttons
2. Click Racing → `/racing` landing with login form
3. Sign up → account created, redirected to `/racing/dashboard`
4. See sidebar with Racing links (Track Database, My Sessions)
5. Log out → log in again with username/password
6. Click Streamer card → `/streamer` landing with Discord login
7. Discord login → streamer dashboard with streamer sidebar links
8. On Racing account settings, click "Link Discord" → Discord OAuth → accounts linked
9. After linking: sidebar shows BOTH Streamer and Racing sections
10. Bridge: existing user gets "Create Account" prompt → creates account → `racingUsername` saved
11. Bridge uploads session → server associates with racing_user_id via bridge_id
12. New user: visits `/racing`, signs up, downloads Bridge, Bridge auto-links via bridge_id
