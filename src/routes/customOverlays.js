const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../db');
const bus = require('../services/overlayBus');

// Auth guard for dashboard routes
router.use((req, res, next) => {
  if (!req.streamer) return res.redirect('/');
  next();
});

// --- Helper: emit SSE event for an overlay ---
function emitOverlayEvent(streamerId, overlay) {
  let config = {};
  try { config = JSON.parse(overlay.config || '{}'); } catch (e) {}

  let eventType;
  if (!overlay.is_active) {
    eventType = overlay.type === 'scene' ? 'scene-deactivated'
      : overlay.type === 'bar' ? 'bar-update'
      : 'custom-alert-remove';
  } else {
    eventType = overlay.type === 'scene' ? 'scene-activated'
      : overlay.type === 'bar' ? 'bar-update'
      : 'custom-alert-show';
  }

  bus.emit(`custom-overlay:${streamerId}`, {
    type: eventType,
    overlay: { ...overlay, config },
  });
}

// --- Helper: delete uploaded files for an overlay ---
function deleteUploadedFiles(streamerId, overlayId) {
  const uploadDir = path.join(__dirname, '..', '..', 'data', 'uploads', 'custom', String(streamerId));
  if (!fs.existsSync(uploadDir)) return;
  const prefix = `${overlayId}-`;
  try {
    const files = fs.readdirSync(uploadDir);
    for (const file of files) {
      if (file.startsWith(prefix)) {
        try { fs.unlinkSync(path.join(uploadDir, file)); } catch (e) {}
      }
    }
  } catch (e) {}
}

// --- Dashboard CRUD routes ---

// GET / — List overlays
router.get('/', (req, res) => {
  const streamer = req.streamer;
  const overlays = db.getCustomOverlays(streamer.id);
  const appUrl = `${req.protocol}://${req.get('host')}`;
  res.render('custom-overlays', { streamer, overlays, overlayToken: streamer.overlay_token, appUrl });
});

// GET /:id/get — Return single overlay as JSON
router.get('/:id/get', (req, res) => {
  const overlay = db.getCustomOverlayById(parseInt(req.params.id), req.streamer.id);
  if (!overlay) return res.status(404).json({ error: 'Not found' });
  let config = {};
  try { config = JSON.parse(overlay.config || '{}'); } catch (e) {}
  res.json({ ...overlay, config });
});

// POST /create — Create overlay
router.post('/create', (req, res) => {
  const streamer = req.streamer;
  const { type, name, template, chat_command, always_on } = req.body;
  let config = {};
  try { config = JSON.parse(req.body.config || '{}'); } catch (e) {
    return res.status(400).json({ error: 'Invalid config JSON' });
  }

  // Validate no duplicate command
  if (chat_command) {
    const existing = db.getCustomOverlayByCommand(streamer.id, chat_command);
    if (existing) return res.status(400).json({ error: 'Duplicate chat command' });
  }

  const alwaysOn = always_on === '1' || always_on === true || always_on === 1;
  db.addCustomOverlay(streamer.id, type, name, template, chat_command || null, config, alwaysOn);

  // Emit initial state if always_on
  const created = db.getCustomOverlays(streamer.id).slice(-1)[0];
  if (created && alwaysOn) {
    emitOverlayEvent(streamer.id, created);
  }

  bus.emit(`custom-overlay-commands-changed:${streamer.id}`, {});
  res.json({ ok: true, overlay: created });
});

// POST /:id/update — Update overlay
router.post('/:id/update', (req, res) => {
  const streamer = req.streamer;
  const id = parseInt(req.params.id);
  const overlay = db.getCustomOverlayById(id, streamer.id);
  if (!overlay) return res.status(404).json({ error: 'Not found' });

  const { name, template, chat_command, always_on } = req.body;
  let config = {};
  try { config = JSON.parse(req.body.config || '{}'); } catch (e) {
    return res.status(400).json({ error: 'Invalid config JSON' });
  }

  // Check duplicate command excluding self
  if (chat_command) {
    const existing = db.getCustomOverlayByCommand(streamer.id, chat_command);
    if (existing && existing.id !== id) return res.status(400).json({ error: 'Duplicate chat command' });
  }

  const alwaysOn = always_on === '1' || always_on === true || always_on === 1;
  db.updateCustomOverlay(id, streamer.id, name, template, chat_command || null, config, alwaysOn);

  const updated = db.getCustomOverlayById(id, streamer.id);
  emitOverlayEvent(streamer.id, updated);

  bus.emit(`custom-overlay-commands-changed:${streamer.id}`, {});
  res.json({ ok: true, overlay: updated });
});

