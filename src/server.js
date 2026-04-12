const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
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
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
app.set('trust proxy', 1); // Trust first proxy (Railway/Cloudflare)

// HTTPS redirect in production
app.use((req, res, next) => {
  if (isProduction && req.get('x-forwarded-proto') === 'http') {
    return res.redirect(301, `https://${req.get('host')}${req.originalUrl}`);
  }
  next();
});

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // app uses inline scripts/styles extensively
  crossOriginEmbedderPolicy: false, // overlay pages are embedded in OBS
}));

// Rate limiters
const generalLimiter = rateLimit({ windowMs: 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: 'Too many attempts, please try again later' });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
app.use(generalLimiter);
function secureCookie(res, name, value, opts = {}) {
  res.cookie(name, value, { httpOnly: true, secure: isProduction, sameSite: 'lax', ...opts });
}
app.locals.secureCookie = secureCookie;

// Middleware
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '10mb' }));

// Static files — no-cache for overlay assets so OBS gets fresh JS/CSS after deploy
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.includes('/overlay/')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));
// Serve Bridge overlay files for pitwall iframes.
// HTML/JS must not cache so deploys are picked up immediately.
// Static assets (flag SVGs, helmet PNGs, logos, CSS) cache for an hour —
// without this, relative/standings rows re-render at 2Hz/1Hz and re-fetch
// every flag per tick, producing a visible blink on the flag column.
app.use('/pitwall/overlays', express.static(path.join(__dirname, '..', 'bridge', 'overlays'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      res.set('Cache-Control', 'public, max-age=3600');
    }
  }
}));
// Serve custom sounds from persistent data volume (survives deploys)
app.use('/overlay/sounds', express.static(path.join(__dirname, '..', 'data', 'sounds')));
// Serve sponsor images from persistent data volume
app.use('/sponsors', express.static(path.join(__dirname, '..', 'data', 'sponsors')));
// Serve uploaded avatars from persistent data volume
app.use('/avatars', express.static(path.join(__dirname, '..', 'data', 'avatars')));
// Serve issue screenshots from persistent data volume
app.use('/issues-files', express.static(path.join(__dirname, '..', 'data', 'issues')));
// Serve custom VTuber models from persistent data volume
app.use('/vtuber-models', express.static(path.join(__dirname, '..', 'data', 'vtuber-models')));
// Serve custom overlay uploads from persistent data volume — DISABLED for now
// app.use('/uploads/custom', express.static(path.join(__dirname, '..', 'data', 'uploads', 'custom')));

// EJS setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

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

  // Stored notifications for racing users
  if (req.racingUser) {
    res.locals.notifications = db.getNotificationsForUser(req.racingUser.id);
    res.locals.unreadNotifCount = db.getUnreadNotificationCount(req.racingUser.id);
  } else {
    res.locals.notifications = [];
    res.locals.unreadNotifCount = 0;
  }

  // i18n
  const lang = SUPPORTED_LANGS.includes(req.cookies?.lang) ? req.cookies.lang : 'en';
  req.lang = lang;
  res.locals.lang = lang;
  res.locals.SUPPORTED_LANGS = SUPPORTED_LANGS;
  res.locals.t = (key, params) => t(lang, key, params);
  res.locals.currentPath = req.path;

  next();
});

