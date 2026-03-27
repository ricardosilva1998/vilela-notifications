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
  <div id="timed-container"></div>
  <script>window.OVERLAY_TOKEN = ${JSON.stringify(streamer.overlay_token)};</script>
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

  // Include overlay designs keyed by event type
  const designs = db.getAllOverlayDesigns(streamer.id);
  const designMap = {};
  designs.forEach(d => { designMap[d.event_type] = d; });

  res.write(`data: ${JSON.stringify({ type: 'config', config, designs: designMap })}\n\n`);

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
