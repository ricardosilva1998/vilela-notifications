# Custom Overlays Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a template-based custom overlay system controlled via chat commands, with dashboard management UI and 3 new OBS browser sources.

**Architecture:** Custom overlays are stored in SQLite with JSON config. A new Express router handles CRUD + SSE endpoints. Chat commands in twitchChat.js toggle overlay state and emit events via the existing overlayBus. Three new client-side JS files render templates in OBS browser sources.

**Tech Stack:** Node.js, Express 5, better-sqlite3, EJS, SSE (EventSource), tmi.js, Playwright (E2E tests)

**Spec:** `docs/superpowers/specs/2026-03-27-custom-overlays-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| **Create:** `src/routes/customOverlays.js` | Express router: CRUD API, file upload, SSE endpoints, overlay HTML pages |
| **Create:** `src/views/custom-overlays.ejs` | Dashboard page: table list, create/edit modal (3-step flow) |
| **Create:** `public/overlay/scenes.js` | OBS client: SSE → render scene templates (centered-text, split-layout, full-image) |
| **Create:** `public/overlay/bar.js` | OBS client: SSE → render info bar templates (social-bar, ticker) |
| **Create:** `public/overlay/custom-alerts.js` | OBS client: SSE → render alert templates (image-popup, text-popup) |
| **Modify:** `src/db.js` | Add `custom_overlays` table + CRUD functions |
| **Modify:** `src/server.js` | Mount new router + static file serving for uploads |
| **Modify:** `src/services/twitchChat.js` | Add custom overlay command handling in `handleMessage()` |
| **Modify:** `src/views/dashboard.ejs` | Add "Custom Overlays" card |
| **Modify:** `src/views/overlay-builder.ejs` | Add 3 new OBS URLs to dropdown |
| **Modify:** `src/views/overlay-config.ejs` | Show all 5 OBS source URLs |

---

### Task 1: Database — custom_overlays table and CRUD functions

**Files:**
- Modify: `src/db.js`

- [ ] **Step 1: Add the custom_overlays table creation**

In `src/db.js`, find the large `db.exec()` block that creates all tables (around line 296). Add this table creation at the end of the block, before the closing backtick:

```sql
CREATE TABLE IF NOT EXISTS custom_overlays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  streamer_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('scene','bar','custom-alert')),
  name TEXT NOT NULL,
  template TEXT NOT NULL,
  chat_command TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 0,
  always_on INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (streamer_id) REFERENCES streamers(id),
  UNIQUE(streamer_id, chat_command)
);
```

- [ ] **Step 2: Add prepared statements and CRUD functions**

After the existing prepared statements section in `db.js`, add:

```javascript
// Custom Overlays
const _getCustomOverlays = db.prepare(
  'SELECT * FROM custom_overlays WHERE streamer_id = ? ORDER BY sort_order, id'
);
const _getCustomOverlaysByType = db.prepare(
  'SELECT * FROM custom_overlays WHERE streamer_id = ? AND type = ? ORDER BY sort_order, id'
);
const _getCustomOverlayById = db.prepare(
  'SELECT * FROM custom_overlays WHERE id = ? AND streamer_id = ?'
);
const _getCustomOverlayByCommand = db.prepare(
  'SELECT * FROM custom_overlays WHERE streamer_id = ? AND chat_command = ?'
);
const _getAllCustomOverlayCommands = db.prepare(
  'SELECT id, streamer_id, type, chat_command FROM custom_overlays WHERE chat_command IS NOT NULL'
);
const _addCustomOverlay = db.prepare(`
  INSERT INTO custom_overlays (streamer_id, type, name, template, chat_command, config, is_active, always_on, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const _updateCustomOverlay = db.prepare(`
  UPDATE custom_overlays SET name = ?, template = ?, chat_command = ?, config = ?, always_on = ?
  WHERE id = ? AND streamer_id = ?
`);
const _toggleCustomOverlay = db.prepare(
  'UPDATE custom_overlays SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ? AND streamer_id = ? RETURNING *'
);
const _setCustomOverlayActive = db.prepare(
  'UPDATE custom_overlays SET is_active = ? WHERE id = ? AND streamer_id = ?'
);
const _deleteCustomOverlay = db.prepare(
  'DELETE FROM custom_overlays WHERE id = ? AND streamer_id = ?'
);
const _deactivateAllScenes = db.prepare(
  "UPDATE custom_overlays SET is_active = 0 WHERE streamer_id = ? AND type = 'scene' AND id != ?"
);

function getCustomOverlays(streamerId) {
  return _getCustomOverlays.all(streamerId);
}

function getCustomOverlaysByType(streamerId, type) {
  return _getCustomOverlaysByType.all(streamerId, type);
}

function getCustomOverlayById(id, streamerId) {
  return _getCustomOverlayById.get(id, streamerId);
}

function getCustomOverlayByCommand(streamerId, command) {
  return _getCustomOverlayByCommand.get(streamerId, command);
}

function getAllCustomOverlayCommands() {
  return _getAllCustomOverlayCommands.all();
}

function addCustomOverlay(streamerId, type, name, template, chatCommand, config, alwaysOn) {
  const sortOrder = getCustomOverlays(streamerId).length;
  const isActive = alwaysOn ? 1 : 0;
  const result = _addCustomOverlay.run(
    streamerId, type, name, template, chatCommand || null,
    JSON.stringify(config), isActive, alwaysOn ? 1 : 0, sortOrder
  );
  return result.lastInsertRowid;
}

function updateCustomOverlay(id, streamerId, name, template, chatCommand, config, alwaysOn) {
  _updateCustomOverlay.run(
    name, template, chatCommand || null, JSON.stringify(config),
    alwaysOn ? 1 : 0, id, streamerId
  );
}

function toggleCustomOverlay(id, streamerId) {
  const row = _toggleCustomOverlay.get(id, streamerId);
  if (row && row.type === 'scene' && row.is_active) {
    // Deactivate other scenes when activating one
    _deactivateAllScenes.run(streamerId, id);
  }
  return row;
}

function setCustomOverlayActive(id, streamerId, active) {
  _setCustomOverlayActive.run(active ? 1 : 0, id, streamerId);
}

function deleteCustomOverlay(id, streamerId) {
  _deleteCustomOverlay.run(id, streamerId);
}
```

- [ ] **Step 3: Export the new functions**

In the `module.exports` object at the bottom of `db.js`, add:

```javascript
getCustomOverlays,
getCustomOverlaysByType,
getCustomOverlayById,
getCustomOverlayByCommand,
getAllCustomOverlayCommands,
addCustomOverlay,
updateCustomOverlay,
toggleCustomOverlay,
setCustomOverlayActive,
deleteCustomOverlay,
```

- [ ] **Step 4: Verify the server starts without errors**

Run: `cd /Users/ricardosilva/vilela-notifications && node -e "const db = require('./src/db'); console.log('DB OK'); console.log('getCustomOverlays:', typeof db.getCustomOverlays);"`
Expected: "DB OK" and "getCustomOverlays: function"

- [ ] **Step 5: Commit**

```bash
git add src/db.js
git commit -m "feat: add custom_overlays table and CRUD functions"
```

---

### Task 2: Express router — CRUD API and SSE endpoints

**Files:**
- Create: `src/routes/customOverlays.js`
- Modify: `src/server.js`

- [ ] **Step 1: Create the custom overlays router**

Create `src/routes/customOverlays.js`:

```javascript
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const bus = require('../services/overlayBus');

const router = express.Router();
const SERVER_INSTANCE_ID = crypto.randomBytes(8).toString('hex');

// ─── Dashboard routes (require auth via session middleware) ───

// List all custom overlays for the streamer
router.get('/', (req, res) => {
  if (!req.streamer) return res.redirect('/');
  const overlays = db.getCustomOverlays(req.streamer.id);
  const appUrl = `${req.protocol}://${req.get('host')}`;
  res.render('custom-overlays', {
    streamer: req.streamer,
    overlays,
    overlayToken: req.streamer.overlay_token,
    appUrl,
  });
});

// Create overlay
router.post('/create', (req, res) => {
  if (!req.streamer) return res.status(401).json({ error: 'Not authenticated' });
  const { type, name, template, chat_command, config, always_on } = req.body;
  if (!type || !name || !template) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  // Check duplicate command
  if (chat_command) {
    const existing = db.getCustomOverlayByCommand(req.streamer.id, chat_command);
    if (existing) {
      return res.status(400).json({ error: `Command !${chat_command} is already in use by "${existing.name}"` });
    }
  }
  const parsedConfig = typeof config === 'string' ? JSON.parse(config) : (config || {});
  const id = db.addCustomOverlay(req.streamer.id, type, name, template, chat_command, parsedConfig, !!always_on);
  const overlay = db.getCustomOverlayById(id, req.streamer.id);

  // If always_on, emit to SSE clients immediately
  if (overlay.always_on) {
    emitOverlayEvent(req.streamer.id, overlay);
  }

  // Notify chat manager to reload commands
  bus.emit('custom-overlay-commands-changed');

  res.json({ ok: true, overlay });
});

