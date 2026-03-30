# OBS Overlay Notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-time OBS overlay notifications (follows, subs, bits, donations) with racing-themed animated banners into the existing vilela-notifications Discord bot.

**Architecture:** Per-streamer EventSub WebSocket connections for Twitch events + per-streamer StreamElements socket.io connections for donations. Events flow through an in-memory EventEmitter bus to SSE (Server-Sent Events) endpoints that the OBS browser source overlay connects to. Each streamer gets a unique overlay URL with a token.

**Tech Stack:** Existing (Node.js, Express, SQLite, EJS) + new deps: `ws` (Twitch EventSub client), `socket.io-client@^2.5.0` (StreamElements)

**Spec:** `/Users/ricardosilva/twitch-notifications/docs/superpowers/specs/2026-03-26-twitch-notifications-design.md`

---

## File Map

### New Files

| File | Purpose |
|------|---------|
| `src/services/overlayBus.js` | EventEmitter singleton — decouples event producers from overlay consumers |
| `src/services/eventsub.js` | Twitch EventSub WebSocket client + manager (one connection per streamer) |
| `src/services/streamelements.js` | StreamElements socket.io client + manager (one connection per streamer) |
| `src/routes/overlay.js` | SSE endpoint for overlay + overlay page serving |
| `src/views/overlay-config.ejs` | Dashboard page for overlay settings |
| `public/overlay/overlay.css` | Racing-themed banner animations |
| `public/overlay/overlay.js` | Client-side SSE connection, event queue, banner rendering |
| `public/overlay/sounds/` | Default sound files (follow.mp3, sub.mp3, bits.mp3, donation.mp3) — placeholder/empty initially, user replaces with real sounds |

### Modified Files

| File | Changes |
|------|---------|
| `src/db.js` | New migration (overlay columns on streamers), new query functions |
| `src/services/twitch.js` | Add exported `refreshBroadcasterToken()` function |
| `src/pollers/subSync.js` | Import `refreshBroadcasterToken` from twitch.js instead of local copy |
| `src/routes/auth.js` | Update broadcaster OAuth scopes, store scopes in DB |
| `src/routes/dashboard.js` | Add overlay config routes + link in navigation |
| `src/server.js` | Mount `/overlay` routes |
| `src/index.js` | Start EventSub + StreamElements managers on boot |
| `package.json` | Add `ws` and `socket.io-client` deps |

---

## Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install new packages**

```bash
cd /Users/ricardosilva/vilela-notifications
npm install ws socket.io-client@^2.5.0
```

- `ws` — Twitch EventSub WebSocket client (outbound connection to Twitch)
- `socket.io-client@^2.5.0` — StreamElements realtime API (must be v2.x, their server uses EIO=3)

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add ws and socket.io-client for overlay notifications"
```

---

## Task 2: Database Migration & Query Functions

**Files:**
- Modify: `src/db.js`

Add new columns to the `streamers` table and new query functions. Follow the existing migration pattern (PRAGMA table_info check → ALTER TABLE if column missing).

- [ ] **Step 1: Add migration**

In `src/db.js`, after the last existing migration block, add a new migration that adds these columns to `streamers`:

```javascript
// Migration: Add overlay notification columns to streamers
{
  const cols = db.pragma('table_info(streamers)').map(c => c.name);
  if (!cols.includes('overlay_token')) {
    db.exec(`
      ALTER TABLE streamers ADD COLUMN overlay_token TEXT UNIQUE;
      ALTER TABLE streamers ADD COLUMN overlay_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN streamelements_jwt TEXT;
      ALTER TABLE streamers ADD COLUMN overlay_follow_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN overlay_sub_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN overlay_bits_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN overlay_donation_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN overlay_follow_duration INTEGER DEFAULT 5;
      ALTER TABLE streamers ADD COLUMN overlay_sub_duration INTEGER DEFAULT 7;
      ALTER TABLE streamers ADD COLUMN overlay_bits_duration INTEGER DEFAULT 6;
      ALTER TABLE streamers ADD COLUMN overlay_donation_duration INTEGER DEFAULT 6;
      ALTER TABLE streamers ADD COLUMN overlay_volume REAL DEFAULT 0.8;
      ALTER TABLE streamers ADD COLUMN broadcaster_scopes TEXT;
    `);
  }
}
```

- [ ] **Step 2: Add query functions**

Add these functions to `src/db.js` and include them in `module.exports`:

```javascript
function getStreamerByOverlayToken(token) {
  return db.prepare('SELECT * FROM streamers WHERE overlay_token = ?').get(token);
}

function getOverlayEnabledStreamers() {
  return db.prepare(`
    SELECT * FROM streamers
    WHERE overlay_enabled = 1
    AND broadcaster_access_token IS NOT NULL
    AND broadcaster_access_token != ''
  `).all();
}

const OVERLAY_COLUMNS = new Set([
  'overlay_enabled', 'overlay_follow_enabled', 'overlay_sub_enabled',
  'overlay_bits_enabled', 'overlay_donation_enabled',
  'overlay_follow_duration', 'overlay_sub_duration',
  'overlay_bits_duration', 'overlay_donation_duration',
  'overlay_volume', 'streamelements_jwt',
]);