// POST /:id/toggle — Toggle is_active
router.post('/:id/toggle', (req, res) => {
  const streamer = req.streamer;
  const id = parseInt(req.params.id);

  const toggled = db.toggleCustomOverlay(id, streamer.id);
  if (!toggled) return res.status(404).json({ error: 'Not found' });

  // Emit the toggled overlay
  emitOverlayEvent(streamer.id, toggled);

  // If it's a scene that was activated, emit deactivation for all other scenes
  if (toggled.type === 'scene' && toggled.is_active) {
    const allScenes = db.getCustomOverlaysByType(streamer.id, 'scene');
    for (const scene of allScenes) {
      if (scene.id !== id) {
        // Emit deactivation unconditionally — DB already deactivated them
        bus.emit(`custom-overlay:${streamer.id}`, {
          type: 'scene-deactivated',
          overlay: { ...scene, config: (() => { try { return JSON.parse(scene.config || '{}'); } catch (e) { return {}; } })() },
        });
      }
    }
  }

  res.json({ ok: true, overlay: toggled });
});

// POST /:id/delete — Delete overlay
router.post('/:id/delete', (req, res) => {
  const streamer = req.streamer;
  const id = parseInt(req.params.id);
  const overlay = db.getCustomOverlayById(id, streamer.id);
  if (!overlay) return res.status(404).json({ error: 'Not found' });

  db.deleteCustomOverlay(id, streamer.id);

  // Delete uploaded files
  deleteUploadedFiles(streamer.id, id);

  // Emit removal event
  const eventType = overlay.type === 'scene' ? 'scene-deactivated'
    : overlay.type === 'bar' ? 'bar-remove'
    : 'custom-alert-remove';
  bus.emit(`custom-overlay:${streamer.id}`, {
    type: eventType,
    overlay: { id, type: overlay.type },
  });

  bus.emit(`custom-overlay-commands-changed:${streamer.id}`, {});
  res.json({ ok: true });
});

// POST /:id/upload — File upload for images/sounds
router.post('/:id/upload', (req, res) => {
  const streamer = req.streamer;
  const id = parseInt(req.params.id);
  const overlay = db.getCustomOverlayById(id, streamer.id);
  if (!overlay) return res.status(404).json({ error: 'Not found' });

  const field = (req.query.field || 'file').replace(/[^a-zA-Z0-9_-]/g, '');
  const ext = (req.query.ext || 'png').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

  // Validate extensions
  const allowedExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp3', 'ogg', 'wav'];
  if (!allowedExts.includes(ext)) {
    return res.status(400).json({ error: 'Invalid file extension' });
  }

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const uploadDir = path.join(__dirname, '..', '..', 'data', 'uploads', 'custom', String(streamer.id));
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    const filename = `${id}-${field}-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(uploadDir, filename), Buffer.concat(chunks));

    res.json({ ok: true, filename, url: `/uploads/custom/${streamer.id}/${filename}` });
  });
});

// --- SSE function ---
function setupSSE(req, res, overlayType) {
  const streamer = db.getStreamerByOverlayToken(req.params.token);
  if (!streamer) return res.status(404).send('Invalid overlay token');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send initial config with all overlays of the given type
  const overlays = db.getCustomOverlaysByType(streamer.id, overlayType).map(o => {
    let config = {};
    try { config = JSON.parse(o.config || '{}'); } catch (e) {}
    return { ...o, config };
  });

  res.write(`data: ${JSON.stringify({ type: 'init', overlays })}\n\n`);

  // 30s heartbeat
  const heartbeat = setInterval(() => {
    try { res.write(`:heartbeat\n\n`); } catch (e) { clearInterval(heartbeat); }
  }, 30000);

  // Listen for custom overlay bus events, filter by overlay type
  const listener = (event) => {
    if (event.overlay && event.overlay.type !== overlayType) return;
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch (e) {}
  };

  bus.on(`custom-overlay:${streamer.id}`, listener);

  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off(`custom-overlay:${streamer.id}`, listener);
  });
}

// --- Page function ---
function servePage(req, res, overlayType) {
  const streamer = db.getStreamerByOverlayToken(req.params.token);
  if (!streamer) return res.status(404).send('Invalid overlay token');

  const scriptMap = {
    scene: 'scenes.js',
    bar: 'bar.js',
    'custom-alert': 'custom-alerts.js',
  };
  const containerMap = {
    scene: 'scene-container',
    bar: 'bar-container',
    'custom-alert': 'alert-container',
  };

  const script = scriptMap[overlayType] || 'overlay.js';
  const containerId = containerMap[overlayType] || 'overlay-container';

  const googleFonts = 'Montserrat:wght@400;700&family=Bangers&family=Oswald:wght@400;700&family=Rajdhani:wght@400;700&family=Russo+One&family=Press+Start+2P';

  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${overlayType} Overlay</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=${googleFonts}&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/overlay/overlay.css">
</head>
<body>
  <div id="${containerId}"></div>
  <script>window.OVERLAY_TOKEN = ${JSON.stringify(streamer.overlay_token)};</script>
  <script src="/overlay/${script}"></script>
</body>
</html>`);
}

module.exports = router;
module.exports.setupSSE = setupSSE;
module.exports.servePage = servePage;