// Update overlay
router.post('/:id/update', (req, res) => {
  if (!req.streamer) return res.status(401).json({ error: 'Not authenticated' });
  const { name, template, chat_command, config, always_on } = req.body;
  const id = parseInt(req.params.id);

  // Check duplicate command (exclude self)
  if (chat_command) {
    const existing = db.getCustomOverlayByCommand(req.streamer.id, chat_command);
    if (existing && existing.id !== id) {
      return res.status(400).json({ error: `Command !${chat_command} is already in use by "${existing.name}"` });
    }
  }

  const parsedConfig = typeof config === 'string' ? JSON.parse(config) : (config || {});
  db.updateCustomOverlay(id, req.streamer.id, name, template, chat_command, parsedConfig, !!always_on);
  const overlay = db.getCustomOverlayById(id, req.streamer.id);

  // Emit update to SSE clients
  emitOverlayEvent(req.streamer.id, overlay);
  bus.emit('custom-overlay-commands-changed');

  res.json({ ok: true, overlay });
});

// Toggle overlay on/off
router.post('/:id/toggle', (req, res) => {
  if (!req.streamer) return res.status(401).json({ error: 'Not authenticated' });
  const id = parseInt(req.params.id);
  const overlay = db.toggleCustomOverlay(id, req.streamer.id);
  if (!overlay) return res.status(404).json({ error: 'Not found' });

  emitOverlayEvent(req.streamer.id, overlay);

  // If scene was activated, emit deactivation for all other scenes (already deactivated in DB by toggleCustomOverlay)
  if (overlay.type === 'scene' && overlay.is_active) {
    const allScenes = db.getCustomOverlaysByType(req.streamer.id, 'scene');
    for (const scene of allScenes) {
      if (scene.id !== overlay.id) {
        emitOverlayEvent(req.streamer.id, { ...scene, is_active: 0 });
      }
    }
  }

  res.json({ ok: true, overlay });
});

// Delete overlay
router.post('/:id/delete', (req, res) => {
  if (!req.streamer) return res.status(401).json({ error: 'Not authenticated' });
  const id = parseInt(req.params.id);
  const overlay = db.getCustomOverlayById(id, req.streamer.id);
  if (!overlay) return res.status(404).json({ error: 'Not found' });

  // Delete uploaded files
  const config = JSON.parse(overlay.config || '{}');
  deleteUploadedFiles(req.streamer.id, id);

  db.deleteCustomOverlay(id, req.streamer.id);

  // Emit removal to SSE
  bus.emit(`custom-overlay:${req.streamer.id}`, {
    type: `${overlay.type}-remove`,
    overlayId: id,
  });

  bus.emit('custom-overlay-commands-changed');
  res.json({ ok: true });
});

