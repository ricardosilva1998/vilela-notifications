const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');
const bus = require('../services/overlayBus');

// Unique ID per server process — changes on every restart/deploy
const SERVER_INSTANCE_ID = crypto.randomBytes(8).toString('hex');

// SSE endpoint — MUST be before /:token to avoid being caught by the wildcard
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

  // Include overlay designs keyed by event type
  const designs = db.getAllOverlayDesigns(streamer.id);
  const designMap = {};
  designs.forEach(d => { designMap[d.event_type] = d; });

  res.write(`data: ${JSON.stringify({ type: 'config', config, designs: designMap, serverVersion: SERVER_INSTANCE_ID })}\n\n`);

  // Replay current sponsor image so new clients see it immediately
  try {
    const { timedNotificationManager } = require('../services/timedNotifications');
    const currentSponsor = timedNotificationManager.getCurrentSponsor(streamer.id);
    if (currentSponsor) {
      res.write(`data: ${JSON.stringify(currentSponsor)}\n\n`);
    }
  } catch (e) { /* timedNotifications not yet initialized */ }

  // Heartbeat every 30s to keep connection alive in OBS browser source
  const heartbeat = setInterval(() => {
    try { res.write(`:heartbeat\n\n`); } catch (e) { clearInterval(heartbeat); }
  }, 30000);

  // Listen for events on the bus
  const listener = (event) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch (e) { /* connection closed */ }
  };

  bus.on(`overlay:${streamer.id}`, listener);

  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off(`overlay:${streamer.id}`, listener);
  });
});

// Diagnostic endpoint — check overlay status
router.get('/debug/:token', (req, res) => {
  const streamer = db.getStreamerByOverlayToken(req.params.token);
  if (!streamer) return res.status(404).json({ error: 'Invalid token' });

  const images = db.getEnabledSponsorImages(streamer.id);
  const designs = db.getAllOverlayDesigns(streamer.id);
  res.json({
    streamerId: streamer.id,
    overlayEnabled: streamer.overlay_enabled,
    sponsorRotationEnabled: streamer.sponsor_rotation_enabled,
    enabledImages: images.map(i => ({ id: i.id, name: i.display_name, duration: i.display_duration, enabled: i.enabled })),
    designs: designs.map(d => ({ type: d.event_type, animation: d.sponsor_animation, position: d.card_position })),
  });
});

// Sponsor-only SSE endpoint
router.get('/sponsors/events/:token', (req, res) => {
  const streamer = db.getStreamerByOverlayToken(req.params.token);
  if (!streamer) return res.status(404).send('Invalid overlay token');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send design config for sponsor positioning
  const designs = db.getAllOverlayDesigns(streamer.id);
  const designMap = {};
  designs.forEach(d => { designMap[d.event_type] = d; });
  res.write(`data: ${JSON.stringify({ type: 'config', designs: designMap, serverVersion: SERVER_INSTANCE_ID })}\n\n`);

  // Replay current sponsor
  try {
    const { timedNotificationManager } = require('../services/timedNotifications');
    const currentSponsor = timedNotificationManager.getCurrentSponsor(streamer.id);
    if (currentSponsor) {
      res.write(`data: ${JSON.stringify(currentSponsor)}\n\n`);
    }
  } catch (e) {}

  const heartbeat = setInterval(() => {
    try { res.write(`:heartbeat\n\n`); } catch (e) { clearInterval(heartbeat); }
  }, 30000);

  const listener = (event) => {
    // Only forward sponsor events
    if (event.type !== 'sponsor') return;
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch (e) {}
  };

  bus.on(`overlay:${streamer.id}`, listener);
  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off(`overlay:${streamer.id}`, listener);
  });
});

// Sponsor-only overlay page
router.get('/sponsors/:token', (req, res) => {
  const streamer = db.getStreamerByOverlayToken(req.params.token);
  if (!streamer) return res.status(404).send('Invalid overlay token');

  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Sponsor Overlay</title>
  <link rel="stylesheet" href="/overlay/overlay.css">
</head>
<body>
  <div id="timed-container"></div>
  <script>window.OVERLAY_TOKEN = ${JSON.stringify(streamer.overlay_token)};</script>
  <script src="/overlay/sponsors.js"></script>
</body>
</html>`);
});

// Serve overlay page — AFTER /events/:token so the wildcard doesn't catch SSE requests
router.get('/:token', (req, res) => {
  const streamer = db.getStreamerByOverlayToken(req.params.token);
  if (!streamer) return res.status(404).send('Invalid overlay token');

  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Stream Overlay</title>
  <link rel="stylesheet" href="/overlay/overlay.css">
</head>
<body>
  <div id="notification-container"></div>
  <div id="timed-container"></div>
  <script>window.OVERLAY_TOKEN = ${JSON.stringify(streamer.overlay_token)};</script>
  <script src="/overlay/overlay.js"></script>
</body>
</html>`);
});

module.exports = router;
