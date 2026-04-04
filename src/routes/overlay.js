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

// Test alert endpoint — sends a fake event to the overlay
router.post('/test-alert', (req, res) => {
  if (!req.streamer) return res.status(401).json({ error: 'Not authenticated' });
  if (!req.streamer.overlay_enabled) return res.status(400).json({ error: 'Overlay not enabled' });

  const { type, amount } = req.body;
  const testEvents = {
    follow: { type: 'follow', data: { username: 'TestViewer' } },
    subscription: { type: 'subscription', data: { username: 'TestSubscriber', tier: '1', months: 3, message: 'Test subscription!' } },
    giftsub: { type: 'subscription', data: { username: 'TestGifter', tier: '1', months: 1, message: `Gifted ${amount || 5} subs!`, isGift: true, giftAmount: amount || 5 } },
    bits: { type: 'bits', data: { username: 'TestCheerer', amount: amount || 500, message: 'Test bits cheer!' } },
    raid: { type: 'raid', data: { username: 'TestRaider', viewers: amount || 50 } },
    donation: { type: 'donation', data: { username: 'TestDonor', amount: amount || 5, currency: 'EUR', message: 'Test donation!' } },
  };

  const event = testEvents[type];
  if (!event) return res.status(400).json({ error: 'Invalid event type' });

  // Fire chatbot message in sync with the overlay
  const { chatManager } = require('../services/twitchChat');
  const chatType = type === 'giftsub' ? 'giftsub' : type;
  chatManager.sendEventMessage(req.streamer.id, chatType, event.data);

  // If testing giftsub, emit as 'subscription' type (matching real EventSub behavior)
  // then send individual sub events that should be suppressed by dedup
  if (type === 'giftsub') {
    const giftCount = amount || 5;
    // Main gift event — shows as subscription card with gift message + isGift flag
    bus.emit(`overlay:${req.streamer.id}`, {
      type: 'subscription',
      isGift: true,
      data: { username: event.data.username, tier: '1', months: 1, message: `Gifted ${giftCount} sub${giftCount > 1 ? 's' : ''}!` }
    });
    // Simulate individual sub events from each recipient (should be suppressed by overlay dedup)
    if (giftCount > 1) {
      for (let i = 0; i < giftCount; i++) {
        setTimeout(() => {
          bus.emit(`overlay:${req.streamer.id}`, {
            type: 'subscription',
            data: { username: `GiftRecipient${i + 1}`, tier: '1', months: 1, message: null }
          });
        }, 200 * (i + 1));
      }
    }
  } else {
    bus.emit(`overlay:${req.streamer.id}`, event);
  }

  console.log(`[Overlay] Test alert: ${type} for streamer ${req.streamer.id}`);
  res.json({ ok: true, type });
});

// Clear overlay — removes all queued alerts and cards
router.post('/clear', (req, res) => {
  if (!req.streamer) return res.status(401).json({ error: 'Not authenticated' });
  bus.emit(`overlay:${req.streamer.id}`, { type: 'clear' });
  console.log(`[Overlay] Cleared for streamer ${req.streamer.id}`);
  res.json({ ok: true });
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

// Custom overlay routes — DISABLED for now
// const { setupSSE: customSSE, servePage: customPage } = require('./customOverlays');
// router.get('/scenes/events/:token', (req, res) => customSSE(req, res, 'scene'));
// router.get('/scenes/:token', (req, res) => customPage(req, res, 'scene'));
// router.get('/bar/events/:token', (req, res) => customSSE(req, res, 'bar'));
// router.get('/bar/:token', (req, res) => customPage(req, res, 'bar'));
// router.get('/custom-alerts/events/:token', (req, res) => customSSE(req, res, 'custom-alert'));
// router.get('/custom-alerts/:token', (req, res) => customPage(req, res, 'custom-alert'));

// iRacing overlay pages
router.get('/iracing/:type/:token', (req, res) => {
  const validTypes = ['standings', 'relative', 'fuel', 'chat', 'wind', 'proximity'];
  const type = req.params.type;
  if (!validTypes.includes(type)) return res.status(404).send('Invalid overlay type');
  const streamer = db.getStreamerByOverlayToken(req.params.token);
  if (!streamer) return res.status(404).send('Invalid overlay token');

  let settings = {};
  try {
    const setting = db.getIracingOverlaySetting(streamer.id, type);
    if (setting) settings = JSON.parse(setting.settings || '{}');
  } catch (e) {}

  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>iRacing ${type.charAt(0).toUpperCase() + type.slice(1)} Overlay</title>
  <link rel="stylesheet" href="/overlay/iracing/shared.css">
  <link rel="stylesheet" href="/overlay/iracing/${type}.css">
</head>
<body>
  <div id="overlay-root"></div>
  <script>
    window.OVERLAY_TOKEN = ${JSON.stringify(req.params.token)};
    window.OVERLAY_TYPE = ${JSON.stringify(type)};
    window.OVERLAY_SETTINGS = ${JSON.stringify(settings)};
    window.STREAMER_ID = ${streamer.id};
  </script>
  <script src="/overlay/iracing/shared.js"></script>
  <script src="/overlay/iracing/${type}.js"></script>
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