function updateOverlayConfig(streamerId, config) {
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(config)) {
    if (!OVERLAY_COLUMNS.has(key)) continue; // Whitelist columns
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (fields.length === 0) return;
  values.push(streamerId);
  db.prepare(`UPDATE streamers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

function generateOverlayToken(streamerId) {
  const token = require('crypto').randomUUID();
  db.prepare('UPDATE streamers SET overlay_token = ? WHERE id = ?').run(token, streamerId);
  return token;
}

function updateBroadcasterScopes(streamerId, scopes) {
  db.prepare('UPDATE streamers SET broadcaster_scopes = ? WHERE id = ?').run(scopes, streamerId);
}
```

- [ ] **Step 3: Test migration runs**

```bash
cd /Users/ricardosilva/vilela-notifications
node -e "require('./src/db'); console.log('Migration OK');"
```

Expected: `Migration OK` with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/db.js
git commit -m "feat: add overlay notification columns and query functions to database"
```

---

## Task 3: Extract Broadcaster Token Refresh

**Files:**
- Modify: `src/services/twitch.js`
- Modify: `src/pollers/subSync.js`

The subSync poller has a local `refreshBroadcasterToken` function. Extract it to `src/services/twitch.js` so both subSync and the new EventSub service can use it.

- [ ] **Step 1: Read subSync.js to find the refresh function**

Read `src/pollers/subSync.js` and identify the `refreshBroadcasterToken` function.

- [ ] **Step 2: Add `refreshBroadcasterToken` to twitch.js**

Copy the existing function from `subSync.js` into `src/services/twitch.js` as a shared export. The function takes a **streamer object** (not an ID) to match existing call sites:

```javascript
async function refreshBroadcasterToken(streamer) {
  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    client_secret: config.twitch.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: streamer.broadcaster_refresh_token,
  });

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    body: params,
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);

  const data = await res.json();
  db.updateStreamerBroadcasterTokens(
    streamer.id,
    data.access_token,
    data.refresh_token,
    Date.now() + data.expires_in * 1000 - 60_000
  );

  return data.access_token;
}
```

Add `const db = require('../db');` at the top of twitch.js if not already imported. Export `refreshBroadcasterToken` from the module.

- [ ] **Step 3: Update subSync.js to import from twitch.js**

Replace the local `refreshBroadcasterToken` in `src/pollers/subSync.js` with:
```javascript
const { refreshBroadcasterToken } = require('../services/twitch');
```

Remove the local function definition.

- [ ] **Step 4: Commit**

```bash
git add src/services/twitch.js src/pollers/subSync.js
git commit -m "refactor: extract broadcaster token refresh into shared twitch service"
```

---

## Task 4: Update Broadcaster OAuth Scopes

**Files:**
- Modify: `src/routes/auth.js`

Add `moderator:read:followers` and `bits:read` to the broadcaster auth scope. Store granted scopes in DB.

- [ ] **Step 1: Read auth.js to find the broadcaster scope**

Read `src/routes/auth.js` and locate the broadcaster auth route and its scope string.

- [ ] **Step 2: Update scope and store it**

Change the scope in the broadcaster auth redirect from:
```javascript
scope: 'channel:read:subscriptions',
```
to:
```javascript
scope: 'channel:read:subscriptions moderator:read:followers bits:read',
```

In the broadcaster auth callback, after storing the tokens, also store the scopes:
```javascript
db.updateBroadcasterScopes(streamerId, 'channel:read:subscriptions moderator:read:followers bits:read');
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/auth.js
git commit -m "feat: add moderator:read:followers and bits:read to broadcaster OAuth scopes"
```

---

## Task 5: Overlay Event Bus

**Files:**
- Create: `src/services/overlayBus.js`

Simple EventEmitter singleton that decouples event producers (EventSub, StreamElements) from consumers (SSE endpoint).

- [ ] **Step 1: Write overlayBus.js**

Create `src/services/overlayBus.js`:
```javascript
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(100); // Support many concurrent overlay connections

module.exports = bus;
```

Events are emitted as `overlay:{streamerId}` with normalized event data.

- [ ] **Step 2: Commit**

```bash
git add src/services/overlayBus.js
git commit -m "feat: add overlay event bus for cross-service communication"
```

---

## Task 6: Overlay SSE Endpoint & Static Files

**Files:**
- Create: `src/routes/overlay.js`
- Create: `public/overlay/overlay.css`
- Create: `public/overlay/overlay.js`
- Modify: `src/server.js`

Build the overlay page and SSE endpoint first so we can test with fake events before wiring up EventSub.

- [ ] **Step 1: Create overlay route**

Create `src/routes/overlay.js`:
```javascript
const express = require('express');
const router = express.Router();
const db = require('../db');
const bus = require('../services/overlayBus');