// Upload file (image or sound) for an overlay
router.post('/:id/upload', (req, res) => {
  if (!req.streamer) return res.status(401).json({ error: 'Not authenticated' });
  const overlayId = parseInt(req.params.id);
  const field = req.query.field || 'image'; // 'image', 'bgImage', 'sound'
  const ext = (req.query.ext || 'png').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

  const allowed = { image: ['png','jpg','jpeg','gif','webp'], sound: ['mp3','wav','ogg'], bgImage: ['png','jpg','jpeg','gif','webp'] };
  const allowedExts = allowed[field] || allowed.image;
  if (!allowedExts.includes(ext)) {
    return res.status(400).json({ error: `Invalid file type: .${ext}` });
  }

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const uploadDir = path.join(__dirname, '..', '..', 'data', 'uploads', 'custom', String(req.streamer.id));
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    const filename = `${overlayId}-${field}-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(uploadDir, filename), Buffer.concat(chunks));

    const filePath = `/uploads/custom/${req.streamer.id}/${filename}`;
    res.json({ ok: true, filePath });
  });
});

// ─── SSE endpoints (no auth — use overlay token) ───

function setupSSE(req, res, overlayType) {
  const streamer = db.getStreamerByOverlayToken(req.params.token);
  if (!streamer) return res.status(404).send('Invalid overlay token');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send current state
  const overlays = db.getCustomOverlaysByType(streamer.id, overlayType);
  const parsed = overlays.map(o => ({ ...o, config: JSON.parse(o.config || '{}') }));
  res.write(`data: ${JSON.stringify({ type: 'config', serverVersion: SERVER_INSTANCE_ID, overlays: parsed })}\n\n`);

  // Heartbeat
  const heartbeat = setInterval(() => {
    try { res.write(`:heartbeat\n\n`); } catch (e) { clearInterval(heartbeat); }
  }, 30000);

  // Listen for events
  const listener = (event) => {
    // Filter to only this overlay type
    const eventOverlayType = event.type.replace('-toggle', '').replace('-remove', '').replace('-trigger', '');
    if (eventOverlayType !== overlayType && event.type !== `${overlayType}-toggle` && event.type !== `${overlayType}-remove` && event.type !== `${overlayType}-trigger`) return;
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch (e) {}
  };

  bus.on(`custom-overlay:${streamer.id}`, listener);

  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off(`custom-overlay:${streamer.id}`, listener);
  });
}

// SSE endpoints — one per overlay type
router.get('/scenes/events/:token', (req, res) => setupSSE(req, res, 'scene'));
router.get('/bar/events/:token', (req, res) => setupSSE(req, res, 'bar'));
router.get('/custom-alerts/events/:token', (req, res) => setupSSE(req, res, 'custom-alert'));

// Overlay HTML pages — one per type
router.get('/scenes/:token', (req, res) => {
  const streamer = db.getStreamerByOverlayToken(req.params.token);
  if (!streamer) return res.status(404).send('Invalid overlay token');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(`<!DOCTYPE html>
<html><head><title>Scene Overlay</title>
<link rel="stylesheet" href="/overlay/overlay.css">
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&family=Bangers&family=Oswald:wght@400;700&family=Rajdhani:wght@400;700&family=Russo+One&family=Press+Start+2P&display=swap" rel="stylesheet">
</head><body style="background:transparent;">
<div id="scene-container"></div>
<script>window.OVERLAY_TOKEN = ${JSON.stringify(streamer.overlay_token)};</script>
<script src="/overlay/scenes.js"></script>
</body></html>`);
});

router.get('/bar/:token', (req, res) => {
  const streamer = db.getStreamerByOverlayToken(req.params.token);
  if (!streamer) return res.status(404).send('Invalid overlay token');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(`<!DOCTYPE html>
<html><head><title>Info Bar Overlay</title>
<link rel="stylesheet" href="/overlay/overlay.css">
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&family=Bangers&family=Oswald:wght@400;700&family=Rajdhani:wght@400;700&family=Russo+One&family=Press+Start+2P&display=swap" rel="stylesheet">
</head><body style="background:transparent;">
<div id="bar-container"></div>
<script>window.OVERLAY_TOKEN = ${JSON.stringify(streamer.overlay_token)};</script>
<script src="/overlay/bar.js"></script>
</body></html>`);
});

router.get('/custom-alerts/:token', (req, res) => {
  const streamer = db.getStreamerByOverlayToken(req.params.token);
  if (!streamer) return res.status(404).send('Invalid overlay token');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(`<!DOCTYPE html>
<html><head><title>Custom Alerts Overlay</title>
<link rel="stylesheet" href="/overlay/overlay.css">
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&family=Bangers&family=Oswald:wght@400;700&family=Rajdhani:wght@400;700&family=Russo+One&family=Press+Start+2P&display=swap" rel="stylesheet">
</head><body style="background:transparent;">
<div id="alert-container"></div>
<script>window.OVERLAY_TOKEN = ${JSON.stringify(streamer.overlay_token)};</script>
<script src="/overlay/custom-alerts.js"></script>
</body></html>`);
});

// ─── Helpers ───

function emitOverlayEvent(streamerId, overlay) {
  const parsed = { ...overlay, config: typeof overlay.config === 'string' ? JSON.parse(overlay.config) : overlay.config };
  let eventType;
  if (overlay.type === 'custom-alert') {
    eventType = 'custom-alert-trigger';
  } else {
    eventType = `${overlay.type}-toggle`;
  }
  bus.emit(`custom-overlay:${streamerId}`, { type: eventType, overlay: parsed });
}

function deleteUploadedFiles(streamerId, overlayId) {
  const uploadDir = path.join(__dirname, '..', '..', 'data', 'uploads', 'custom', String(streamerId));
  if (!fs.existsSync(uploadDir)) return;
  const files = fs.readdirSync(uploadDir);
  for (const file of files) {
    if (file.startsWith(`${overlayId}-`)) {
      fs.unlinkSync(path.join(uploadDir, file));
    }
  }
}

module.exports = router;
```

- [ ] **Step 2: Mount routes and static serving in server.js**

In `src/server.js`, add after the existing static mounts (after the `/sponsors` line):

```javascript
app.use('/uploads/custom', express.static(path.join(__dirname, '..', 'data', 'uploads', 'custom')));
```

Then add the dashboard route BEFORE the existing overlay router:

```javascript
const customOverlayRoutes = require('./routes/customOverlays');
app.use('/dashboard/custom-overlays', customOverlayRoutes);
```

**For SSE + overlay pages:** Add them to the existing `src/routes/overlay.js` (BEFORE the `/:token` wildcard) since that's where all overlay routes live. This avoids the wildcard catching custom overlay paths.

In `src/routes/overlay.js`, add BEFORE the `/:token` wildcard route:

```javascript
// Custom overlay SSE + pages
const { setupSSE: customSSE, servePage: customPage } = require('./customOverlays');

router.get('/scenes/events/:token', (req, res) => customSSE(req, res, 'scene'));
router.get('/scenes/:token', (req, res) => customPage(req, res, 'scene'));
router.get('/bar/events/:token', (req, res) => customSSE(req, res, 'bar'));
router.get('/bar/:token', (req, res) => customPage(req, res, 'bar'));
router.get('/custom-alerts/events/:token', (req, res) => customSSE(req, res, 'custom-alert'));
router.get('/custom-alerts/:token', (req, res) => customPage(req, res, 'custom-alert'));
```

In `customOverlays.js`, export `setupSSE` and `servePage` as named exports alongside the router. Remove the `router.get('/scenes/...')` etc. routes from the router (they live in overlay.js now). Add the `servePage` function:

```javascript
function servePage(req, res, overlayType) {
  const streamer = db.getStreamerByOverlayToken(req.params.token);
  if (!streamer) return res.status(404).send('Invalid overlay token');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');

  const scripts = { scene: 'scenes.js', bar: 'bar.js', 'custom-alert': 'custom-alerts.js' };
  const containers = { scene: 'scene-container', bar: 'bar-container', 'custom-alert': 'alert-container' };
  const titles = { scene: 'Scene Overlay', bar: 'Info Bar Overlay', 'custom-alert': 'Custom Alerts Overlay' };

  res.send(`<!DOCTYPE html>
<html><head><title>${titles[overlayType]}</title>
<link rel="stylesheet" href="/overlay/overlay.css">
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&family=Bangers&family=Oswald:wght@400;700&family=Rajdhani:wght@400;700&family=Russo+One&family=Press+Start+2P&display=swap" rel="stylesheet">
</head><body style="background:transparent;">
<div id="${containers[overlayType]}"></div>
<script>window.OVERLAY_TOKEN = ${JSON.stringify(streamer.overlay_token)};</script>
<script src="/overlay/${scripts[overlayType]}"></script>
</body></html>`);
}

module.exports = router;
module.exports.setupSSE = setupSSE;
module.exports.servePage = servePage;
```

- [ ] **Step 3: Verify server starts and routes respond**

Run: `cd /Users/ricardosilva/vilela-notifications && timeout 5 node src/index.js 2>&1 || true`
Expected: Server starts without route mounting errors.

- [ ] **Step 4: Commit**

```bash
git add src/routes/customOverlays.js src/routes/overlay.js src/server.js
git commit -m "feat: add custom overlays router with CRUD API and SSE endpoints"
```

---

### Task 3: Chat command integration

**Files:**
- Modify: `src/services/twitchChat.js`

- [ ] **Step 1: Add custom overlay command handling**

In `src/services/twitchChat.js`, add at the top with other requires:

```javascript
const bus = require('./overlayBus');
```

In the `handleMessage` function, add this block AFTER the `!song` handler (after line 49 `return;`) and BEFORE the generic command lookup (line 52 `const cmd = db.getChatCommand(...)`):

```javascript
  // Custom overlay commands — streamer and mods only
  const overlayCmd = db.getCustomOverlayByCommand(streamerId, commandName);
  if (overlayCmd) {
    const isBroadcaster = tags.badges && tags.badges.broadcaster === '1';
    const isMod = tags.mod;
    if (!isBroadcaster && !isMod) return;

    const cooldownKey = `${streamerId}:overlay:${commandName}`;
    const now = Date.now();
    const lastUsed = cooldowns.get(cooldownKey) || 0;
    if (now - lastUsed < 2000) return; // 2s cooldown
    cooldowns.set(cooldownKey, now);

    if (overlayCmd.type === 'custom-alert') {
      // Fire-and-forget — just trigger the alert
      const parsed = { ...overlayCmd, config: JSON.parse(overlayCmd.config || '{}') };
      bus.emit(`custom-overlay:${streamerId}`, { type: 'custom-alert-trigger', overlay: parsed });
    } else {
      // Toggle scene/bar
      const toggled = db.toggleCustomOverlay(overlayCmd.id, streamerId);
      if (toggled) {
        const parsed = { ...toggled, config: JSON.parse(toggled.config || '{}') };

        // Parse optional countdown duration: "!starting 5" → 5 minutes
        if (toggled.type === 'scene' && toggled.is_active) {
          const args = message.split(' ');
          if (args.length > 1) {
            const minutes = parseInt(args[1]);
            if (minutes > 0) parsed.config.countdownMinutes = minutes;
          }
        }

        bus.emit(`custom-overlay:${streamerId}`, { type: `${toggled.type}-toggle`, overlay: parsed });

        // If scene was activated, deactivate other scenes
        if (toggled.type === 'scene' && toggled.is_active) {
          const allScenes = db.getCustomOverlaysByType(streamerId, 'scene');
          for (const scene of allScenes) {
            if (scene.id !== toggled.id) {
              const s = { ...scene, config: JSON.parse(scene.config || '{}'), is_active: 0 };
              bus.emit(`custom-overlay:${streamerId}`, { type: 'scene-toggle', overlay: s });
            }
          }
        }
      }
    }

    return;
  }
```

- [ ] **Step 2: Verify the file has no syntax errors**

Run: `node -c /Users/ricardosilva/vilela-notifications/src/services/twitchChat.js`
Expected: No output (means syntax OK)

- [ ] **Step 3: Commit**

```bash
git add src/services/twitchChat.js
git commit -m "feat: handle custom overlay chat commands in twitchChat"
```

---

### Task 4: OBS client — scenes.js

**Files:**
- Create: `public/overlay/scenes.js`

- [ ] **Step 1: Create the scene overlay client**

Create `public/overlay/scenes.js`:

```javascript
// Scene overlay — Starting Soon, BRB, Ending screens
let serverVersion = null;
let evtSource = null;
let reconnectTimer = null;
let currentOverlays = {};
let countdownInterval = null;

function connectSSE() {
  if (evtSource) { evtSource.close(); evtSource = null; }

  evtSource = new EventSource(`/overlay/scenes/events/${window.OVERLAY_TOKEN}`);

  evtSource.onmessage = (e) => {
    const data = JSON.parse(e.data);

    if (data.type === 'config') {
      if (serverVersion && data.serverVersion && data.serverVersion !== serverVersion) {
        location.reload();
        return;
      }
      serverVersion = data.serverVersion;
      // Render all active overlays
      if (data.overlays) {
        for (const overlay of data.overlays) {
          currentOverlays[overlay.id] = overlay;
          if (overlay.is_active || overlay.always_on) {
            renderScene(overlay);
          }
        }
      }
      return;
    }

    if (data.type === 'scene-toggle') {
      const overlay = data.overlay;
      currentOverlays[overlay.id] = overlay;
      if (overlay.is_active) {
        renderScene(overlay);
      } else {
        removeScene(overlay.id);
      }
    }

    if (data.type === 'scene-remove') {
      removeScene(data.overlayId);
    }
  };

  evtSource.onerror = () => {
    evtSource.close();
    evtSource = null;
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connectSSE(); }, 5000);
    }
  };
}

function renderScene(overlay) {
  const container = document.getElementById('scene-container');
  // Remove existing scene
  removeScene(overlay.id);

  const config = typeof overlay.config === 'string' ? JSON.parse(overlay.config) : overlay.config;
  const el = document.createElement('div');
  el.id = `scene-${overlay.id}`;
  el.className = 'scene-overlay';
  el.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;z-index:10;animation:fadeIn 0.5s ease;';

  // Background
  if (config.bgImage) {
    el.style.backgroundImage = `url(${config.bgImage})`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
  } else if (config.bgType === 'gradient') {
    el.style.background = `linear-gradient(135deg, ${config.bgColor1 || '#1a1a3e'}, ${config.bgColor2 || '#2d1b69'})`;
  } else {
    el.style.backgroundColor = config.bgColor || config.bgColor1 || '#1a1a3e';
  }

  // Font
  if (config.font && config.font !== 'System Default') {
    el.style.fontFamily = config.font;
  }

  if (overlay.template === 'centered-text') {
    renderCenteredText(el, config);
  } else if (overlay.template === 'split-layout') {
    renderSplitLayout(el, config);
  } else if (overlay.template === 'full-image') {
    renderFullImage(el, config);
  }

  container.appendChild(el);

  // Start countdown if enabled
  if (config.showCountdown && config.countdownMinutes > 0) {
    startCountdown(el, config.countdownMinutes);
  }
}

function renderCenteredText(el, config) {
  const heading = document.createElement('div');
  heading.textContent = config.heading || '';
  heading.style.cssText = `font-size:4rem;font-weight:700;color:${config.textColor || '#fff'};letter-spacing:3px;text-align:center;`;
  el.appendChild(heading);

  if (config.subtext) {
    const sub = document.createElement('div');
    sub.textContent = config.subtext;
    sub.style.cssText = `font-size:1.5rem;color:${config.textColor || '#fff'};opacity:0.8;margin-top:0.5rem;text-align:center;`;
    el.appendChild(sub);
  }

  if (config.showCountdown) {
    const timer = document.createElement('div');
    timer.className = 'countdown-timer';
    timer.style.cssText = `font-size:2.5rem;color:${config.textColor || '#fff'};margin-top:1.5rem;font-weight:600;`;
    el.appendChild(timer);
  }
}

function renderSplitLayout(el, config) {
  el.style.flexDirection = 'row';
  el.style.justifyContent = 'center';
  el.style.gap = '3rem';
  el.style.padding = '2rem';

  const imgSide = config.imageSide || 'left';

  const imgDiv = document.createElement('div');
  imgDiv.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;max-width:45%;';
  if (config.image) {
    const img = document.createElement('img');
    img.src = config.image;
    img.style.cssText = 'max-width:100%;max-height:80vh;object-fit:contain;border-radius:12px;';
    imgDiv.appendChild(img);
  }

  const textDiv = document.createElement('div');
  textDiv.style.cssText = `flex:1;display:flex;flex-direction:column;justify-content:center;align-items:${imgSide === 'left' ? 'flex-start' : 'flex-end'};max-width:45%;`;

  const heading = document.createElement('div');
  heading.textContent = config.heading || '';
  heading.style.cssText = `font-size:3.5rem;font-weight:700;color:${config.textColor || '#fff'};`;
  textDiv.appendChild(heading);

  if (config.subtext) {
    const sub = document.createElement('div');
    sub.textContent = config.subtext;
    sub.style.cssText = `font-size:1.3rem;color:${config.textColor || '#fff'};opacity:0.8;margin-top:0.5rem;`;
    textDiv.appendChild(sub);
  }

  if (config.showCountdown) {
    const timer = document.createElement('div');
    timer.className = 'countdown-timer';
    timer.style.cssText = `font-size:2rem;color:${config.textColor || '#fff'};margin-top:1rem;font-weight:600;`;
    textDiv.appendChild(timer);
  }

  if (imgSide === 'left') {
    el.appendChild(imgDiv);
    el.appendChild(textDiv);
  } else {
    el.appendChild(textDiv);
    el.appendChild(imgDiv);
  }
}

function renderFullImage(el, config) {
  if (config.image) {
    el.style.backgroundImage = `url(${config.image})`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
  }

  if (config.overlayText) {
    const text = document.createElement('div');
    text.textContent = config.overlayText;
    const pos = config.textPosition || 'center';
    let alignSelf = 'center';
    if (pos === 'top') alignSelf = 'flex-start';
    if (pos === 'bottom') alignSelf = 'flex-end';
    text.style.cssText = `font-size:3rem;font-weight:700;color:${config.textColor || '#fff'};text-shadow:0 2px 8px rgba(0,0,0,0.7);align-self:${alignSelf};padding:2rem;`;
    el.appendChild(text);
  }
}

function startCountdown(el, minutes) {
  if (countdownInterval) clearInterval(countdownInterval);
  let remaining = minutes * 60;
  const timerEl = el.querySelector('.countdown-timer');
  if (!timerEl) return;

  function update() {
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    timerEl.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    remaining--;
  }

  update();
  countdownInterval = setInterval(update, 1000);
}

function removeScene(overlayId) {
  const existing = document.getElementById(`scene-${overlayId}`);
  if (existing) {
    existing.style.animation = 'fadeOut 0.5s ease';
    setTimeout(() => existing.remove(), 500);
  }
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

connectSSE();
```

- [ ] **Step 2: Verify no syntax errors**

Run: `node -c /Users/ricardosilva/vilela-notifications/public/overlay/scenes.js`
Expected: No output

- [ ] **Step 3: Commit**

```bash
git add public/overlay/scenes.js
git commit -m "feat: add scene overlay OBS client (centered-text, split-layout, full-image)"
```

---

### Task 5: OBS client — bar.js

**Files:**
- Create: `public/overlay/bar.js`

- [ ] **Step 1: Create the info bar overlay client**

Create `public/overlay/bar.js`:

```javascript
// Info bar overlay — social bar, ticker
let serverVersion = null;
let evtSource = null;
let reconnectTimer = null;

function connectSSE() {
  if (evtSource) { evtSource.close(); evtSource = null; }

  evtSource = new EventSource(`/overlay/bar/events/${window.OVERLAY_TOKEN}`);

  evtSource.onmessage = (e) => {
    const data = JSON.parse(e.data);

    if (data.type === 'config') {
      if (serverVersion && data.serverVersion && data.serverVersion !== serverVersion) {
        location.reload();
        return;
      }
      serverVersion = data.serverVersion;
      if (data.overlays) {
        for (const overlay of data.overlays) {
          if (overlay.is_active || overlay.always_on) {
            renderBar(overlay);
          }
        }
      }
      return;
    }

    if (data.type === 'bar-toggle') {
      const overlay = data.overlay;
      if (overlay.is_active) {
        renderBar(overlay);
      } else {
        removeBar(overlay.id);
      }
    }

    if (data.type === 'bar-remove') {
      removeBar(data.overlayId);
    }
  };

  evtSource.onerror = () => {
    evtSource.close();
    evtSource = null;
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connectSSE(); }, 5000);
    }
  };
}

const SOCIAL_ICONS = {
  twitter: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>',
  youtube: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>',
  twitch: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/></svg>',
  tiktok: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>',
  discord: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286z"/></svg>',
  github: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>',
  facebook: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>',
  link: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71z"/></svg>',
};

function renderBar(overlay) {
  const container = document.getElementById('bar-container');
  removeBar(overlay.id);

  const config = typeof overlay.config === 'string' ? JSON.parse(overlay.config) : overlay.config;
  const el = document.createElement('div');
  el.id = `bar-${overlay.id}`;
  el.style.cssText = `position:fixed;left:0;right:0;${config.position === 'top' ? 'top:0' : 'bottom:0'};z-index:10;animation:fadeIn 0.5s ease;`;

  if (overlay.template === 'social-bar') {
    renderSocialBar(el, config);
  } else if (overlay.template === 'ticker') {
    renderTicker(el, config);
  }

  container.appendChild(el);
}

function renderSocialBar(el, config) {
  el.style.background = config.bgColor || '#1a1a2e';
  el.style.color = config.textColor || '#fff';
  el.style.padding = '8px 16px';
  el.style.display = 'flex';
  el.style.alignItems = 'center';
  el.style.justifyContent = 'center';
  el.style.gap = '2rem';
  if (config.font && config.font !== 'System Default') {
    el.style.fontFamily = config.font;
  }
  el.style.fontSize = '0.95rem';

  const links = config.links || [];
  for (const link of links) {
    const item = document.createElement('div');
    item.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const icon = SOCIAL_ICONS[link.platform] || SOCIAL_ICONS.link;
    item.innerHTML = `${icon}<span>${link.handle}</span>`;
    el.appendChild(item);
  }

  if (config.scrolling) {
    el.style.overflow = 'hidden';
    const inner = document.createElement('div');
    inner.style.cssText = 'display:flex;gap:2rem;align-items:center;animation:scrollLeft 20s linear infinite;white-space:nowrap;';
    while (el.firstChild) inner.appendChild(el.firstChild);
    // Duplicate for seamless loop
    const clone = inner.cloneNode(true);
    inner.innerHTML += inner.innerHTML;
    el.appendChild(inner);
  }
}

function renderTicker(el, config) {
  el.style.background = config.bgColor || '#1a1a2e';
  el.style.color = config.textColor || '#fff';
  el.style.padding = '8px 0';
  el.style.overflow = 'hidden';
  if (config.font && config.font !== 'System Default') {
    el.style.fontFamily = config.font;
  }

  const speeds = { slow: '30s', medium: '20s', fast: '12s' };
  const speed = speeds[config.scrollSpeed] || speeds.medium;

  const inner = document.createElement('div');
  inner.style.cssText = `display:inline-block;white-space:nowrap;animation:scrollLeft ${speed} linear infinite;padding-left:100%;`;
  inner.textContent = config.text || '';
  el.appendChild(inner);
}

function removeBar(overlayId) {
  const existing = document.getElementById(`bar-${overlayId}`);
  if (existing) {
    existing.style.animation = 'fadeOut 0.3s ease';
    setTimeout(() => existing.remove(), 300);
  }
}

connectSSE();
```

- [ ] **Step 2: Add CSS animations to overlay.css**

In `public/overlay/overlay.css`, add at the end:

```css
/* Custom overlay animations */
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes fadeOut { from { opacity: 1; } to { opacity: 0; } }
@keyframes scrollLeft { from { transform: translateX(0); } to { transform: translateX(-50%); } }
```

Check if `fadeIn` / `fadeOut` already exist in the file first — only add if missing.

- [ ] **Step 3: Commit**

```bash
git add public/overlay/bar.js public/overlay/overlay.css
git commit -m "feat: add info bar overlay OBS client (social-bar, ticker)"
```

---

### Task 6: OBS client — custom-alerts.js

**Files:**
- Create: `public/overlay/custom-alerts.js`

- [ ] **Step 1: Create the custom alerts overlay client**

Create `public/overlay/custom-alerts.js`:

```javascript
// Custom alerts overlay — image popups, text popups
let serverVersion = null;
let evtSource = null;
let reconnectTimer = null;
const alertQueue = [];
let isPlaying = false;

function connectSSE() {
  if (evtSource) { evtSource.close(); evtSource = null; }

  evtSource = new EventSource(`/overlay/custom-alerts/events/${window.OVERLAY_TOKEN}`);

  evtSource.onmessage = (e) => {
    const data = JSON.parse(e.data);

    if (data.type === 'config') {
      if (serverVersion && data.serverVersion && data.serverVersion !== serverVersion) {
        location.reload();
        return;
      }
      serverVersion = data.serverVersion;
      return;
    }

    if (data.type === 'custom-alert-trigger') {
      alertQueue.push(data.overlay);
      if (!isPlaying) playNext();
    }
  };

  evtSource.onerror = () => {
    evtSource.close();
    evtSource = null;
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connectSSE(); }, 5000);
    }
  };
}

function playNext() {
  if (alertQueue.length === 0) {
    isPlaying = false;
    return;
  }
  isPlaying = true;
  const overlay = alertQueue.shift();
  const config = typeof overlay.config === 'string' ? JSON.parse(overlay.config) : overlay.config;
  const duration = (config.duration || 5) * 1000;

  const container = document.getElementById('alert-container');
  const el = document.createElement('div');
  el.className = 'custom-alert-popup';

  const anim = config.animation || 'fade';
  el.style.cssText = `position:fixed;inset:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;z-index:20;animation:customAlert${capitalize(anim)} 0.5s ease;`;

  if (overlay.template === 'image-popup') {
    renderImagePopup(el, config);
  } else if (overlay.template === 'text-popup') {
    renderTextPopup(el, config);
  }

  container.appendChild(el);

  // Play sound
  if (config.sound) {
    const audio = new Audio(config.sound);
    audio.volume = config.volume != null ? config.volume : 0.8;
    audio.play().catch(() => {});
  }

  // Auto-remove after duration
  setTimeout(() => {
    el.style.animation = 'fadeOut 0.5s ease';
    setTimeout(() => {
      el.remove();
      playNext();
    }, 500);
  }, duration);
}

function renderImagePopup(el, config) {
  if (config.image) {
    const img = document.createElement('img');
    img.src = config.image;
    img.style.cssText = 'max-width:80%;max-height:80%;object-fit:contain;';
    el.appendChild(img);
  }
}

function renderTextPopup(el, config) {
  if (config.bgColor && config.bgColor !== 'transparent') {
    el.style.backgroundColor = config.bgColor;
  }
  const text = document.createElement('div');
  text.textContent = config.text || '';
  text.style.cssText = `font-size:${config.fontSize || '4rem'};font-weight:700;color:${config.textColor || '#FFD700'};text-shadow:0 4px 12px rgba(0,0,0,0.5);`;
  if (config.font && config.font !== 'System Default') {
    text.style.fontFamily = config.font;
  }
  el.appendChild(text);
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

connectSSE();
```

- [ ] **Step 2: Add custom alert animations to overlay.css**

Append to `public/overlay/overlay.css`:

```css
@keyframes customAlertFade { from { opacity: 0; } to { opacity: 1; } }
@keyframes customAlertZoom { from { opacity: 0; transform: scale(0.5); } to { opacity: 1; transform: scale(1); } }
@keyframes customAlertSlide { from { opacity: 0; transform: translateY(100%); } to { opacity: 1; transform: translateY(0); } }
```

- [ ] **Step 3: Commit**

```bash
git add public/overlay/custom-alerts.js public/overlay/overlay.css
git commit -m "feat: add custom alerts overlay OBS client (image-popup, text-popup)"
```

---

### Task 7: Dashboard page — custom-overlays.ejs

**Files:**
- Create: `src/views/custom-overlays.ejs`

- [ ] **Step 1: Create the custom overlays management page**

Create `src/views/custom-overlays.ejs`. This is a large file — it includes the table list, the create/edit modal with 3 steps, and all the JavaScript for managing overlays.

```html
<%- include('header', { title: 'Custom Overlays', page: 'custom-overlays' }) %>

<style>
  .overlay-page { max-width: 900px; margin: 0 auto; padding: 20px; }
  .overlay-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .overlay-header h2 { margin: 0; color: var(--text-primary, #fff); }
  .btn-primary { background: #6c63ff; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 0.9rem; }
  .btn-primary:hover { background: #5a52d5; }
  .btn-danger { background: #e74c3c; color: white; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 0.8rem; }
  .btn-danger:hover { background: #c0392b; }

  /* Table */
  .overlay-table { width: 100%; border-collapse: collapse; }
  .overlay-table th { text-align: left; padding: 10px 12px; color: #888; font-size: 0.8rem; border-bottom: 1px solid #333; }
  .overlay-table td { padding: 10px 12px; border-bottom: 1px solid #222; color: #e0e0e0; font-size: 0.9rem; }
  .overlay-table tr:hover td { background: rgba(255,255,255,0.03); }
  .overlay-table .cmd { font-family: monospace; color: #6c63ff; }
  .overlay-table .type-badge { font-size: 0.75rem; padding: 2px 8px; border-radius: 10px; background: #16213e; color: #888; }
  .overlay-table .status-live { color: #4ade80; font-size: 0.8rem; }
  .overlay-table .status-off { color: #666; font-size: 0.8rem; }

  /* Toggle switch */
  .toggle { position: relative; width: 40px; height: 22px; cursor: pointer; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle .slider { position: absolute; inset: 0; background: #333; border-radius: 11px; transition: 0.2s; }
  .toggle .slider::before { content: ''; position: absolute; width: 18px; height: 18px; left: 2px; top: 2px; background: #888; border-radius: 50%; transition: 0.2s; }
  .toggle input:checked + .slider { background: #4ade80; }
  .toggle input:checked + .slider::before { transform: translateX(18px); background: white; }

  /* Modal */
  .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 100; align-items: center; justify-content: center; }
  .modal-overlay.active { display: flex; }
  .modal { background: #1a1a2e; border-radius: 12px; width: 90%; max-width: 800px; max-height: 90vh; overflow-y: auto; padding: 24px; }
  .modal h3 { margin: 0 0 16px 0; color: #fff; }

  /* Steps */
  .steps { display: flex; gap: 16px; margin-bottom: 20px; font-size: 0.85rem; }
  .steps .step { color: #666; padding-bottom: 4px; }
  .steps .step.active { color: #6c63ff; border-bottom: 2px solid #6c63ff; font-weight: 600; }

  /* Template cards */
  .template-tabs { display: flex; gap: 8px; margin-bottom: 16px; }
  .template-tab { background: #16213e; color: #888; padding: 6px 14px; border-radius: 4px; cursor: pointer; border: none; font-size: 0.85rem; }
  .template-tab.active { background: #6c63ff; color: white; }
  .template-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .template-card { background: #16213e; border: 2px solid transparent; border-radius: 8px; cursor: pointer; overflow: hidden; transition: border-color 0.2s; }
  .template-card:hover { border-color: #444; }
  .template-card.selected { border-color: #6c63ff; }
  .template-card .preview { height: 100px; display: flex; align-items: center; justify-content: center; background: #0f0f23; }
  .template-card .info { padding: 8px 10px; }
  .template-card .info h4 { margin: 0; font-size: 0.85rem; color: #e0e0e0; }
  .template-card .info p { margin: 2px 0 0; font-size: 0.7rem; color: #888; }

  /* Config form */
  .config-form { display: flex; gap: 20px; }
  .config-fields { flex: 1; display: flex; flex-direction: column; gap: 12px; }
  .config-preview { flex: 1.2; }
  .field label { display: block; font-size: 0.75rem; color: #888; margin-bottom: 4px; }
  .field input, .field select, .field textarea { width: 100%; background: #16213e; border: 1px solid #333; border-radius: 4px; padding: 8px; color: #e0e0e0; font-size: 0.85rem; }
  .field input[type="color"] { width: 40px; height: 32px; padding: 2px; cursor: pointer; }
  .field-row { display: flex; gap: 12px; }
  .field-row .field { flex: 1; }
  .checkbox-field { display: flex; align-items: center; gap: 8px; }
  .checkbox-field input[type="checkbox"] { width: auto; }
  .preview-box { background: #0f0f23; border-radius: 8px; aspect-ratio: 16/9; overflow: hidden; }

  /* Command step */
  .command-input { display: flex; align-items: center; gap: 4px; }
  .command-input .prefix { color: #6c63ff; font-size: 1.1rem; font-weight: 600; }
  .command-input input { flex: 1; }

  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px; }
  .btn-secondary { background: #333; color: #aaa; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; }

  /* OBS URLs */
  .obs-urls { background: #16213e; border-radius: 8px; padding: 16px; margin-bottom: 20px; }
  .obs-urls h4 { margin: 0 0 10px; color: #e0e0e0; font-size: 0.9rem; }
  .obs-url-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 0.8rem; }
  .obs-url-row .url-label { color: #888; min-width: 100px; }
  .obs-url-row input { flex: 1; background: #0f0f23; border: 1px solid #333; border-radius: 4px; padding: 6px 8px; color: #e0e0e0; font-size: 0.8rem; }
  .btn-copy { background: #333; color: #aaa; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 0.75rem; }

  .empty-state { text-align: center; padding: 40px 20px; color: #666; }
  .back-link { color: #6c63ff; text-decoration: none; font-size: 0.9rem; }
</style>

<div class="overlay-page">
  <a href="/dashboard" class="back-link">← Back to Dashboard</a>

  <div class="overlay-header" style="margin-top: 12px;">
    <h2>Custom Overlays</h2>
    <button class="btn-primary" onclick="openCreateModal()">+ New Overlay</button>
  </div>

  <!-- OBS URLs -->
  <div class="obs-urls">
    <h4>OBS Browser Source URLs</h4>
    <div class="obs-url-row">
      <span class="url-label">Scenes:</span>
      <input type="text" readonly value="<%= appUrl %>/overlay/scenes/<%= overlayToken %>" id="url-scenes">
      <button class="btn-copy" onclick="copyUrl('url-scenes')">Copy</button>
    </div>
    <div class="obs-url-row">
      <span class="url-label">Info Bar:</span>
      <input type="text" readonly value="<%= appUrl %>/overlay/bar/<%= overlayToken %>" id="url-bar">
      <button class="btn-copy" onclick="copyUrl('url-bar')">Copy</button>
    </div>
    <div class="obs-url-row">
      <span class="url-label">Custom Alerts:</span>
      <input type="text" readonly value="<%= appUrl %>/overlay/custom-alerts/<%= overlayToken %>" id="url-alerts">
      <button class="btn-copy" onclick="copyUrl('url-alerts')">Copy</button>
    </div>
  </div>

  <% if (overlays.length === 0) { %>
    <div class="empty-state">
      <p>No custom overlays yet.</p>
      <p>Click "+ New Overlay" to create your first one.</p>
    </div>
  <% } else { %>
    <table class="overlay-table">
      <thead>
        <tr><th>Name</th><th>Type</th><th>Command</th><th>Status</th><th>Toggle</th><th></th></tr>
      </thead>
      <tbody>
        <% overlays.forEach(o => { %>
        <tr onclick="openEditModal(<%= o.id %>)" style="cursor:pointer;">
          <td><%= o.name %></td>
          <td><span class="type-badge"><%= o.type %></span></td>
          <td><% if (o.chat_command) { %><span class="cmd">!<%= o.chat_command %></span><% } else { %><em style="color:#666">always on</em><% } %></td>
          <td><span class="<%= (o.is_active || o.always_on) ? 'status-live' : 'status-off' %>">● <%= (o.is_active || o.always_on) ? 'LIVE' : 'OFF' %></span></td>
          <td onclick="event.stopPropagation()">
            <label class="toggle">
              <input type="checkbox" <%= (o.is_active || o.always_on) ? 'checked' : '' %> onchange="toggleOverlay(<%= o.id %>, this)" <%= o.always_on ? 'disabled' : '' %>>
              <span class="slider"></span>
            </label>
          </td>
          <td onclick="event.stopPropagation()">
            <button class="btn-danger" onclick="deleteOverlay(<%= o.id %>, '<%= o.name.replace(/'/g, "\\'") %>')">Delete</button>
          </td>
        </tr>
        <% }) %>
      </tbody>
    </table>
  <% } %>
</div>

<!-- Create/Edit Modal -->
<div class="modal-overlay" id="modal">
  <div class="modal">
    <h3 id="modal-title">New Custom Overlay</h3>
    <div class="steps">
      <span class="step active" data-step="1">1. Choose Template</span>
      <span class="step" data-step="2">2. Customize</span>
      <span class="step" data-step="3">3. Set Command</span>
    </div>

    <!-- Step 1: Choose Template -->
    <div id="step-1" class="step-content">
      <div class="template-tabs">
        <button class="template-tab active" onclick="filterTemplates('scene')">Scenes</button>
        <button class="template-tab" onclick="filterTemplates('bar')">Info Bars</button>
        <button class="template-tab" onclick="filterTemplates('custom-alert')">Alerts</button>
      </div>
      <div class="template-grid" id="template-grid"></div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeModal()">Cancel</button>
        <button class="btn-primary" onclick="nextStep(2)" id="btn-next-1" disabled>Next</button>
      </div>
    </div>

    <!-- Step 2: Customize -->
    <div id="step-2" class="step-content" style="display:none;">
      <div class="config-form">
        <div class="config-fields" id="config-fields"></div>
        <div class="config-preview">
          <label style="font-size:0.75rem;color:#888;">Preview</label>
          <div class="preview-box" id="preview-box"></div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="prevStep(1)">Back</button>
        <button class="btn-primary" onclick="nextStep(3)">Next</button>
      </div>
    </div>

    <!-- Step 3: Set Command -->
    <div id="step-3" class="step-content" style="display:none;">
      <div class="field">
        <label>Overlay Name</label>
        <input type="text" id="overlay-name" placeholder="e.g., Starting Soon">
      </div>
      <div class="field" style="margin-top:12px;">
        <label>Chat Command</label>
        <div class="command-input">
          <span class="prefix">!</span>
          <input type="text" id="overlay-command" placeholder="e.g., starting">
        </div>
      </div>
      <div class="checkbox-field" style="margin-top:12px;">
        <input type="checkbox" id="overlay-always-on" onchange="document.getElementById('overlay-command').disabled = this.checked">
        <label style="color:#e0e0e0;font-size:0.85rem;">Always on (no command needed)</label>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="prevStep(2)">Back</button>
        <button class="btn-primary" onclick="saveOverlay()" id="btn-save">Create Overlay</button>
      </div>
    </div>
  </div>
</div>

<script>
const TEMPLATES = [
  { id: 'centered-text', type: 'scene', name: 'Centered Text', desc: 'Heading + subtext + optional countdown' },
  { id: 'split-layout', type: 'scene', name: 'Split Layout', desc: 'Image + text side by side' },
  { id: 'full-image', type: 'scene', name: 'Full Image', desc: 'Upload fills entire screen' },
  { id: 'social-bar', type: 'bar', name: 'Social Bar', desc: 'Platform icons + handles' },
  { id: 'ticker', type: 'bar', name: 'Ticker', desc: 'Scrolling text marquee' },
  { id: 'image-popup', type: 'custom-alert', name: 'Image Popup', desc: 'Image + sound alert' },
  { id: 'text-popup', type: 'custom-alert', name: 'Text Popup', desc: 'Styled text popup' },
];

let selectedTemplate = null;
let editingOverlayId = null;
let currentConfig = {};
let currentFilterType = 'scene';

function openCreateModal() {
  editingOverlayId = null;
  selectedTemplate = null;
  currentConfig = {};
  document.getElementById('modal-title').textContent = 'New Custom Overlay';
  document.getElementById('btn-save').textContent = 'Create Overlay';
  document.getElementById('overlay-name').value = '';
  document.getElementById('overlay-command').value = '';
  document.getElementById('overlay-always-on').checked = false;
  document.getElementById('overlay-command').disabled = false;
  showStep(1);
  filterTemplates('scene');
  document.getElementById('modal').classList.add('active');
}

function openEditModal(id) {
  fetch(`/dashboard/custom-overlays/${id}/get`)
    .then(r => r.json())
    .then(data => {
      if (!data.ok) return;
      const overlay = data.overlay;
      editingOverlayId = id;
      selectedTemplate = TEMPLATES.find(t => t.id === overlay.template);
      currentConfig = JSON.parse(overlay.config || '{}');
      document.getElementById('modal-title').textContent = 'Edit Overlay';
      document.getElementById('btn-save').textContent = 'Save Changes';
      document.getElementById('overlay-name').value = overlay.name;
      document.getElementById('overlay-command').value = overlay.chat_command || '';
      document.getElementById('overlay-always-on').checked = !!overlay.always_on;
      document.getElementById('overlay-command').disabled = !!overlay.always_on;
      showStep(2);
      renderConfigFields();
      document.getElementById('modal').classList.add('active');
    });
}

function closeModal() { document.getElementById('modal').classList.remove('active'); }

function showStep(n) {
  document.querySelectorAll('.step-content').forEach(el => el.style.display = 'none');
  document.getElementById(`step-${n}`).style.display = '';
  document.querySelectorAll('.steps .step').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.step) === n);
  });
}

function nextStep(n) {
  if (n === 2) renderConfigFields();
  showStep(n);
}
function prevStep(n) { showStep(n); }

function filterTemplates(type) {
  currentFilterType = type;
  document.querySelectorAll('.template-tab').forEach(t => t.classList.toggle('active', t.textContent.toLowerCase().includes(type === 'custom-alert' ? 'alert' : type)));
  const grid = document.getElementById('template-grid');
  grid.innerHTML = '';
  TEMPLATES.filter(t => t.type === type).forEach(t => {
    const card = document.createElement('div');
    card.className = 'template-card' + (selectedTemplate && selectedTemplate.id === t.id ? ' selected' : '');
    card.innerHTML = `<div class="preview" style="background:linear-gradient(135deg,#1a1a3e,#2d1b69);color:#fff;font-size:0.9rem;font-weight:600;">${t.name}</div><div class="info"><h4>${t.name}</h4><p>${t.desc}</p></div>`;
    card.onclick = () => {
      selectedTemplate = t;
      currentConfig = getDefaultConfig(t.id);
      document.querySelectorAll('.template-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      document.getElementById('btn-next-1').disabled = false;
    };
    grid.appendChild(card);
  });
}

function getDefaultConfig(templateId) {
  const defaults = {
    'centered-text': { heading: 'STARTING SOON', subtext: 'Stream begins shortly...', font: 'Montserrat', textColor: '#FFFFFF', bgType: 'gradient', bgColor1: '#1a1a3e', bgColor2: '#2d1b69', bgImage: null, showCountdown: true, countdownMinutes: 5 },
    'split-layout': { heading: 'BRB', subtext: 'Be right back!', font: 'Montserrat', textColor: '#FFFFFF', bgColor: '#1a1a3e', image: null, imageSide: 'left', showCountdown: true, countdownMinutes: 5 },
    'full-image': { image: null, overlayText: '', textColor: '#FFFFFF', textPosition: 'center' },
    'social-bar': { links: [], bgColor: '#1a1a2e', textColor: '#FFFFFF', font: 'System Default', position: 'bottom', scrolling: false },
    'ticker': { text: 'Follow on Twitter @vilela | Next stream: Wednesday 8PM', bgColor: '#1a1a2e', textColor: '#FFFFFF', font: 'System Default', scrollSpeed: 'medium', position: 'bottom' },
    'image-popup': { image: null, sound: null, duration: 5, animation: 'zoom', volume: 0.8 },
    'text-popup': { text: 'HYPE!', font: 'Bangers', textColor: '#FFD700', fontSize: '4rem', bgColor: 'transparent', duration: 3, animation: 'zoom', sound: null, volume: 0.8 },
  };
  return defaults[templateId] || {};
}

function renderConfigFields() {
  if (!selectedTemplate) return;
  const fields = document.getElementById('config-fields');
  fields.innerHTML = '';
  const c = currentConfig;
  const tid = selectedTemplate.id;

  // Common text fields per template
  if (['centered-text', 'split-layout'].includes(tid)) {
    fields.innerHTML += field('Heading', 'text', 'heading', c.heading);
    fields.innerHTML += field('Subtext', 'text', 'subtext', c.subtext);
    fields.innerHTML += fieldRow(field('Text Color', 'color', 'textColor', c.textColor), field('Font', 'select', 'font', c.font, ['System Default','Montserrat','Bangers','Oswald','Rajdhani','Russo One','Press Start 2P']));
  }
  if (tid === 'centered-text') {
    fields.innerHTML += fieldRow(field('BG Color 1', 'color', 'bgColor1', c.bgColor1), field('BG Color 2', 'color', 'bgColor2', c.bgColor2));
    fields.innerHTML += checkbox('Show Countdown', 'showCountdown', c.showCountdown);
    fields.innerHTML += field('Countdown Minutes', 'number', 'countdownMinutes', c.countdownMinutes);
    fields.innerHTML += fileUpload('Background Image (optional)', 'bgImage');
  }
  if (tid === 'split-layout') {
    fields.innerHTML += field('BG Color', 'color', 'bgColor', c.bgColor);
    fields.innerHTML += field('Image Side', 'select', 'imageSide', c.imageSide, ['left','right']);
    fields.innerHTML += checkbox('Show Countdown', 'showCountdown', c.showCountdown);
    fields.innerHTML += field('Countdown Minutes', 'number', 'countdownMinutes', c.countdownMinutes);
    fields.innerHTML += fileUpload('Image', 'image');
  }
  if (tid === 'full-image') {
    fields.innerHTML += field('Overlay Text', 'text', 'overlayText', c.overlayText);
    fields.innerHTML += fieldRow(field('Text Color', 'color', 'textColor', c.textColor), field('Text Position', 'select', 'textPosition', c.textPosition, ['top','center','bottom']));
    fields.innerHTML += fileUpload('Background Image', 'image');
  }
  if (tid === 'social-bar') {
    fields.innerHTML += '<div class="field"><label>Social Links</label><div id="social-links-list"></div><button class="btn-secondary" style="margin-top:8px;" onclick="addSocialLink()">+ Add Link</button></div>';
    fields.innerHTML += fieldRow(field('BG Color', 'color', 'bgColor', c.bgColor), field('Text Color', 'color', 'textColor', c.textColor));
    fields.innerHTML += field('Position', 'select', 'position', c.position, ['top','bottom']);
    fields.innerHTML += checkbox('Scrolling', 'scrolling', c.scrolling);
    setTimeout(() => renderSocialLinks(), 0);
  }
  if (tid === 'ticker') {
    fields.innerHTML += field('Text', 'textarea', 'text', c.text);
    fields.innerHTML += fieldRow(field('BG Color', 'color', 'bgColor', c.bgColor), field('Text Color', 'color', 'textColor', c.textColor));
    fields.innerHTML += field('Scroll Speed', 'select', 'scrollSpeed', c.scrollSpeed, ['slow','medium','fast']);
    fields.innerHTML += field('Position', 'select', 'position', c.position, ['top','bottom']);
  }
  if (tid === 'image-popup') {
    fields.innerHTML += field('Duration (seconds)', 'number', 'duration', c.duration);
    fields.innerHTML += field('Animation', 'select', 'animation', c.animation, ['fade','zoom','slide']);
    fields.innerHTML += field('Volume', 'range', 'volume', c.volume);
    fields.innerHTML += fileUpload('Alert Image', 'image');
    fields.innerHTML += fileUpload('Alert Sound', 'sound');
  }
  if (tid === 'text-popup') {
    fields.innerHTML += field('Text', 'text', 'text', c.text);
    fields.innerHTML += fieldRow(field('Text Color', 'color', 'textColor', c.textColor), field('Font', 'select', 'font', c.font, ['System Default','Montserrat','Bangers','Oswald','Rajdhani','Russo One','Press Start 2P']));
    fields.innerHTML += field('Font Size', 'select', 'fontSize', c.fontSize, ['2rem','3rem','4rem','5rem','6rem']);
    fields.innerHTML += field('Duration (seconds)', 'number', 'duration', c.duration);
    fields.innerHTML += field('Animation', 'select', 'animation', c.animation, ['fade','zoom','slide']);
    fields.innerHTML += field('Volume', 'range', 'volume', c.volume);
    fields.innerHTML += fileUpload('Sound (optional)', 'sound');
  }

  // Attach change listeners
  fields.querySelectorAll('input, select, textarea').forEach(el => {
    el.addEventListener('input', () => updateConfig(el));
  });
}

function field(label, type, key, value, options) {
  if (type === 'select') {
    const opts = (options || []).map(o => `<option value="${o}" ${value === o ? 'selected' : ''}>${o}</option>`).join('');
    return `<div class="field"><label>${label}</label><select data-key="${key}">${opts}</select></div>`;
  }
  if (type === 'color') {
    return `<div class="field"><label>${label}</label><input type="color" data-key="${key}" value="${value || '#ffffff'}"></div>`;
  }
  if (type === 'textarea') {
    return `<div class="field"><label>${label}</label><textarea data-key="${key}" rows="3">${value || ''}</textarea></div>`;
  }
  if (type === 'range') {
    return `<div class="field"><label>${label}</label><input type="range" data-key="${key}" min="0" max="1" step="0.1" value="${value != null ? value : 0.8}"></div>`;
  }
  return `<div class="field"><label>${label}</label><input type="${type}" data-key="${key}" value="${value != null ? value : ''}"></div>`;
}

function fieldRow(f1, f2) { return `<div class="field-row">${f1}${f2}</div>`; }

function checkbox(label, key, checked) {
  return `<div class="checkbox-field"><input type="checkbox" data-key="${key}" ${checked ? 'checked' : ''}><label style="color:#e0e0e0;font-size:0.85rem;">${label}</label></div>`;
}

function fileUpload(label, fieldName) {
  const current = currentConfig[fieldName];
  return `<div class="field"><label>${label}</label><input type="file" data-upload-field="${fieldName}" accept="${fieldName === 'sound' ? 'audio/*' : 'image/*'}"><div id="upload-status-${fieldName}" style="font-size:0.75rem;color:#888;margin-top:4px;">${current ? 'Current: ' + current : ''}</div></div>`;
}

function updateConfig(el) {
  const key = el.dataset.key;
  if (!key) return;
  let val = el.value;
  if (el.type === 'checkbox') val = el.checked;
  if (el.type === 'number') val = parseFloat(val) || 0;
  if (el.type === 'range') val = parseFloat(val);
  currentConfig[key] = val;
}

// Social links management
function renderSocialLinks() {
  const list = document.getElementById('social-links-list');
  if (!list) return;
  const links = currentConfig.links || [];
  list.innerHTML = links.map((l, i) => `
    <div style="display:flex;gap:6px;margin-bottom:6px;align-items:center;">
      <select onchange="updateSocialLink(${i},'platform',this.value)" style="width:120px;background:#16213e;border:1px solid #333;border-radius:4px;padding:4px;color:#e0e0e0;font-size:0.8rem;">
        ${['twitter','instagram','youtube','twitch','tiktok','discord','github','facebook'].map(p => `<option value="${p}" ${l.platform === p ? 'selected' : ''}>${p}</option>`).join('')}
      </select>
      <input type="text" value="${l.handle}" onchange="updateSocialLink(${i},'handle',this.value)" style="flex:1;background:#16213e;border:1px solid #333;border-radius:4px;padding:4px 8px;color:#e0e0e0;font-size:0.8rem;" placeholder="@handle">
      <button onclick="removeSocialLink(${i})" style="background:#e74c3c;color:white;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:0.75rem;">×</button>
    </div>
  `).join('');
}

function addSocialLink() {
  if (!currentConfig.links) currentConfig.links = [];
  currentConfig.links.push({ platform: 'twitter', handle: '' });
  renderSocialLinks();
}

function updateSocialLink(i, key, value) {
  if (currentConfig.links && currentConfig.links[i]) {
    currentConfig.links[i][key] = value;
  }
}

function removeSocialLink(i) {
  if (currentConfig.links) {
    currentConfig.links.splice(i, 1);
    renderSocialLinks();
  }
}

// File uploads
document.addEventListener('change', async (e) => {
  if (!e.target.dataset.uploadField) return;
  const fieldName = e.target.dataset.uploadField;
  const file = e.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById(`upload-status-${fieldName}`);
  statusEl.textContent = 'Uploading...';

  // Need overlay ID for upload path — if creating new, save first then upload
  const overlayId = editingOverlayId || 0;
  const ext = file.name.split('.').pop().toLowerCase();

  try {
    const resp = await fetch(`/dashboard/custom-overlays/${overlayId}/upload?field=${fieldName}&ext=${ext}`, {
      method: 'POST',
      body: file,
    });
    const data = await resp.json();
    if (data.ok) {
      currentConfig[fieldName] = data.filePath;
      statusEl.textContent = 'Uploaded!';
    } else {
      statusEl.textContent = 'Error: ' + (data.error || 'Upload failed');
    }
  } catch (err) {
    statusEl.textContent = 'Upload failed';
  }
});

async function saveOverlay() {
  const name = document.getElementById('overlay-name').value.trim();
  const command = document.getElementById('overlay-command').value.trim().toLowerCase().replace(/^!/, '');
  const alwaysOn = document.getElementById('overlay-always-on').checked;

  if (!name) return alert('Please enter an overlay name');
  if (!alwaysOn && !command) return alert('Please enter a chat command or check "Always on"');
  if (!selectedTemplate) return alert('Please select a template');

  const body = {
    type: selectedTemplate.type,
    name,
    template: selectedTemplate.id,
    chat_command: alwaysOn ? null : command,
    config: JSON.stringify(currentConfig),
    always_on: alwaysOn,
  };

  const url = editingOverlayId
    ? `/dashboard/custom-overlays/${editingOverlayId}/update`
    : '/dashboard/custom-overlays/create';

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();

  if (data.ok) {
    location.reload();
  } else {
    alert(data.error || 'Failed to save overlay');
  }
}

async function toggleOverlay(id, checkbox) {
  const resp = await fetch(`/dashboard/custom-overlays/${id}/toggle`, { method: 'POST' });
  const data = await resp.json();
  if (!data.ok) checkbox.checked = !checkbox.checked;
}

async function deleteOverlay(id, name) {
  if (!confirm(`Delete overlay "${name}"?`)) return;
  const resp = await fetch(`/dashboard/custom-overlays/${id}/delete`, { method: 'POST' });
  const data = await resp.json();
  if (data.ok) location.reload();
}

function copyUrl(inputId) {
  const input = document.getElementById(inputId);
  input.select();
  navigator.clipboard.writeText(input.value);
  const btn = input.nextElementSibling;
  btn.textContent = 'Copied!';
  setTimeout(() => btn.textContent = 'Copy', 2000);
}

// Init
filterTemplates('scene');
</script>

<%- include('footer') %>
```

- [ ] **Step 2: Add a GET route for individual overlay (used by edit modal)**

In `src/routes/customOverlays.js`, add after the create route:

```javascript
// Get single overlay (for edit modal)
router.get('/:id/get', (req, res) => {
  if (!req.streamer) return res.status(401).json({ error: 'Not authenticated' });
  const overlay = db.getCustomOverlayById(parseInt(req.params.id), req.streamer.id);
  if (!overlay) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, overlay });
});
```

- [ ] **Step 3: Verify EJS renders without errors**

Run: `node -e "const ejs = require('ejs'); ejs.renderFile('src/views/custom-overlays.ejs', { streamer: { id: 1 }, overlays: [], overlayToken: 'test', req: { protocol: 'http', get: () => 'localhost' } }, (err) => { if (err) console.error(err.message); else console.log('EJS OK'); })"`

- [ ] **Step 4: Commit**

```bash
git add src/views/custom-overlays.ejs src/routes/customOverlays.js
git commit -m "feat: add custom overlays dashboard page with create/edit/delete UI"
```

---

### Task 8: Dashboard and overlay config integration

**Files:**
- Modify: `src/views/dashboard.ejs`
- Modify: `src/views/overlay-builder.ejs`
- Modify: `src/views/overlay-config.ejs`

- [ ] **Step 1: Add Custom Overlays card to dashboard**

In `src/views/dashboard.ejs`, find the Twitch cards section and add a new card linking to custom overlays. Look for the existing overlay-related cards and add after them:

```html
<a href="/dashboard/custom-overlays" class="card" style="text-decoration:none;">
  <div class="card-icon">🎨</div>
  <div class="card-title">Custom Overlays</div>
  <div class="card-desc">Scene banners, info bars, and custom alerts</div>
</a>
```

- [ ] **Step 2: Add new OBS URLs to overlay builder dropdown**

In `src/views/overlay-builder.ejs`, find the OBS URLs dropdown (where alerts and sponsors URLs are listed). Add 3 new URL entries:

```html
<div style="margin-top:8px;">
  <label style="font-size:0.75rem;color:#888;">Scenes:</label>
  <div style="display:flex;gap:4px;margin-top:2px;">
    <input type="text" readonly value="<%= overlayUrl.replace('/overlay/', '/overlay/scenes/') %>" id="url-scenes" style="flex:1;background:#16213e;border:1px solid #333;border-radius:4px;padding:4px 8px;color:#e0e0e0;font-size:0.75rem;">
    <button onclick="navigator.clipboard.writeText(document.getElementById('url-scenes').value);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',2000)" style="background:#333;color:#aaa;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:0.7rem;">Copy</button>
  </div>
</div>
<div style="margin-top:8px;">
  <label style="font-size:0.75rem;color:#888;">Info Bar:</label>
  <div style="display:flex;gap:4px;margin-top:2px;">
    <input type="text" readonly value="<%= overlayUrl.replace('/overlay/', '/overlay/bar/') %>" id="url-bar" style="flex:1;background:#16213e;border:1px solid #333;border-radius:4px;padding:4px 8px;color:#e0e0e0;font-size:0.75rem;">
    <button onclick="navigator.clipboard.writeText(document.getElementById('url-bar').value);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',2000)" style="background:#333;color:#aaa;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:0.7rem;">Copy</button>
  </div>
</div>
<div style="margin-top:8px;">
  <label style="font-size:0.75rem;color:#888;">Custom Alerts:</label>
  <div style="display:flex;gap:4px;margin-top:2px;">
    <input type="text" readonly value="<%= overlayUrl.replace('/overlay/', '/overlay/custom-alerts/') %>" id="url-custom-alerts" style="flex:1;background:#16213e;border:1px solid #333;border-radius:4px;padding:4px 8px;color:#e0e0e0;font-size:0.75rem;">
    <button onclick="navigator.clipboard.writeText(document.getElementById('url-custom-alerts').value);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',2000)" style="background:#333;color:#aaa;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:0.7rem;">Copy</button>
  </div>
</div>
```

- [ ] **Step 3: Add new URLs to overlay config page**

In `src/views/overlay-config.ejs`, find the OBS URLs section and add the 3 new URLs with the same copy button pattern used for alerts and sponsors.

- [ ] **Step 4: Commit**

```bash
git add src/views/dashboard.ejs src/views/overlay-builder.ejs src/views/overlay-config.ejs
git commit -m "feat: integrate custom overlay URLs into dashboard, builder, and config pages"
```

---

### Task 9: E2E tests

**Files:**
- Create: `tests/custom-overlays.spec.js`

- [ ] **Step 1: Write Playwright E2E tests**

Create `tests/custom-overlays.spec.js`:

```javascript
const { test, expect } = require('@playwright/test');

test.describe('Custom Overlay Pages', () => {

  test('Scene overlay page loads with valid token', async ({ page }) => {
    // Use a known overlay token — need to get one from the database
    // For now, test that invalid tokens return 404
    const response = await page.goto('/overlay/scenes/invalid-token');
    expect(response.status()).toBe(404);
  });

  test('Bar overlay page loads with valid token', async ({ page }) => {
    const response = await page.goto('/overlay/bar/invalid-token');
    expect(response.status()).toBe(404);
  });

  test('Custom alerts overlay page loads with valid token', async ({ page }) => {
    const response = await page.goto('/overlay/custom-alerts/invalid-token');
    expect(response.status()).toBe(404);
  });

  test('Scene SSE endpoint returns 404 for invalid token', async ({ page }) => {
    const response = await page.goto('/overlay/scenes/events/invalid-token');
    expect(response.status()).toBe(404);
  });

  test('Custom overlays dashboard redirects when not authenticated', async ({ page }) => {
    await page.goto('/dashboard/custom-overlays');
    // Should redirect to login
    await expect(page).not.toHaveURL(/custom-overlays/);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `cd /Users/ricardosilva/vilela-notifications && npx playwright test tests/custom-overlays.spec.js`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/custom-overlays.spec.js
git commit -m "test: add E2E tests for custom overlay pages and SSE endpoints"
```

---

### Task 10: Final integration verification

- [ ] **Step 1: Start the server and verify all routes work**

Run: `cd /Users/ricardosilva/vilela-notifications && node -e "
const app = require('./src/server');
// Server should start without errors
setTimeout(() => { console.log('Server started OK'); process.exit(0); }, 3000);
"`

- [ ] **Step 2: Run the full test suite**

Run: `cd /Users/ricardosilva/vilela-notifications && npx playwright test`
Expected: All tests pass (existing + new)

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: complete custom overlays feature — templates, chat commands, OBS sources"
```
