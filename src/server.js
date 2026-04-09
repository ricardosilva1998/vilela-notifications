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
app.use(express.json({ limit: '10mb' }));

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
    if (!trackName || !trackData || !Array.isArray(trackData) || trackData.length < 50) {
      return res.status(400).json({ error: 'Invalid track data' });
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
      INSERT INTO track_stats (track_name, car_class, race_type, avg_lap_time, avg_pit_time, avg_qualify_time, avg_sof, est_laps, avg_drivers, race_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
        updated_at = datetime('now')
    `);

    Object.entries(stats).forEach(([cls, data]) => {
      stmt.run(trackName, cls, raceType, data.avgLapTime || 0, data.avgPitTime || 0, data.avgQualifyTime || 0, data.avgSOF || 0, data.estLaps || 0, data.samples || 0, 1);
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

app.get('/api/track-stats', (req, res) => {
  try {
    const rows = db.db.prepare('SELECT track_name, car_class, race_type, avg_lap_time, avg_pit_time, avg_qualify_time, avg_sof, est_laps, avg_drivers, race_count, updated_at FROM track_stats ORDER BY track_name, car_class, race_type').all();
    res.json(rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/track-stats/:trackName', (req, res) => {
  try {
    const rows = db.db.prepare('SELECT car_class, race_type, avg_lap_time, avg_pit_time, avg_qualify_time, avg_sof, est_laps, avg_drivers, race_count, updated_at FROM track_stats WHERE track_name = ? ORDER BY car_class, race_type').all(req.params.trackName);
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

// Track Database page
app.get('/tracks', (req, res) => {
  if (!req.streamer) return res.redirect('/');
  res.render('tracks', { streamer: req.streamer, t: res.locals.t });
});
app.get('/tracks/:trackName', (req, res) => {
  if (!req.streamer) return res.redirect('/');
  res.render('tracks', { streamer: req.streamer, t: res.locals.t });
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