// Serve overlay page
router.get('/:token', (req, res) => {
  const streamer = db.getStreamerByOverlayToken(req.params.token);
  if (!streamer) return res.status(404).send('Invalid overlay token');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Stream Overlay</title>
  <link rel="stylesheet" href="/overlay/overlay.css">
</head>
<body>
  <div id="notification-container"></div>
  <script>window.OVERLAY_TOKEN = '${streamer.overlay_token}';</script>
  <script src="/overlay/overlay.js"></script>
</body>
</html>`);
});

// SSE endpoint
router.get('/events/:token', (req, res) => {
  const streamer = db.getStreamerByOverlayToken(req.params.token);
  if (!streamer) return res.status(404).send('Invalid overlay token');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send initial config
  const config = {
    follow: { enabled: streamer.overlay_follow_enabled, duration: streamer.overlay_follow_duration },
    subscription: { enabled: streamer.overlay_sub_enabled, duration: streamer.overlay_sub_duration },
    bits: { enabled: streamer.overlay_bits_enabled, duration: streamer.overlay_bits_duration },
    donation: { enabled: streamer.overlay_donation_enabled, duration: streamer.overlay_donation_duration },
    volume: streamer.overlay_volume,
  };
  res.write(`data: ${JSON.stringify({ type: 'config', config })}\n\n`);

  // Listen for events on the bus
  const listener = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  bus.on(`overlay:${streamer.id}`, listener);

  req.on('close', () => {
    bus.off(`overlay:${streamer.id}`, listener);
  });
});

module.exports = router;
```

- [ ] **Step 2: Mount overlay routes in server.js**

In `src/server.js`, add after the existing route mounts:
```javascript
const overlayRoutes = require('./routes/overlay');
app.use('/overlay', overlayRoutes);
```

- [ ] **Step 3: Create overlay CSS**

Create `public/overlay/overlay.css` with the full racing-themed banner styles. This is the same CSS from the approved mockups:

```css
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  background: transparent;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

#notification-container {
  position: fixed;
  top: 0; left: 0; right: 0;
  z-index: 9999;
}

/* Banner base */
.banner {
  position: relative;
  overflow: hidden;
  border-radius: 0 0 10px 10px;
  height: 90px;
  transform: translateY(-100%);
  animation: slideDown 0.3s ease-out forwards;
}
.banner.dismissing {
  animation: slideUp 0.3s ease-in forwards;
}

@keyframes slideDown { from { transform: translateY(-100%); } to { transform: translateY(0); } }
@keyframes slideUp { from { transform: translateY(0); } to { transform: translateY(-100%); } }

.checker-top, .checker-bottom {
  position: absolute; left: 0; right: 0; height: 6px; z-index: 5;
}
.checker-top { top: 0; }
.checker-bottom { bottom: 0; }

.banner-content {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  gap: 16px; padding: 0 24px; z-index: 2;
}

.banner-title { font-size: 11px; text-transform: uppercase; letter-spacing: 2px; font-weight: 600; }
.banner-name { color: #fff; font-size: 20px; font-weight: 800; }
.banner-sub { color: #aaa; font-size: 13px; }
.banner-emoji { font-size: 32px; }

.engine-idle { animation: vibrate 0.1s linear infinite; }
@keyframes vibrate {
  0% { transform: translateX(0); } 25% { transform: translateX(0.5px); }
  50% { transform: translateX(0); } 75% { transform: translateX(-0.5px); }
  100% { transform: translateX(0); }
}

/* Follow: car zooms left → right */
.banner-follow { background: linear-gradient(90deg, #1a1a2e, #16213e); }
.banner-follow .checker-top { background: repeating-linear-gradient(90deg, #fff 0px, #fff 8px, #222 8px, #222 16px); }
.banner-follow .checker-bottom { background: repeating-linear-gradient(90deg, #222 0px, #222 8px, #fff 8px, #fff 16px); }
.banner-follow .banner-title { color: #8888cc; }

.follow-car {
  position: absolute; font-size: 36px; z-index: 10; top: 50%;
  transform: translateY(-50%) scaleX(-1);
  animation: driveRight 3s linear infinite;
}
@keyframes driveRight {
  0% { left: -60px; opacity: 1; } 80% { left: 105%; opacity: 1; }
  81% { opacity: 0; } 100% { left: -60px; opacity: 0; }
}

/* Subscription: two cars race inward */
.banner-subscription { background: linear-gradient(90deg, #0a2e0a, #1a4a1a 50%, #0a2e0a); }
.banner-subscription .checker-top { background: repeating-linear-gradient(90deg, #00ff88 0px, #00ff88 8px, #004d29 8px, #004d29 16px); }
.banner-subscription .checker-bottom { background: repeating-linear-gradient(90deg, #004d29 0px, #004d29 8px, #00ff88 8px, #00ff88 16px); }
.banner-subscription .banner-title { color: #00ff88; }

.sub-car-left {
  position: absolute; font-size: 36px; z-index: 10; top: 50%;
  transform: translateY(-50%) scaleX(-1);
  animation: subFromLeft 2.5s ease-in-out infinite;
}
.sub-car-right {
  position: absolute; font-size: 36px; z-index: 10; top: 50%;
  transform: translateY(-50%);
  animation: subFromRight 2.5s ease-in-out infinite;
}
@keyframes subFromLeft { 0% { left: -60px; } 40% { left: 8%; } 60% { left: 8%; } 100% { left: -60px; } }
@keyframes subFromRight { 0% { right: -60px; } 40% { right: 8%; } 60% { right: 8%; } 100% { right: -60px; } }

/* Bits: burnouts with fire */
.banner-bits { background: linear-gradient(90deg, #2e1a00, #4a2e00 50%, #2e1a00); }
.banner-bits .checker-top { background: repeating-linear-gradient(90deg, #f7c948 0px, #f7c948 8px, #8b6914 8px, #8b6914 16px); }
.banner-bits .checker-bottom { background: repeating-linear-gradient(90deg, #8b6914 0px, #8b6914 8px, #f7c948 8px, #f7c948 16px); }
.banner-bits .banner-title { color: #f7c948; }

.burnout-car-right {
  position: absolute; font-size: 30px; z-index: 10; top: 50%; right: 8%;
  transform: translateY(-50%);
  animation: burnoutShake 0.08s linear infinite;
}
.burnout-car-left {
  position: absolute; font-size: 30px; z-index: 10; top: 50%; left: 8%;
  transform: translateY(-50%) scaleX(-1);
  animation: burnoutShakeFlipped 0.08s linear infinite;
}
@keyframes burnoutShake {
  0% { transform: translateY(-50%) translateX(0); } 25% { transform: translateY(-50%) translateX(2px); }
  50% { transform: translateY(-50%) translateX(0); } 75% { transform: translateY(-50%) translateX(-2px); }
  100% { transform: translateY(-50%) translateX(0); }
}
@keyframes burnoutShakeFlipped {
  0% { transform: translateY(-50%) scaleX(-1) translateX(0); } 25% { transform: translateY(-50%) scaleX(-1) translateX(2px); }
  50% { transform: translateY(-50%) scaleX(-1) translateX(0); } 75% { transform: translateY(-50%) scaleX(-1) translateX(-2px); }
  100% { transform: translateY(-50%) scaleX(-1) translateX(0); }
}

.fire-single {
  position: absolute; z-index: 9; top: 50%; transform: translateY(-50%);
  font-size: 22px; animation: fireFlicker 0.3s ease-in-out infinite alternate;
}
.fire-behind-right { right: 3%; }
.fire-behind-left { left: 3%; }
@keyframes fireFlicker {
  0% { transform: translateY(-50%) scale(0.7); opacity: 0.6; }
  50% { transform: translateY(-50%) scale(1.2); opacity: 1; }
  100% { transform: translateY(-50%) scale(0.9); opacity: 0.8; }
}

.tire-smoke { position: absolute; z-index: 8; font-size: 16px; opacity: 0; }
.ts-1 { top: 10%; right: 4%; animation: smokeRise 0.8s ease-out infinite; }
.ts-2 { top: 20%; right: 6%; animation: smokeRise 0.8s ease-out 0.2s infinite; }
.ts-3 { top: 10%; left: 4%; animation: smokeRise 0.8s ease-out 0.4s infinite; }
.ts-4 { top: 20%; left: 6%; animation: smokeRise 0.8s ease-out 0.6s infinite; }
@keyframes smokeRise {
  0% { opacity: 0.7; transform: scale(0.5) translateY(0); }
  100% { opacity: 0; transform: scale(2) translateY(-20px); }
}

/* Donation: car zooms right → left */
.banner-donation { background: linear-gradient(90deg, #1a0a2e, #2e1a4a 50%, #1a0a2e); }
.banner-donation .checker-top { background: repeating-linear-gradient(90deg, #bf00ff 0px, #bf00ff 8px, #4a0066 8px, #4a0066 16px); }
.banner-donation .checker-bottom { background: repeating-linear-gradient(90deg, #4a0066 0px, #4a0066 8px, #bf00ff 8px, #bf00ff 16px); }
.banner-donation .banner-title { color: #bf00ff; }

.sponsor-car {
  position: absolute; font-size: 36px; z-index: 10; top: 50%;
  transform: translateY(-50%);
  animation: driveLeft 4s ease-in-out infinite;
}
@keyframes driveLeft {
  0% { right: -60px; } 15% { right: 6%; } 70% { right: 6%; }
  85% { right: 6%; } 100% { right: 110%; }
}

.speed-line {
  position: absolute; height: 2px; z-index: 4;
  background: linear-gradient(270deg, transparent, rgba(191,0,255,0.6), transparent);
  animation: speedStreakRL 0.8s linear infinite;
}
.sl-1 { top: 25%; width: 80px; right: 20%; animation-delay: 0s; }
.sl-2 { top: 45%; width: 120px; right: 40%; animation-delay: 0.2s; }
.sl-3 { top: 65%; width: 60px; right: 60%; animation-delay: 0.4s; }
.sl-4 { top: 35%; width: 100px; right: 10%; animation-delay: 0.6s; }
@keyframes speedStreakRL {
  0% { opacity: 0; transform: translateX(0); } 50% { opacity: 0.8; }
  100% { opacity: 0; transform: translateX(100px); }
}
```

- [ ] **Step 4: Create overlay client-side JS**

Create `public/overlay/overlay.js`:
```javascript
const container = document.getElementById('notification-container');
let overlayConfig = {};
const queue = [];
let isPlaying = false;

// Connect to SSE
const evtSource = new EventSource(`/overlay/events/${window.OVERLAY_TOKEN}`);

evtSource.onmessage = (e) => {
  const data = JSON.parse(e.data);

  if (data.type === 'config') {
    overlayConfig = data.config;
    return;
  }

  // Check if event type is enabled
  const eventType = data.type;
  const typeConfig = overlayConfig[eventType];
  if (typeConfig && !typeConfig.enabled) return;

  queue.push(data);
  if (!isPlaying) playNext();
};

evtSource.onerror = () => {
  console.log('SSE connection lost, reconnecting...');
};

function playNext() {
  if (queue.length === 0) { isPlaying = false; return; }
  isPlaying = true;
  const event = queue.shift();
  showNotification(event);
}

function showNotification(event) {
  const typeConfig = overlayConfig[event.type] || {};
  const duration = (typeConfig.duration || 5) * 1000;

  // Play sound — uses default sound files from /overlay/sounds/{type}.mp3
  // Users can replace these files with custom sounds
  const soundMap = {
    follow: '/overlay/sounds/follow.mp3',
    subscription: '/overlay/sounds/sub.mp3',
    bits: '/overlay/sounds/bits.mp3',
    donation: '/overlay/sounds/donation.mp3',
  };
  const soundUrl = soundMap[event.type];
  if (soundUrl) {
    const audio = new Audio(soundUrl);
    audio.volume = overlayConfig.volume || 0.8;
    audio.play().catch(() => {}); // Fails silently if file doesn't exist
  }

  const banner = document.createElement('div');
  banner.className = `banner banner-${event.type} engine-idle`;
  banner.innerHTML = buildBannerContent(event);
  container.appendChild(banner);

  setTimeout(() => {
    banner.classList.add('dismissing');
    banner.addEventListener('animationend', () => {
      banner.remove();
      setTimeout(playNext, 500); // Gap between notifications
    });
  }, duration);
}

function buildBannerContent(event) {
  const checkers = '<div class="checker-top"></div><div class="checker-bottom"></div>';

  switch (event.type) {
    case 'follow':
      return `${checkers}
        <div class="follow-car">🏎️</div>
        <div class="banner-content"><div style="text-align:center">
          <div class="banner-title">New Pit Crew Member!</div>
          <div class="banner-name">${esc(event.data.username)}</div>
          <div class="banner-sub">just joined the race 🏁</div>
        </div></div>`;

    case 'subscription': {
      const d = event.data;
      const detail = d.months && d.months > 1
        ? `Subscribed for <span style="color:#00ff88;font-weight:bold">${d.months} months</span> — Tier ${d.tier || '1'}`
        : d.message ? esc(d.message) : `Tier ${d.tier || '1'} subscriber!`;
      return `${checkers}
        <div class="sub-car-left">🏎️</div>
        <div class="sub-car-right">🏎️</div>
        <div class="banner-content">
          <div class="banner-emoji">🏆</div>
          <div style="text-align:center">
            <div class="banner-title">Podium Finish!</div>
            <div class="banner-name">${esc(d.username)}</div>
            <div class="banner-sub">${detail}</div>
          </div>
          <div class="banner-emoji">🏆</div>
        </div>`;
    }

    case 'bits':
      return `${checkers}
        <div class="burnout-car-right">🏎️</div>
        <div class="fire-single fire-behind-right">🔥</div>
        <div class="burnout-car-left">🏎️</div>
        <div class="fire-single fire-behind-left">🔥</div>
        <div class="tire-smoke ts-1">💨</div><div class="tire-smoke ts-2">💨</div>
        <div class="tire-smoke ts-3">💨</div><div class="tire-smoke ts-4">💨</div>
        <div class="banner-content"><div style="text-align:center">
          <div class="banner-title">Nitro Boost!</div>
          <div class="banner-name">${esc(event.data.username)}</div>
          <div class="banner-sub">fueled up <span style="color:#f7c948;font-weight:bold">${event.data.amount} bits</span> of nitro! 🔥</div>
        </div></div>`;

    case 'donation':
      return `${checkers}
        <div class="sponsor-car">🏎️</div>
        <div class="speed-line sl-1"></div><div class="speed-line sl-2"></div>
        <div class="speed-line sl-3"></div><div class="speed-line sl-4"></div>
        <div class="banner-content">
          <div class="banner-emoji">🛞</div>
          <div style="text-align:center">
            <div class="banner-title">Sponsor Alert!</div>
            <div class="banner-name">${esc(event.data.username)}</div>
            <div class="banner-sub">sponsored the team with <span style="color:#bf00ff;font-weight:bold">$${event.data.amount}</span> 💸</div>
          </div>
          <div class="banner-emoji">🛞</div>
        </div>`;

    default: return '';
  }
}

function esc(text) {
  const d = document.createElement('div');
  d.textContent = text || '';
  return d.innerHTML;
}
```

- [ ] **Step 5: Create sounds directory**

Create `public/overlay/sounds/` with a `.gitkeep`:
```bash
mkdir -p public/overlay/sounds
touch public/overlay/sounds/.gitkeep
```

Sound files (`follow.mp3`, `sub.mp3`, `bits.mp3`, `donation.mp3`) are user-provided. The overlay client plays them if they exist and silently fails if they don't. Users drop their own `.mp3` files into this directory or upload via the dashboard (future enhancement).

- [ ] **Step 6: Test overlay loads**

Start the dev server and check `http://localhost:3000/overlay/{some-token}` returns 404 (no token exists yet — that's expected). Verify no startup errors.

```bash
npm run dev
```

- [ ] **Step 7: Commit**

```bash
git add src/routes/overlay.js public/overlay/ src/server.js public/overlay/sounds/.gitkeep
git commit -m "feat: add OBS overlay SSE endpoint and racing-themed notification banners"
```

---

## Task 7: Overlay Dashboard Config Page

**Files:**
- Create: `src/views/overlay-config.ejs`
- Modify: `src/routes/dashboard.js`

Add a dashboard page where streamers can enable their overlay, get the OBS URL, configure event toggles/durations, enter StreamElements JWT, and fire test notifications.

- [ ] **Step 1: Read existing dashboard and view files for patterns**

Read `src/routes/dashboard.js` and `src/views/guild-config.ejs` to understand the existing patterns for route handlers, auth checks, and EJS template structure (header/footer includes, form handling).

- [ ] **Step 2: Add overlay config routes to dashboard.js**

Add these routes in `src/routes/dashboard.js`:

```javascript
// Overlay config page
router.get('/overlay', (req, res) => {
  const streamer = req.streamer;
  const appUrl = config.app.url || `${req.protocol}://${req.get('host')}`;
  const overlayUrl = streamer.overlay_token ? `${appUrl}/overlay/${streamer.overlay_token}` : null;
  const needsReauth = !streamer.broadcaster_scopes ||
    !streamer.broadcaster_scopes.includes('moderator:read:followers') ||
    !streamer.broadcaster_scopes.includes('bits:read');

  res.render('overlay-config', {
    streamer,
    overlayUrl,
    needsReauth,
    appUrl,
  });
});

// Save overlay settings
router.post('/overlay', (req, res) => {
  const b = req.body;
  db.updateOverlayConfig(req.streamer.id, {
    overlay_enabled: b.overlay_enabled ? 1 : 0,
    overlay_follow_enabled: b.overlay_follow_enabled ? 1 : 0,
    overlay_sub_enabled: b.overlay_sub_enabled ? 1 : 0,
    overlay_bits_enabled: b.overlay_bits_enabled ? 1 : 0,
    overlay_donation_enabled: b.overlay_donation_enabled ? 1 : 0,
    overlay_follow_duration: parseInt(b.overlay_follow_duration) || 5,
    overlay_sub_duration: parseInt(b.overlay_sub_duration) || 7,
    overlay_bits_duration: parseInt(b.overlay_bits_duration) || 6,
    overlay_donation_duration: parseInt(b.overlay_donation_duration) || 6,
    overlay_volume: parseFloat(b.overlay_volume) || 0.8,
    streamelements_jwt: b.streamelements_jwt || '',
  });

  // Start/stop EventSub + StreamElements connections based on enabled state
  const { eventSubManager } = require('../services/eventsub');
  const { streamElementsManager } = require('../services/streamelements');
  if (b.overlay_enabled) {
    eventSubManager.startForStreamer(req.streamer.id);
    if (b.streamelements_jwt) streamElementsManager.startForStreamer(req.streamer.id);
  } else {
    eventSubManager.stopForStreamer(req.streamer.id);
    streamElementsManager.stopForStreamer(req.streamer.id);
  }

  res.redirect('/dashboard/overlay');
});

// Generate overlay token
router.post('/overlay/generate-token', (req, res) => {
  db.generateOverlayToken(req.streamer.id);
  res.redirect('/dashboard/overlay');
});

// Test notification
router.post('/overlay/test/:eventType', (req, res) => {
  const bus = require('../services/overlayBus');
  const type = req.params.eventType;
  const testEvents = {
    follow: { type: 'follow', data: { username: 'TestRacer' } },
    subscription: { type: 'subscription', data: { username: 'SpeedDemon', message: 'Love the stream!', tier: '1', months: 6 } },
    bits: { type: 'bits', data: { username: 'NitroFan', amount: 500, message: 'Take my bits!' } },
    donation: { type: 'donation', data: { username: 'BigSponsor', amount: 25, message: 'Keep racing!', currency: 'USD' } },
  };

  const event = testEvents[type];
  if (!event) return res.status(400).json({ error: 'Invalid event type' });

  bus.emit(`overlay:${req.streamer.id}`, event);
  res.json({ ok: true });
});
```

- [ ] **Step 3: Create overlay-config.ejs**

Create `src/views/overlay-config.ejs` following the existing EJS patterns (include header/footer, use the project's CSS custom properties). The template should include:

- Overlay enable/disable toggle
- "Generate overlay URL" button (if no token exists)
- Copy-able overlay URL with instructions for OBS
- Per-event toggles (follow, sub, bits, donation) with duration sliders
- Volume slider
- StreamElements JWT input field
- Broadcaster re-auth warning (if scopes are insufficient)
- Test notification buttons (one per event type, using fetch POST to the test endpoint)
- Save button

Read `src/views/header.ejs` and `src/views/guild-config.ejs` for the exact EJS patterns and CSS classes to use.

- [ ] **Step 4: Add navigation link**

Add an "Overlay" link in the dashboard navigation (wherever the existing nav links are rendered — check `header.ejs` or `dashboard.ejs`).

- [ ] **Step 5: Test the dashboard page**

Start dev server, log in, navigate to `/dashboard/overlay`. Verify:
- Page renders without errors
- Can generate overlay token
- Can copy overlay URL
- Settings form submits without errors

- [ ] **Step 6: Test notifications via test buttons**

1. Open overlay URL in one tab
2. Click test buttons on the dashboard overlay page
3. Verify banners appear with correct animations in the overlay tab

- [ ] **Step 7: Commit**

```bash
git add src/routes/dashboard.js src/views/overlay-config.ejs
git commit -m "feat: add overlay configuration page to dashboard with test notifications"
```

---

## Task 8: Twitch EventSub WebSocket Service

**Files:**
- Create: `src/services/eventsub.js`

Per-streamer EventSub WebSocket connections. Each streamer with overlay enabled gets their own connection to `wss://eventsub.wss.twitch.tv/ws`. Subscribes to 5 event types using the streamer's broadcaster token.

- [ ] **Step 1: Write eventsub.js**

Create `src/services/eventsub.js`:
```javascript
const WebSocket = require('ws');
const config = require('../config');
const db = require('../db');
const bus = require('./overlayBus');
const { refreshBroadcasterToken } = require('./twitch');

const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';

const SUBSCRIPTION_TYPES = [
  { type: 'channel.follow', version: '2', needsModerator: true },
  { type: 'channel.subscribe', version: '1' },
  { type: 'channel.subscription.gift', version: '1' },
  { type: 'channel.subscription.message', version: '1' },
  { type: 'channel.cheer', version: '1' },
];

class EventSubClient {
  constructor(streamerId) {
    this.streamerId = streamerId;
    this.ws = null;
    this.keepaliveTimer = null;
    this.reconnectDelay = 1000;
    this.running = false;
  }

  async connect() {
    const streamer = db.getStreamerById(this.streamerId);
    if (!streamer || !streamer.broadcaster_access_token || !streamer.twitch_user_id) {
      console.log(`[EventSub] Streamer ${this.streamerId}: not configured, skipping`);
      return;
    }

    this.running = true;
    console.log(`[EventSub] Connecting for streamer ${streamer.twitch_display_name || this.streamerId}...`);

    this.ws = new WebSocket(EVENTSUB_URL);

    this.ws.on('open', () => {
      console.log(`[EventSub] Connected for streamer ${this.streamerId}`);
      this.reconnectDelay = 1000;
    });

    this.ws.on('message', (data) => this.handleMessage(data));

    this.ws.on('close', (code) => {
      console.log(`[EventSub] Disconnected for streamer ${this.streamerId} (code: ${code})`);
      this.clearKeepalive();
      if (this.running && code !== 1000) {
        console.log(`[EventSub] Reconnecting in ${this.reconnectDelay / 1000}s...`);
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
      }
    });

    this.ws.on('error', (err) => {
      console.error(`[EventSub] Error for streamer ${this.streamerId}:`, err.message);
    });
  }

  async handleMessage(raw) {
    const msg = JSON.parse(raw.toString());
    const messageType = msg.metadata.message_type;

    switch (messageType) {
      case 'session_welcome': {
        const sessionId = msg.payload.session.id;
        const timeout = msg.payload.session.keepalive_timeout_seconds;
        console.log(`[EventSub] Session ${sessionId} for streamer ${this.streamerId} (keepalive: ${timeout}s)`);
        this.resetKeepalive(timeout);

        for (const subType of SUBSCRIPTION_TYPES) {
          await this.createSubscription(sessionId, subType);
        }
        break;
      }

      case 'session_keepalive':
        this.resetKeepalive(msg.payload?.session?.keepalive_timeout_seconds || 10);
        break;

      case 'notification': {
        const subType = msg.metadata.subscription_type;
        const event = msg.payload.event;
        this.resetKeepalive(10);

        const normalized = this.normalizeEvent(subType, event);
        if (normalized) {
          const streamer = db.getStreamerById(this.streamerId);
          const typeMap = { follow: 'follow', subscription: 'sub', bits: 'bits', donation: 'donation' };
          const enabledKey = `overlay_${typeMap[normalized.type] || normalized.type}_enabled`;
          if (streamer && streamer[enabledKey]) {
            bus.emit(`overlay:${this.streamerId}`, normalized);
          }
        }
        break;
      }

      case 'session_reconnect': {
        const reconnectUrl = msg.payload.session.reconnect_url;
        console.log(`[EventSub] Reconnect for streamer ${this.streamerId}`);
        const oldWs = this.ws;
        this.ws = new WebSocket(reconnectUrl);
        this.ws.on('message', (data) => this.handleMessage(data));
        this.ws.on('open', () => oldWs.close());
        this.ws.on('close', (code) => {
          if (this.running && code !== 1000) {
            setTimeout(() => this.connect(), this.reconnectDelay);
          }
        });
        break;
      }

      case 'revocation':
        console.warn(`[EventSub] Subscription revoked for streamer ${this.streamerId}:`,
          msg.payload.subscription.type, msg.payload.subscription.status);
        break;
    }
  }

  async createSubscription(sessionId, subType) {
    let streamer = db.getStreamerById(this.streamerId);
    let token = streamer.broadcaster_access_token;

    const condition = { broadcaster_user_id: streamer.twitch_user_id };
    if (subType.needsModerator) {
      condition.moderator_user_id = streamer.twitch_user_id;
    }

    const body = {
      type: subType.type,
      version: subType.version,
      condition,
      transport: { method: 'websocket', session_id: sessionId },
    };

    let res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Client-Id': config.twitch.clientId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    // Retry with refreshed token on 401
    if (res.status === 401) {
      try {
        streamer = db.getStreamerById(this.streamerId);
        token = await refreshBroadcasterToken(streamer);
        res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Client-Id': config.twitch.clientId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        console.error(`[EventSub] Token refresh failed for streamer ${this.streamerId}:`, err.message);
        return;
      }
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error(`[EventSub] Failed to subscribe ${subType.type} for streamer ${this.streamerId}:`, err.message || res.status);
      return;
    }

    console.log(`[EventSub] Subscribed to ${subType.type} for streamer ${this.streamerId}`);
  }

  normalizeEvent(subType, event) {
    switch (subType) {
      case 'channel.follow':
        return { type: 'follow', data: { username: event.user_name } };

      case 'channel.subscribe':
        return {
          type: 'subscription',
          data: {
            username: event.user_name,
            tier: event.tier === '1000' ? '1' : event.tier === '2000' ? '2' : '3',
            months: 1,
            message: null,
          },
        };

      case 'channel.subscription.gift':
        return {
          type: 'subscription',
          data: {
            username: event.is_anonymous ? 'Anonymous' : event.user_name,
            tier: event.tier === '1000' ? '1' : event.tier === '2000' ? '2' : '3',
            months: null,
            message: `Gifted ${event.total} sub${event.total > 1 ? 's' : ''}!`,
          },
        };

      case 'channel.subscription.message':
        return {
          type: 'subscription',
          data: {
            username: event.user_name,
            tier: event.tier === '1000' ? '1' : event.tier === '2000' ? '2' : '3',
            months: event.cumulative_months,
            message: event.message ? event.message.text : null,
          },
        };

      case 'channel.cheer':
        return {
          type: 'bits',
          data: {
            username: event.is_anonymous ? 'Anonymous' : event.user_name,
            amount: event.bits,
            message: event.message || null,
          },
        };

      default:
        return null;
    }
  }

  resetKeepalive(timeoutSeconds) {
    this.clearKeepalive();
    this.keepaliveTimer = setTimeout(() => {
      console.warn(`[EventSub] Keepalive timeout for streamer ${this.streamerId}`);
      if (this.ws) this.ws.close();
    }, (timeoutSeconds + 5) * 1000);
  }

  clearKeepalive() {
    if (this.keepaliveTimer) {
      clearTimeout(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  disconnect() {
    this.running = false;
    this.clearKeepalive();
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
  }
}

// Manager for all per-streamer connections
const clients = new Map();

const eventSubManager = {
  startAll() {
    const streamers = db.getOverlayEnabledStreamers();
    for (const s of streamers) {
      this.startForStreamer(s.id);
    }
    console.log(`[EventSub] Started ${streamers.length} connections`);
  },

  startForStreamer(streamerId) {
    this.stopForStreamer(streamerId);
    const client = new EventSubClient(streamerId);
    clients.set(streamerId, client);
    client.connect();
  },

  stopForStreamer(streamerId) {
    const client = clients.get(streamerId);
    if (client) {
      client.disconnect();
      clients.delete(streamerId);
    }
  },

  stopAll() {
    for (const [id, client] of clients) {
      client.disconnect();
    }
    clients.clear();
  },
};

module.exports = { eventSubManager };
```

- [ ] **Step 2: Commit**

```bash
git add src/services/eventsub.js
git commit -m "feat: add Twitch EventSub WebSocket service with per-streamer connections"
```

---

## Task 9: StreamElements WebSocket Service

**Files:**
- Create: `src/services/streamelements.js`

Per-streamer StreamElements socket.io connections for donation (tip) events.

- [ ] **Step 1: Write streamelements.js**

Create `src/services/streamelements.js`:
```javascript
const io = require('socket.io-client');
const db = require('../db');
const bus = require('./overlayBus');

class StreamElementsClient {
  constructor(streamerId) {
    this.streamerId = streamerId;
    this.socket = null;
    this.running = false;
  }

  connect() {
    const streamer = db.getStreamerById(this.streamerId);
    if (!streamer || !streamer.streamelements_jwt) {
      console.log(`[StreamElements] Streamer ${this.streamerId}: no JWT token, skipping`);
      return;
    }

    this.running = true;
    console.log(`[StreamElements] Connecting for streamer ${streamer.twitch_display_name || this.streamerId}...`);

    this.socket = io('https://realtime.streamelements.com', {
      transports: ['websocket'],
    });

    this.socket.on('connect', () => {
      console.log(`[StreamElements] Connected for streamer ${this.streamerId}, authenticating...`);
      this.socket.emit('authenticate', { method: 'jwt', token: streamer.streamelements_jwt });
    });

    this.socket.on('authenticated', () => {
      console.log(`[StreamElements] Authenticated for streamer ${this.streamerId}`);
    });

    this.socket.on('unauthorized', () => {
      console.error(`[StreamElements] Auth failed for streamer ${this.streamerId} — check JWT token`);
    });

    const handleTip = (event) => {
      if (event.type === 'tip') {
        const s = db.getStreamerById(this.streamerId);
        if (s && s.overlay_donation_enabled) {
          bus.emit(`overlay:${this.streamerId}`, {
            type: 'donation',
            data: {
              username: event.data.username,
              amount: event.data.amount,
              message: event.data.message || null,
              currency: event.data.currency || 'USD',
            },
          });
        }
      }
    };

    this.socket.on('event', handleTip);
    this.socket.on('event:test', handleTip);

    this.socket.on('disconnect', () => {
      console.log(`[StreamElements] Disconnected for streamer ${this.streamerId}`);
    });
  }

  disconnect() {
    this.running = false;
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }
}

const clients = new Map();

const streamElementsManager = {
  startAll() {
    const streamers = db.getOverlayEnabledStreamers();
    let count = 0;
    for (const s of streamers) {
      if (s.streamelements_jwt) {
        this.startForStreamer(s.id);
        count++;
      }
    }
    console.log(`[StreamElements] Started ${count} connections`);
  },

  startForStreamer(streamerId) {
    this.stopForStreamer(streamerId);
    const client = new StreamElementsClient(streamerId);
    clients.set(streamerId, client);
    client.connect();
  },

  stopForStreamer(streamerId) {
    const client = clients.get(streamerId);
    if (client) {
      client.disconnect();
      clients.delete(streamerId);
    }
  },

  stopAll() {
    for (const [id, client] of clients) {
      client.disconnect();
    }
    clients.clear();
  },
};

module.exports = { streamElementsManager };
```

- [ ] **Step 2: Commit**

```bash
git add src/services/streamelements.js
git commit -m "feat: add StreamElements WebSocket service for donation events"
```

---

## Task 10: Startup Integration

**Files:**
- Modify: `src/index.js`

Wire EventSub and StreamElements managers into the server boot sequence.

- [ ] **Step 1: Read current index.js**

Read `src/index.js` to find where pollers are started and where to add the new managers.

- [ ] **Step 2: Add managers to startup**

After the pollers are started, add:
```javascript
const { eventSubManager } = require('./services/eventsub');
const { streamElementsManager } = require('./services/streamelements');

// Start overlay event sources
eventSubManager.startAll();
streamElementsManager.startAll();
```

- [ ] **Step 3: Commit**

```bash
git add src/index.js
git commit -m "feat: start EventSub and StreamElements managers on server boot"
```

---

## Task 11: End-to-End Verification

- [ ] **Step 1: Start the server**

```bash
npm run dev
```

Verify no startup errors. Check logs for EventSub/StreamElements connection attempts.

- [ ] **Step 2: Test overlay config dashboard**

1. Log in to the dashboard
2. Navigate to `/dashboard/overlay`
3. Generate an overlay token
4. Copy the overlay URL

- [ ] **Step 3: Test overlay with test notifications**

1. Open the overlay URL in a browser tab
2. Click each test button (Follow, Sub, Bits, Donation) on the dashboard
3. Verify each racing-themed banner appears with correct:
   - Colors and theme
   - Car animations (follow: zoom right, sub: two cars inward, bits: burnouts + fire, donation: zoom left)
   - Text content
   - Engine idle vibration
   - Slide-down entrance and slide-up dismissal

- [ ] **Step 4: Test event queue**

Click multiple test buttons rapidly. Verify notifications queue and display one at a time with a gap between each.

- [ ] **Step 5: Test event toggle**

Disable "Follow" in overlay settings, save. Fire follow test — should NOT appear. Re-enable and test again.

- [ ] **Step 6: Final commit**

```bash
git status
# Stage only relevant files — review what's changed before adding
git commit -m "feat: OBS overlay notification system complete"
```