// Routes
app.get('/', (req, res) => {
  res.render('login', { streamer: req.streamer || null, racingUser: req.racingUser || null });
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

const racingAuthRoutes = require('./routes/racing-auth');
const racingRoutes = require('./routes/racing');
const racingTeamRoutes = require('./routes/racing-team');
app.use('/racing/auth', authLimiter, racingAuthRoutes);
app.use('/racing/teams', (req, res, next) => {
  if (!req.racingUser) return res.redirect('/racing');
  next();
}, racingTeamRoutes);
// Redirect old URL
app.get('/racing/team', (req, res) => res.redirect('/racing/teams'));
app.use('/racing', racingRoutes);

app.get('/streamer', (req, res) => {
  if (req.streamer) return res.redirect('/dashboard');
  res.render('streamer-landing', { streamer: null, racingUser: null });
});
// Bridge feature-detect endpoint. The Bridge calls this without a session
// cookie (raw https.get), so it must NOT require auth. The response is a
// plain capability flag — no secrets — so the missing auth check is safe.
// (Until v3.22.0 this endpoint returned process.env.OPENAI_API_KEY which IS
// why it had auth in the first place; that has been moved server-side to
// /api/bridge/whisper.)
app.get('/api/bridge/config', (req, res) => {
  res.json({ whisperProxyEnabled: !!process.env.OPENAI_API_KEY });
});

// Bridge: full account info for the Atleta Racing Account tab. Authenticated
// by session cookie OR by ?bridge_id= matching a known Racing user. The
// pitwall_token column is intentionally NOT returned — it's sensitive.
app.get('/api/bridge/account', (req, res) => {
  try {
    let user = req.racingUser;
    if (!user && req.query.bridge_id && /^[a-f0-9-]{20,}$/i.test(req.query.bridge_id)) {
      user = db.getRacingUserByBridgeId(req.query.bridge_id);
    }
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    // Resolve Twitch + Spotify via the linked streamer (if any).
    let twitchUsername = null;
    let twitchConnected = false;
    let spotifyConnected = false;
    if (user.streamer_id) {
      try {
        const streamer = db.getStreamerById(user.streamer_id);
        if (streamer) {
          twitchUsername = streamer.twitch_display_name || streamer.twitch_username || null;
          twitchConnected = !!streamer.twitch_username;
          spotifyConnected = !!streamer.spotify_refresh_token;
        }
      } catch (e) {}
    }

    res.json({
      id: user.id,
      username: user.username,
      display_name: user.display_name || null,
      iracing_name: user.iracing_name || null,
      email: user.email || null,
      avatar: user.avatar || null,
      created_at: user.created_at,
      bridge_id: user.bridge_id,
      twitch_connected: twitchConnected,
      twitch_username: twitchUsername,
      spotify_connected: spotifyConnected,
    });
  } catch (e) {
    console.error('[Bridge Account] error:', e.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Server-side Whisper proxy. Bridges upload raw audio bytes here; the server
// forwards to OpenAI Whisper and returns the transcription. Authenticated by
// session cookie or by ?bridge_id= matching a known Racing user (same
// pattern as /api/bridge/spotify).
app.post('/api/bridge/whisper', (req, res) => {
  let authed = !!(req.streamer || req.racingUser);
  let authVia = authed ? 'session' : null;
  if (!authed && req.query.bridge_id && /^[a-f0-9-]{20,}$/i.test(req.query.bridge_id)) {
    if (db.getRacingUserByBridgeId(req.query.bridge_id)) {
      authed = true;
      authVia = 'bridge_id';
    }
  }
  if (!authed) {
    console.warn('[Whisper proxy] 401 — no session, bridge_id=' + (req.query.bridge_id || '(none)'));
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[Whisper proxy] 503 — OPENAI_API_KEY not configured');
    return res.status(503).json({ error: 'Whisper not configured' });
  }
  console.log('[Whisper proxy] auth=' + authVia + ' content-length=' + (req.headers['content-length'] || '0'));

  const MAX_BYTES = 5 * 1024 * 1024;
  const declared = parseInt(req.headers['content-length'] || '0', 10);
  if (declared && declared > MAX_BYTES) return res.status(413).json({ error: 'Audio too large' });

  const chunks = [];
  let received = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    received += chunk.length;
    if (received > MAX_BYTES) {
      aborted = true;
      try { req.destroy(); } catch (e) {}
      res.status(413).json({ error: 'Audio too large' });
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', async () => {
    if (aborted) return;
    try {
      const audio = Buffer.concat(chunks, received);
      // Build multipart/form-data manually so we don't pull in a new dep.
      const boundary = '----atleta-' + Math.random().toString(16).slice(2);
      const head = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="language"\r\n\r\nen\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="speech.wav"\r\n` +
        `Content-Type: audio/wav\r\n\r\n`
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([head, audio, tail]);
      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
          'Content-Length': String(body.length),
        },
        body,
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        console.error('[Whisper proxy] OpenAI', r.status, text.slice(0, 200));
        return res.status(502).json({ error: 'Transcription failed' });
      }
      const json = await r.json();
      res.json({ text: (json.text || '').trim() });
    } catch (e) {
      console.error('[Whisper proxy]', e.message);
      res.status(500).json({ error: 'Transcription failed' });
    }
  });
  req.on('error', () => {
    if (!aborted) res.status(400).json({ error: 'Bad request' });
  });
});

// Spotify now playing — for Bridge overlay (polls every 3-5s)
app.get('/api/bridge/spotify', async (req, res) => {
  try {
    // Find streamer: from session cookie, racingUser link, or bridge_id query param
    let streamer = req.streamer;
    if (!streamer && req.racingUser && req.racingUser.streamer_id) {
      streamer = db.getStreamerById(req.racingUser.streamer_id);
    }
    if (!streamer && req.query.bridge_id && /^[a-f0-9-]{20,}$/i.test(req.query.bridge_id)) {
      const ru = db.getRacingUserByBridgeId(req.query.bridge_id);
      if (ru && ru.streamer_id) streamer = db.getStreamerById(ru.streamer_id);
    }
    if (!streamer || !streamer.spotify_access_token) {
      return res.json({ status: 'not_connected' });
    }
    const { getCurrentlyPlaying } = require('./services/spotify');
    const data = await getCurrentlyPlaying(streamer);
    res.json(data);
  } catch(e) {
    res.json({ status: 'error' });
  }
});

// Spotify playback control — for Bridge overlay media controls
app.post('/api/bridge/spotify/control', express.json(), async (req, res) => {
  try {
    let streamer = req.streamer;
    if (!streamer && req.racingUser && req.racingUser.streamer_id) {
      streamer = db.getStreamerById(req.racingUser.streamer_id);
    }
    if (!streamer && req.body.bridge_id && /^[a-f0-9-]{20,}$/i.test(req.body.bridge_id)) {
      const ru = db.getRacingUserByBridgeId(req.body.bridge_id);
      if (ru && ru.streamer_id) streamer = db.getStreamerById(ru.streamer_id);
    }
    if (!streamer || !streamer.spotify_access_token) return res.json({ ok: false });

    const { refreshSpotifyToken } = require('./services/spotify');
    let token = streamer.spotify_access_token;
    if (streamer.spotify_token_expires_at && Date.now() >= streamer.spotify_token_expires_at) {
      token = await refreshSpotifyToken(streamer);
    }
    if (!token) return res.json({ ok: false });

    const { action } = req.body;
    const endpoints = {
      play: { method: 'PUT', path: '/v1/me/player/play' },
      pause: { method: 'PUT', path: '/v1/me/player/pause' },
      next: { method: 'POST', path: '/v1/me/player/next' },
      previous: { method: 'POST', path: '/v1/me/player/previous' },
    };
    const ep = endpoints[action];
    if (!ep) return res.json({ ok: false, error: 'Invalid action' });

    await fetch('https://api.spotify.com' + ep.path, {
      method: ep.method,
      headers: { Authorization: 'Bearer ' + token },
    });
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false });
  }
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
app.get('/api/track-maps', (req, res) => {
  try {
    const rows = db.db.prepare('SELECT track_name, point_count, track_length, track_turns, track_country, track_city, created_at, updated_at FROM track_maps ORDER BY track_name').all();
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/track-map/:trackName', (req, res) => {
  try {
    const row = db.db.prepare('SELECT track_data FROM track_maps WHERE track_name = ?').get(req.params.trackName);
    if (!row) return res.status(404).json({ error: 'Track not found' });
    res.json({ trackName: req.params.trackName, trackData: JSON.parse(row.track_data) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/track-map', (req, res) => {
  try {
    const { trackName, trackData, trackLength, trackTurns, trackCountry, trackCity } = req.body;
    if (!trackName || typeof trackName !== 'string' || trackName.length > 200) {
      return res.status(400).json({ error: 'Invalid track name' });
    }
    if (!trackData || !Array.isArray(trackData) || trackData.length < 50 || trackData.length > 50000) {
      return res.status(400).json({ error: 'Invalid track data' });
    }
    // Accept both {x,y,pct} objects and [x,y] arrays
    const isObjectFormat = trackData.length > 0 && typeof trackData[0] === 'object' && !Array.isArray(trackData[0]) && 'x' in trackData[0];
    const isArrayFormat = trackData.length > 0 && Array.isArray(trackData[0]);
    if (!isObjectFormat && !isArrayFormat) {
      return res.status(400).json({ error: 'Invalid track data format' });
    }
    if (isArrayFormat && !trackData.every(p => Array.isArray(p) && p.length >= 2 && p.every(v => typeof v === 'number' && isFinite(v)))) {
      return res.status(400).json({ error: 'Invalid track data format' });
    }
    if (isObjectFormat && !trackData.every(p => typeof p.x === 'number' && isFinite(p.x) && typeof p.y === 'number' && isFinite(p.y))) {
      return res.status(400).json({ error: 'Invalid track data format' });
    }
    const json = JSON.stringify(trackData);
    const existing = db.db.prepare('SELECT point_count FROM track_maps WHERE track_name = ?').get(trackName);
    if (existing && existing.point_count >= trackData.length) {
      // Still update metadata if provided
      if (trackLength || trackTurns || trackCountry || trackCity) {
        db.db.prepare(`UPDATE track_maps SET track_length = COALESCE(?, track_length), track_turns = COALESCE(?, track_turns), track_country = COALESCE(?, track_country), track_city = COALESCE(?, track_city), updated_at = datetime('now') WHERE track_name = ?`)
          .run(trackLength || null, trackTurns || null, trackCountry || null, trackCity || null, trackName);
      }
      return res.json({ status: 'exists', message: 'Better or equal track already stored' });
    }
    db.db.prepare(`INSERT INTO track_maps (track_name, track_data, point_count, track_length, track_turns, track_country, track_city) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(track_name) DO UPDATE SET track_data = excluded.track_data, point_count = excluded.point_count, track_length = COALESCE(excluded.track_length, track_length), track_turns = COALESCE(excluded.track_turns, track_turns), track_country = COALESCE(excluded.track_country, track_country), track_city = COALESCE(excluded.track_city, track_city), updated_at = datetime('now')
    `).run(trackName, json, trackData.length, trackLength || null, trackTurns || null, trackCountry || null, trackCity || null);
    res.json({ status: 'ok', points: trackData.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Track stats API (public — must be before /api auth middleware)
app.post('/api/track-stats', express.json(), (req, res) => {
  try {
    const { trackName, raceType, stats } = req.body;
    if (!trackName || !raceType || !stats) return res.status(400).json({ error: 'Missing fields' });

    const stmt = db.db.prepare(`
      INSERT INTO track_stats (track_name, car_class, race_type, avg_lap_time, avg_pit_time, avg_qualify_time, avg_sof, est_laps, avg_drivers, race_count, top_car, category, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(track_name, car_class, race_type) DO UPDATE SET
        avg_lap_time = (avg_lap_time * race_count + excluded.avg_lap_time) / (race_count + excluded.race_count),
        avg_pit_time = CASE WHEN excluded.avg_pit_time > 0
          THEN (CASE WHEN avg_pit_time > 0 THEN (avg_pit_time * race_count + excluded.avg_pit_time) / (race_count + excluded.race_count) ELSE excluded.avg_pit_time END)
          ELSE avg_pit_time END,
        avg_qualify_time = CASE WHEN excluded.avg_qualify_time > 0
          THEN (CASE WHEN avg_qualify_time > 0 THEN (avg_qualify_time * race_count + excluded.avg_qualify_time) / (race_count + excluded.race_count) ELSE excluded.avg_qualify_time END)
          ELSE avg_qualify_time END,
        avg_sof = (avg_sof * race_count + excluded.avg_sof) / (race_count + excluded.race_count),
        est_laps = CASE WHEN excluded.est_laps > 0
          THEN (CASE WHEN est_laps > 0 THEN (est_laps * race_count + excluded.est_laps) / (race_count + excluded.race_count) ELSE excluded.est_laps END)
          ELSE est_laps END,
        avg_drivers = (avg_drivers * race_count + excluded.avg_drivers) / (race_count + excluded.race_count),
        race_count = race_count + excluded.race_count,
        top_car = COALESCE(excluded.top_car, top_car),
        category = COALESCE(excluded.category, category),
        updated_at = datetime('now')
    `);

    Object.entries(stats).forEach(([cls, data]) => {
      stmt.run(trackName, cls, raceType, data.avgLapTime || 0, data.avgPitTime || 0, data.avgQualifyTime || 0, data.avgSOF || 0, data.estLaps || 0, data.samples || 0, 1, data.topCar || null, data.category || 'road');
    });

    res.json({ ok: true });
  } catch(e) {
    console.error('[TrackStats] POST error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Screenshot import — analyze Garage61 screenshot via GPT-4o vision
app.post('/api/track-stats/import-screenshot', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    if (!req.streamer) return res.status(401).json({ error: 'Login required' });

    const { image, trackName, carClass, raceType } = req.body;
    if (!image || !trackName) return res.status(400).json({ error: 'image and trackName required' });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OpenAI API key not configured' });

    // Strip data URL prefix if present
    const base64 = image.replace(/^data:image\/\w+;base64,/, '');

    const https = require('https');
    const postData = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'You are analyzing a screenshot from Garage61 (garage61.com), a racing data website for iRacing sim racing. Extract race statistics from the image.\n\nGarage61 shows a results table with columns like: Pos, Driver, Car, Laps Comp, Avg Lap, Best Lap, Q Time (qualify time), SOF, etc.\n\nIMPORTANT extraction rules:\n- avgLapTime: Look at the "Avg Lap" column values for the top drivers. Calculate the average of those values. Do NOT include pit laps or outlier slow laps. The average should be close to the typical clean lap times shown. Convert from "m:ss.xxx" to total seconds.\n- avgQualifyTime: Look at the "Q Time" or qualifying time column. Average the valid qualifying times shown. Convert to seconds.\n- estLaps: Look at the "Laps Comp" (laps completed) column. Use the HIGHEST value shown (race leader laps).\n- avgPitTime: If pit time data is visible, extract it. Otherwise null.\n- avgSOF: Look for "SOF" or "Strength of Field" value.\n- driverCount: Count the number of drivers/rows in the results table.\n- carClass: The car class (GT3, GTP, LMP2, GT4, LMP3, GTE, TCR, Porsche Cup, BMW M2, Toyota, Mazda).\n- raceType: The series/race type (VRS Sprint, VRS Open, IMSA Sprint, IMSA Open, IMSA Endurance, Global Endurance, Sprint, Open, Endurance, Regionals, LMP2 Sprint, Proto Sprint).\n\nReturn ONLY valid JSON, no markdown, no code fences:\n{\n  "carClass": "string or null",\n  "raceType": "string or null",\n  "avgLapTime": number_in_seconds_or_null,\n  "avgQualifyTime": number_in_seconds_or_null,\n  "avgPitTime": number_in_seconds_or_null,\n  "avgSOF": number_or_null,\n  "driverCount": number_or_null,\n  "estLaps": number_or_null\n}\n\nConvert all lap times from "1:17.456" format to total seconds (77.456). Values must be numbers, not strings.'
          },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,' + base64 }
          }
        ]
      }],
      max_tokens: 500,
    });

    const result = await new Promise((resolve, reject) => {
      const apiReq = https.request({
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        timeout: 30000,
      }, (resp) => {
        let body = '';
        resp.on('data', chunk => body += chunk);
        resp.on('end', () => {
          try { resolve(JSON.parse(body)); } catch(e) { reject(new Error('Invalid OpenAI response')); }
        });
      });
      apiReq.on('error', reject);
      apiReq.on('timeout', () => { apiReq.destroy(); reject(new Error('OpenAI request timed out')); });
      apiReq.write(postData);
      apiReq.end();
    });

    if (result.error) {
      console.error('[ScreenshotImport] OpenAI error:', result.error.message);
      return res.status(500).json({ error: 'OpenAI error: ' + result.error.message });
    }

    const content = result.choices?.[0]?.message?.content;
    if (!content) return res.status(500).json({ error: 'No response from OpenAI' });

    let parsed;
    try {
      // Strip markdown code fences if present
      const clean = content.replace(/```json?\s*/g, '').replace(/```\s*/g, '').trim();
      parsed = JSON.parse(clean);
    } catch(e) {
      console.error('[ScreenshotImport] Failed to parse:', content);
      return res.status(500).json({ error: 'Could not parse AI response' });
    }

    // Override with user selections if not "auto"
    const data = {
      carClass: (carClass && carClass !== 'auto') ? carClass : (parsed.carClass || null),
      raceType: (raceType && raceType !== 'auto') ? raceType : (parsed.raceType || null),
      avgLapTime: parsed.avgLapTime ? Number(parsed.avgLapTime) : null,
      avgQualifyTime: parsed.avgQualifyTime ? Number(parsed.avgQualifyTime) : null,
      avgPitTime: parsed.avgPitTime ? Number(parsed.avgPitTime) : null,
      avgSOF: parsed.avgSOF ? Number(parsed.avgSOF) : null,
      driverCount: parsed.driverCount ? Number(parsed.driverCount) : null,
      estLaps: parsed.estLaps ? Number(parsed.estLaps) : null,
    };

    res.json({ ok: true, data });
  } catch(e) {
    console.error('[ScreenshotImport] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// CSV import — parse iRacing/Garage61 CSV data directly
app.post('/api/track-stats/import-csv', express.json({ limit: '10mb' }), (req, res) => {
  try {
    if (!req.streamer) return res.status(401).json({ error: 'Login required' });

    const { csvData, trackName, carClass, raceType, sessionType } = req.body;
    if (!csvData || !trackName) return res.status(400).json({ error: 'csvData and trackName required' });

    // Parse CSV: split by newlines, handle quoted fields
    function parseCSVLine(line) {
      const fields = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { inQuotes = !inQuotes; }
        else if (ch === ',' && !inQuotes) { fields.push(current.trim()); current = ''; }
        else { current += ch; }
      }
      fields.push(current.trim());
      return fields;
    }

    function parseLapTime(str) {
      if (!str || str === '' || str === '00.000') return 0;
      const parts = str.split(':');
      if (parts.length === 2) return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
      return parseFloat(str) || 0;
    }

    const lines = csvData.split('\n').filter(l => l.trim());

    // Find header row and SOF from metadata
    let sof = 0;
    let headerIdx = -1;
    let detectedClass = null;
    let detectedSeries = null;
    for (let i = 0; i < lines.length; i++) {
      const fields = parseCSVLine(lines[i]);
      if (fields[0] === 'Fin Pos') { headerIdx = i; break; }
      // Metadata row: "Start Time","Track","Series",...,"Strength of Field",...
      if (fields.length > 7 && fields[0] !== 'Start Time') {
        sof = parseInt(fields[7]) || 0;
        detectedSeries = fields[2] || null;
      }
    }

    if (headerIdx < 0) return res.status(400).json({ error: 'Could not find header row in CSV' });

    const headers = parseCSVLine(lines[headerIdx]);
    const colIdx = {};
    headers.forEach((h, i) => { colIdx[h] = i; });

    // Parse driver rows
    const drivers = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const fields = parseCSVLine(lines[i]);
      if (fields.length < 5) continue;
      drivers.push({
        qualifyTime: parseLapTime(fields[colIdx['Qualify Time']] || ''),
        avgLapTime: parseLapTime(fields[colIdx['Average Lap Time']] || ''),
        fastestLapTime: parseLapTime(fields[colIdx['Fastest Lap Time']] || ''),
        lapsComp: parseInt(fields[colIdx['Laps Comp']] || '0') || 0,
        carClass: fields[colIdx['Car Class']] || '',
        car: fields[colIdx['Car']] || '',
      });
    }

    if (drivers.length === 0) return res.status(400).json({ error: 'No driver data found in CSV' });

    // Detect car class from data
    if (!detectedClass && drivers[0].carClass) {
      const cls = drivers[0].carClass;
      // Map iRacing class names to our standard names
      if (cls.includes('GT3')) detectedClass = 'GT3';
      else if (cls.includes('GTP') || cls.includes('Hypercar')) detectedClass = 'GTP';
      else if (cls.includes('LMP2')) detectedClass = 'LMP2';
      else if (cls.includes('GT4')) detectedClass = 'GT4';
      else if (cls.includes('LMP3')) detectedClass = 'LMP3';
      else if (cls.includes('GTE')) detectedClass = 'GTE';
      else if (cls.includes('TCR')) detectedClass = 'TCR';
      else if (cls.includes('Porsche')) detectedClass = 'Porsche Cup';
      else if (cls.includes('BMW M2')) detectedClass = 'BMW M2';
      else if (cls.includes('Toyota') || cls.includes('GR86')) detectedClass = 'Toyota';
      else if (cls.includes('Mazda') || cls.includes('MX-5')) detectedClass = 'Mazda';
      else detectedClass = cls;
    }

    // Detect race type from series name
    let detectedRaceType = null;
    if (detectedSeries) {
      const s = detectedSeries.toLowerCase();
      if (s.includes('regional')) detectedRaceType = 'Regionals';
      else if (s.includes('vrs') && s.includes('sprint')) detectedRaceType = 'VRS Sprint';
      else if (s.includes('vrs') && s.includes('open')) detectedRaceType = 'VRS Open';
      else if (s.includes('imsa') && s.includes('sprint')) detectedRaceType = 'IMSA Sprint';
      else if (s.includes('imsa') && s.includes('open')) detectedRaceType = 'IMSA Open';
      else if (s.includes('imsa') && s.includes('endurance')) detectedRaceType = 'IMSA Endurance';
      else if (s.includes('global') && s.includes('endurance')) detectedRaceType = 'Global Endurance';
      else if (s.includes('sprint')) detectedRaceType = 'Sprint';
      else if (s.includes('open')) detectedRaceType = 'Open';
      else if (s.includes('endurance')) detectedRaceType = 'Endurance';
    }

    // Calculate averages from valid drivers
    const validAvgLaps = drivers.filter(d => d.avgLapTime > 0).map(d => d.avgLapTime);
    const validQualTimes = drivers.filter(d => d.qualifyTime > 0).map(d => d.qualifyTime);
    // Fallback: use Fastest Lap Time for qualify average if no Qualify Time column data
    const validFastestLaps = drivers.filter(d => d.fastestLapTime > 0).map(d => d.fastestLapTime);
    const maxLaps = Math.max(...drivers.map(d => d.lapsComp), 0);

    const avgLapTime = validAvgLaps.length > 0 ? validAvgLaps.reduce((a, b) => a + b, 0) / validAvgLaps.length : null;
    const avgQualifyTime = validQualTimes.length > 0
      ? validQualTimes.reduce((a, b) => a + b, 0) / validQualTimes.length
      : (validFastestLaps.length > 0 ? validFastestLaps.reduce((a, b) => a + b, 0) / validFastestLaps.length : null);

    // Most used car — count occurrences
    const carCounts = {};
    drivers.forEach(d => { if (d.car) carCounts[d.car] = (carCounts[d.car] || 0) + 1; });
    const topCar = Object.keys(carCounts).sort((a, b) => carCounts[b] - carCounts[a])[0] || null;

    const data = {
      carClass: (carClass && carClass !== 'auto') ? carClass : (detectedClass || null),
      raceType: (raceType && raceType !== 'auto') ? raceType : (detectedRaceType || null),
      avgLapTime: avgLapTime ? Number(avgLapTime.toFixed(3)) : null,
      avgQualifyTime: avgQualifyTime ? Number(avgQualifyTime.toFixed(3)) : null,
      avgPitTime: null,
      avgSOF: sof || null,
      driverCount: drivers.length,
      estLaps: maxLaps || null,
      topCar,
    };

    res.json({ ok: true, data });
  } catch(e) {
    console.error('[CSVImport] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/track-stats', (req, res) => {
  try {
    const rows = db.db.prepare('SELECT track_name, car_class, race_type, avg_lap_time, avg_pit_time, avg_qualify_time, avg_sof, est_laps, avg_drivers, race_count, top_car, updated_at FROM track_stats ORDER BY track_name, car_class, race_type').all();
    res.json(rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/track-stats/:trackName', (req, res) => {
  try {
    const rows = db.db.prepare('SELECT car_class, race_type, avg_lap_time, avg_pit_time, avg_qualify_time, avg_sof, est_laps, avg_drivers, race_count, top_car, updated_at FROM track_stats WHERE track_name = ? ORDER BY car_class, race_type').all(req.params.trackName);
    res.json(rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Live session heartbeat — Bridge sends current session state every 30s
let liveSession = null;
let liveSessionTime = 0;

app.post('/api/live-session', express.json(), (req, res) => {
  liveSession = req.body;
  liveSessionTime = Date.now();
  res.json({ ok: true });
});

app.get('/api/live-session', (req, res) => {
  // Stale after 60s = no active session
  if (liveSession && (Date.now() - liveSessionTime) < 60000) {
    res.json(liveSession);
  } else {
    res.json(null);
  }
});

app.delete('/api/track-stats/:trackName/:carClass/:raceType', (req, res) => {
  try {
    const { trackName, carClass, raceType } = req.params;
    const result = db.db.prepare('DELETE FROM track_stats WHERE track_name = ? AND car_class = ? AND race_type = ?').run(trackName, carClass, raceType);
    res.json({ ok: true, deleted: result.changes });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Bridge remote logs (public — must be before /api auth middleware)
app.post('/api/bridge-logs', (req, res) => {
  try {
    const { bridgeId, lines, iracingName } = req.body;
    if (!bridgeId || typeof bridgeId !== 'string') return res.status(400).json({ error: 'bridgeId required' });
    if (!lines || typeof lines !== 'string') return res.status(400).json({ error: 'lines required' });
    if (lines.length > 1024 * 1024) return res.status(400).json({ error: 'Payload too large (max 1MB)' });
    db.insertBridgeLogs(bridgeId, lines);
    // Store iRacing name if provided
    if (iracingName && typeof iracingName === 'string') {
      try { db.db.prepare('UPDATE bridge_logs SET iracing_name = ? WHERE bridge_id = ? AND iracing_name IS NULL').run(iracingName, bridgeId); } catch(e) {}
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bridge-ids', (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const ids = db.getActiveBridgeIds(hours);
    res.json({ ids });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bridge-users', (req, res) => {
  try {
    const stats = db.getBridgeUserStats();
    res.json({ users: stats });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bridge-logs/:bridgeId', (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const logs = db.getBridgeLogs(req.params.bridgeId, hours);
    res.json({ logs });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bridge-bug-reports', (req, res) => {
  try {
    const { bridgeId, errorPattern, explanation, suggestedFix } = req.body;
    if (!bridgeId || !errorPattern || !explanation || !suggestedFix) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const id = db.insertBridgeBugReport(bridgeId, errorPattern, explanation, suggestedFix);
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bridge-bug-reports', (req, res) => {
  try {
    const { bridgeId, status } = req.query;
    if (!bridgeId) return res.status(400).json({ error: 'bridgeId required' });
    const reports = db.getBridgeBugReports(bridgeId, status);
    res.json({ reports });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/bridge-bug-reports/:id', (req, res) => {
  try {
    const { bridgeId, status } = req.body;
    if (!bridgeId) return res.status(400).json({ error: 'bridgeId required' });
    if (!['approved', 'dismissed'].includes(status)) {
      return res.status(400).json({ error: 'Status must be approved or dismissed' });
    }
    db.updateBridgeBugReportStatus(req.params.id, bridgeId, status);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Session upload & query API (public — must be before /api auth middleware)
app.post('/api/session', express.json({ limit: '10mb' }), (req, res) => {
  try {
    const { bridge_id, iracing_name, session, laps, telemetry } = req.body;
    if (!bridge_id || !iracing_name || !session || !laps) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!session.track_name || !session.car_class || !session.session_type) {
      return res.status(400).json({ error: 'Missing session fields' });
    }
    // Look up racing user from bridge_id
    let racingUserId = null;
    if (bridge_id) {
      const ru = db.getRacingUserByBridgeId(bridge_id);
      if (ru) racingUserId = ru.id;
    }

    const shareToken = crypto.randomBytes(9).toString('base64url');
    const sessionId = db.insertSession({
      bridge_id,
      iracing_name,
      track_name: session.track_name,
      car_class: session.car_class,
      car_name: session.car_name || '',
      session_type: session.session_type,
      race_type: session.race_type || null,
      is_public: 0,
      share_token: shareToken,
      conditions: session.conditions ? JSON.stringify(session.conditions) : null,
      sof: session.sof || null,
      finish_position: session.finish_position || null,
      irating_change: session.irating_change || null,
      driver_count: session.driver_count || null,
      best_lap_time: session.best_lap_time || null,
      lap_count: session.lap_count || laps.length,
      racing_user_id: racingUserId,
    }, laps.map(l => ({
      lap_number: l.lap_number,
      lap_time: l.lap_time,
      sector_times: l.sector_times ? JSON.stringify(l.sector_times) : null,
      fuel_used: l.fuel_used || null,
      air_temp: l.air_temp || null,
      track_temp: l.track_temp || null,
      is_pit_lap: l.is_pit_lap ? 1 : 0,
      position: l.position || null,
      incidents: l.incidents || null,
      is_valid: l.is_valid !== false ? 1 : 0,
    })), telemetry || []);

    res.json({ id: sessionId, share_token: shareToken });
  } catch(e) {
    console.error('[Session Upload]', e.message);
    res.status(500).json({ error: 'Failed to store session' });
  }
});

app.get('/api/sessions/:trackName', (req, res) => {
  try {
    const bridgeId = req.query.bridge_id || '';
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const sessions = db.getSessionsByTrack(req.params.trackName, bridgeId, limit, offset);
    res.json(sessions);
  } catch(e) {
    console.error('[Sessions Query]', e.message);
    res.status(500).json({ error: 'Query failed' });
  }
});

// NOTE: share route must come before :id route to avoid "share" being captured as an id
app.get('/api/session/share/:token', (req, res) => {
  try {
    const session = db.getSessionByShareToken(req.params.token);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const laps = db.getSessionLaps(session.id);
    res.json({ session, laps });
  } catch(e) {
    console.error('[Session Share]', e.message);
    res.status(500).json({ error: 'Query failed' });
  }
});

app.get('/api/session/:id', (req, res) => {
  try {
    const session = db.getRacingSessionById(parseInt(req.params.id));
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const bridgeId = req.query.bridge_id || '';
    const token = req.query.token || '';
    if (session.bridge_id !== bridgeId && !session.is_public && session.share_token !== token) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const laps = db.getSessionLaps(session.id);
    res.json({ session, laps });
  } catch(e) {
    console.error('[Session Detail]', e.message);
    res.status(500).json({ error: 'Query failed' });
  }
});

app.get('/api/session/:id/telemetry/:lapId', (req, res) => {
  try {
    const session = db.getRacingSessionById(parseInt(req.params.id));
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const bridgeId = req.query.bridge_id || '';
    const token = req.query.token || '';
    if (session.bridge_id !== bridgeId && !session.is_public && session.share_token !== token) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const data = db.getLapTelemetry(parseInt(req.params.lapId));
    if (!data) return res.status(404).json({ error: 'Telemetry not found' });
    res.json({ data });
  } catch(e) {
    console.error('[Telemetry]', e.message);
    res.status(500).json({ error: 'Query failed' });
  }
});

// Append a single lap to an existing session (progressive upload)
app.post('/api/session/:id/lap', express.json({ limit: '5mb' }), (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const session = db.getRacingSessionById(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const { lap, telemetry } = req.body;
    if (!lap || !lap.lap_number || !lap.lap_time) return res.status(400).json({ error: 'Missing lap data' });

    const lapResult = db.insertSingleLap(sessionId, {
      lap_number: lap.lap_number,
      lap_time: lap.lap_time,
      sector_times: lap.sector_times ? JSON.stringify(lap.sector_times) : null,
      fuel_used: lap.fuel_used || null,
      air_temp: lap.air_temp || null,
      track_temp: lap.track_temp || null,
      is_pit_lap: lap.is_pit_lap ? 1 : 0,
      position: lap.position || null,
      incidents: lap.incidents || null,
      is_valid: lap.is_valid !== false ? 1 : 0,
    }, telemetry || null);

    // Update session best lap and lap count
    db.updateSessionLapStats(sessionId, lap.lap_time);

    res.json({ ok: true, lap_id: lapResult });
  } catch(e) {
    console.error('[Session Lap Append]', e.message);
    res.status(500).json({ error: 'Failed to append lap' });
  }
});

// Update session with final stats (position, iRating change)
app.patch('/api/session/:id/finish', express.json(), (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const { finish_position, irating_change, best_lap_time } = req.body;
    db.updateSessionFinish(sessionId, finish_position, irating_change, best_lap_time);

    // Notifications for race results + iRating milestones
    try {
      const session = db.getRacingSessionById(sessionId);
      if (session && session.session_type === 'race') {
        const user = session.bridge_id ? db.getRacingUserByBridgeId(session.bridge_id) : null;
        if (user) {
          // Race result notification
          const pos = finish_position ? 'P' + finish_position : '';
          const ir = irating_change ? (irating_change > 0 ? ' (+' + irating_change + ' iR)' : ' (' + irating_change + ' iR)') : '';
          const raceType = session.race_type ? ' — ' + session.race_type : '';
          db.createNotification(user.id, 'race_result', 'Race result', pos + ' at ' + session.track_name + raceType + ir, '/api/session/' + sessionId + '?bridge_id=' + session.bridge_id, null, null);

          // iRating milestone check
          if (irating_change && irating_change > 0) {
            const milestones = [1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000];
            // We don't have cumulative iRating stored, but we can check if the change crosses a threshold
            // The Bridge sends irating_change as the delta. We'd need current iRating to check milestones.
            // For now, skip — this requires Bridge to send current_irating in the finish payload.
          }
        }
      }
    } catch(notifErr) {
      console.error('[Session Finish Notification]', notifErr.message);
    }

    res.json({ ok: true });
  } catch(e) {
    console.error('[Session Finish]', e.message);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

app.patch('/api/session/:id', express.json(), (req, res) => {
  try {
    const bridgeId = req.query.bridge_id || req.body.bridge_id;
    if (!bridgeId) return res.status(400).json({ error: 'bridge_id required' });
    if (req.body.is_public !== undefined) {
      db.updateSessionPublic(parseInt(req.params.id), bridgeId, req.body.is_public);

      // Notify teammates when session is shared
      if (req.body.is_public) {
        try {
          const session = db.getRacingSessionById(parseInt(req.params.id));
          const user = bridgeId ? db.getRacingUserByBridgeId(bridgeId) : null;
          if (user && session) {
            const membership = db.getTeamForUser(user.id);
            if (membership) {
              db.notifyTeamMembers(membership.team_id, user.id, 'session_shared', 'Session shared', user.username + ' shared a session at ' + session.track_name, '/api/session/' + req.params.id + '?bridge_id=' + bridgeId);
            }
          }
        } catch(notifErr) {
          console.error('[Session Share Notification]', notifErr.message);
        }
      }
    }
    res.json({ ok: true });
  } catch(e) {
    console.error('[Session Update]', e.message);
    res.status(500).json({ error: 'Update failed' });
  }
});

app.delete('/api/session/:id', (req, res) => {
  try {
    const bridgeId = req.query.bridge_id;
    if (!bridgeId) return res.status(400).json({ error: 'bridge_id required' });
    const result = db.deleteRacingSession(parseInt(req.params.id), bridgeId);
    if (result.changes === 0) return res.status(404).json({ error: 'Session not found or not owned' });
    res.json({ ok: true });
  } catch(e) {
    console.error('[Session Delete]', e.message);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// Track Database page — accessible to streamers and racing users
app.get('/tracks', (req, res) => {
  if (!req.streamer && !req.racingUser) return res.redirect('/racing');
  res.render('tracks', { streamer: req.streamer || null, racingUser: req.racingUser || null, t: res.locals.t });
});
app.get('/tracks/:trackName', (req, res) => {
  if (!req.streamer && !req.racingUser) return res.redirect('/racing');
  res.render('tracks', { streamer: req.streamer || null, racingUser: req.racingUser || null, t: res.locals.t });
});

app.use('/api', apiLimiter, apiRoutes);
app.use('/admin', adminRoutes);
app.use('/vtuber', vtuberRoutes);
app.use('/sync', syncRoutes);
app.use('/overlay', overlayRoutes);


// Language switch
app.post('/set-language', (req, res) => {
  const lang = SUPPORTED_LANGS.includes(req.body.lang) ? req.body.lang : 'en';
  secureCookie(res, 'lang', lang, { maxAge: 365 * 24 * 60 * 60 * 1000 });
  const referer = req.headers.referer || '/';
  res.redirect(referer);
});

// Health check
app.get('/health', (req, res) => res.send('OK'));

function start() {
  const port = config.app.port;
  const server = app.listen(port, () => {
    console.log(`[Server] Dashboard at ${config.app.url}`);
  });

  // Pitwall WebSocket relay
  const pitwallRelay = require('./services/pitwallRelay');
  pitwallRelay.init(server);

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
