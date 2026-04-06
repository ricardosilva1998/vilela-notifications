const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const config = require('./config');
const db = require('./db');
const { t, SUPPORTED_LANGS } = require('./i18n');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const paymentRoutes = require('./routes/payment');
const tipRoutes = require('./routes/tip');
const overlayRoutes = require('./routes/overlay');
const vtuberRoutes = require('./routes/vtuber');
const syncRoutes = require('./routes/sync');
// const customOverlayRoutes = require('./routes/customOverlays'); // DISABLED for now

const app = express();

// Middleware
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Static files — no-cache for overlay assets so OBS gets fresh JS/CSS after deploy
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.includes('/overlay/')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));
// Serve custom sounds from persistent data volume (survives deploys)
app.use('/overlay/sounds', express.static(path.join(__dirname, '..', 'data', 'sounds')));
// Serve sponsor images from persistent data volume
app.use('/sponsors', express.static(path.join(__dirname, '..', 'data', 'sponsors')));
// Serve custom VTuber models from persistent data volume
app.use('/vtuber-models', express.static(path.join(__dirname, '..', 'data', 'vtuber-models')));
// Serve custom overlay uploads from persistent data volume — DISABLED for now
// app.use('/uploads/custom', express.static(path.join(__dirname, '..', 'data', 'uploads', 'custom')));

// EJS setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session middleware — attach streamer to request if logged in
app.use((req, res, next) => {
  const sid = req.cookies?.session;
  if (sid) {
    const session = db.getSession(sid);
    if (session) {
      req.streamer = db.getStreamerById(session.streamer_id);
    }
  }
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

// Routes
app.get('/', (req, res) => {
  if (req.streamer) return res.redirect('/dashboard');
  res.render('login', { streamer: null });
});

app.get('/tutorial', (req, res) => {
  res.render('tutorial', { streamer: req.streamer || null });
});

app.get('/donate', (req, res) => {
  res.render('donate', { streamer: req.streamer || null });
});

app.get('/pricing', (req, res) => {
  res.render('pricing', {
    streamer: req.streamer || null,
    tiers: config.tiers,
    currentTier: req.streamer ? db.getStreamerTier(req.streamer.id) : null,
    msg: req.query.msg,
  });
});

app.use('/auth', authRoutes);
app.use('/dashboard', dashboardRoutes);
// app.use('/dashboard/custom-overlays', customOverlayRoutes); // DISABLED for now
app.use('/payment', paymentRoutes);
app.use('/tip', tipRoutes);
// Public Bridge API (no auth) — BEFORE /api auth middleware
app.get('/api/bridge/config', (req, res) => {
  res.json({ openaiKey: process.env.OPENAI_API_KEY || '' });
});

// Discord voice state API (public, used by Bridge app)
app.get('/api/voice/:discordUserId', async (req, res) => {
  try {
    const { discordUserId } = req.params;
    const { client } = require('./discord');
    const { ensureConnected, isSpeaking, scheduleDisconnect } = require('./services/voiceTracker');

    let voiceState = null;
    for (const guild of client.guilds.cache.values()) {
      const vs = guild.voiceStates.cache.get(discordUserId);
      if (vs && vs.channelId) { voiceState = vs; break; }
    }
    if (!voiceState || !voiceState.channel) {
      return res.json({ channelName: null, members: [] });
    }

    const channel = voiceState.channel;

    // Join voice channel for speaking detection (non-blocking)
    ensureConnected(channel).catch(e => console.log('[VoiceTracker] ensureConnected error:', e.message));
    scheduleDisconnect(); // Auto-leave after 5 min of no polls

    // Filter out bots (like the Atleta bot itself)
    const humanMembers = channel.members.filter(m => !m.user.bot);

    const members = humanMembers.map(member => {
      // Re-fetch voice state from cache for latest mute/deaf status
      const freshVs = member.guild.voiceStates.cache.get(member.id);
      const vs = freshVs || member.voice;
      const user = member.user;
      const avatar = user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp?size=64`
        : `https://cdn.discordapp.com/embed/avatars/${(BigInt(user.id) >> 22n) % 6n}.png`;
      return {
        id: user.id, username: user.username,
        displayName: member.displayName || user.displayName || user.username,
        avatar, selfMute: vs.selfMute || false, selfDeaf: vs.selfDeaf || false,
        serverMute: vs.serverMute || false, serverDeaf: vs.serverDeaf || false,
        streaming: vs.streaming || false, camera: vs.selfVideo || false,
        speaking: isSpeaking(user.id),
        isStreamer: user.id === discordUserId,
      };
    });
    res.json({ channelName: channel.name, members });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Track map API (public — must be before /api auth middleware)
app.get('/api/track-map/:trackName', (req, res) => {
  try {
    const row = db.db.prepare('SELECT track_data FROM track_maps WHERE track_name = ?').get(req.params.trackName);
    if (!row) return res.status(404).json({ error: 'Track not found' });
    res.json({ trackName: req.params.trackName, trackData: JSON.parse(row.track_data) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/track-map', (req, res) => {
  try {
    const { trackName, trackData } = req.body;
    if (!trackName || !trackData || !Array.isArray(trackData) || trackData.length < 50) {
      return res.status(400).json({ error: 'Invalid track data' });
    }
    const json = JSON.stringify(trackData);
    const existing = db.db.prepare('SELECT point_count FROM track_maps WHERE track_name = ?').get(trackName);
    if (existing && existing.point_count >= trackData.length) {
      return res.json({ status: 'exists', message: 'Better or equal track already stored' });
    }
    db.db.prepare(`INSERT INTO track_maps (track_name, track_data, point_count) VALUES (?, ?, ?)
      ON CONFLICT(track_name) DO UPDATE SET track_data = excluded.track_data, point_count = excluded.point_count, updated_at = datetime('now')
    `).run(trackName, json, trackData.length);
    res.json({ status: 'ok', points: trackData.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.use('/api', apiRoutes);
app.use('/admin', adminRoutes);
app.use('/vtuber', vtuberRoutes);
app.use('/sync', syncRoutes);
app.use('/overlay', overlayRoutes);


// Language switch
app.post('/set-language', (req, res) => {
  const lang = SUPPORTED_LANGS.includes(req.body.lang) ? req.body.lang : 'en';
  res.cookie('lang', lang, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true });
  const referer = req.headers.referer || '/';
  res.redirect(referer);
});

// Health check
app.get('/health', (req, res) => res.send('OK'));

function start() {
  const port = config.app.port;
  app.listen(port, () => {
    console.log(`[Server] Dashboard at ${config.app.url}`);
  });

  // Ensure all streamers have a subscription record
  db.ensureFreeSubscriptions();

  // Clean expired sessions every hour
  setInterval(() => db.cleanExpiredSessions(), 60 * 60 * 1000);

  // Check for expired subscriptions every hour
  setInterval(() => db.expireSubscriptions(), 60 * 60 * 1000);

  // Daily data sync from prod (dev environment only)
  if (config.app.syncSourceUrl && config.app.syncSecret) {
    const { performSync } = require('./services/sync');

    if (process.env.SYNC_ON_STARTUP === 'true') {
      setTimeout(() => performSync(), 10_000);
    }

    // Schedule daily sync at 04:00 UTC
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(4, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    setTimeout(() => {
      performSync();
      setInterval(() => performSync(), 24 * 60 * 60 * 1000);
    }, next - now);

    console.log(`[Sync] Daily sync scheduled at 04:00 UTC (next: ${next.toISOString()})`);
  }
}

module.exports = { start };
