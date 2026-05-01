# Session Capture Pipeline — Implementation Plan (Phase 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridge captures per-lap data + telemetry traces during practice/qualify/race sessions and uploads to the server, creating the foundation for the track page and lap comparison features (Phases 2 & 3).

**Architecture:** Bridge's telemetry.js poll loop (33ms/30Hz) feeds a new sessionRecorder.js module that buffers 10Hz telemetry samples per lap. On session end (session number change, disconnect, or app quit), the recorder builds a payload and uploads to `POST /api/session`. Server stores in 3 new SQLite tables (sessions → session_laps → lap_telemetry) with cascade deletes. Failed uploads retry from a local queue file.

**Tech Stack:** Node.js, SQLite (better-sqlite3), Express, pako (gzip), existing Bridge telemetry infrastructure

**Spec:** `docs/superpowers/specs/2026-04-10-session-data-lap-history-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `bridge/package.json` | Modify | Add `pako` dependency |
| `bridge/sessionRecorder.js` | Create | Session recording: telemetry buffering, lap detection, session building, upload, retry |
| `bridge/telemetry.js` | Modify | Hook sessionRecorder into poll loop, feed it telemetry data each poll |
| `bridge/main.js` | Modify | Flush pending session on before-quit |
| `src/db.js` | Modify | New tables (sessions, session_laps, lap_telemetry) + query functions |
| `src/server.js` | Modify | New API endpoints for session upload, query, share, delete |

---

### Task 1: Add pako dependency

**Files:**
- Modify: `bridge/package.json`

- [ ] **Step 1: Install pako**

```bash
cd bridge && npm install pako --save
```

- [ ] **Step 2: Verify it was added to package.json**

```bash
grep pako bridge/package.json
```

Expected: `"pako": "^2.x.x"` in dependencies

- [ ] **Step 3: Commit**

```bash
git add bridge/package.json bridge/package-lock.json
git commit -m "feat: add pako for telemetry gzip compression"
```

---

### Task 2: Database migration — sessions, session_laps, lap_telemetry tables

**Files:**
- Modify: `src/db.js` (after the track_stats table creation at ~line 810)

- [ ] **Step 1: Add table creation statements**

Add after the existing `track_stats` table migration block (~line 810) in `src/db.js`:

```js
// ── Session data tables (session capture pipeline) ──────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bridge_id TEXT NOT NULL,
    iracing_name TEXT NOT NULL,
    track_name TEXT NOT NULL,
    car_class TEXT NOT NULL,
    car_name TEXT NOT NULL,
    session_type TEXT NOT NULL,
    race_type TEXT,
    is_public INTEGER DEFAULT 0,
    share_token TEXT,
    conditions TEXT,
    sof INTEGER,
    finish_position INTEGER,
    irating_change INTEGER,
    driver_count INTEGER,
    best_lap_time REAL,
    lap_count INTEGER,
    created_at DATETIME DEFAULT (datetime('now'))
  )
`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_track ON sessions(track_name)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_bridge ON sessions(bridge_id)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_share ON sessions(share_token)'); } catch(e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS session_laps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    lap_number INTEGER NOT NULL,
    lap_time REAL NOT NULL,
    sector_times TEXT,
    fuel_used REAL,
    air_temp REAL,
    track_temp REAL,
    is_pit_lap INTEGER DEFAULT 0,
    position INTEGER,
    incidents INTEGER,
    is_valid INTEGER DEFAULT 1
  )
`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_session_laps_session ON session_laps(session_id)'); } catch(e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS lap_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lap_id INTEGER NOT NULL REFERENCES session_laps(id) ON DELETE CASCADE,
    data TEXT NOT NULL
  )
`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_lap_telemetry_lap ON lap_telemetry(lap_id)'); } catch(e) {}
```

- [ ] **Step 2: Verify server starts without errors**

```bash
npm run dev
```

Check console for any SQLite errors. Tables should be created on first startup.

- [ ] **Step 3: Commit**

```bash
git add src/db.js
git commit -m "feat: add sessions, session_laps, lap_telemetry tables"
```

---

### Task 3: Database query functions

**Files:**
- Modify: `src/db.js` (add near the bottom, before `module.exports`)

- [ ] **Step 1: Add prepared statements and query functions**

Add before the `module.exports` block in `src/db.js`:

```js
// ── Session data queries ────────────────────────────────────────────

const _insertSession = db.prepare(`
  INSERT INTO sessions (bridge_id, iracing_name, track_name, car_class, car_name, session_type, race_type, is_public, share_token, conditions, sof, finish_position, irating_change, driver_count, best_lap_time, lap_count)
  VALUES (@bridge_id, @iracing_name, @track_name, @car_class, @car_name, @session_type, @race_type, @is_public, @share_token, @conditions, @sof, @finish_position, @irating_change, @driver_count, @best_lap_time, @lap_count)
`);

const _insertSessionLap = db.prepare(`
  INSERT INTO session_laps (session_id, lap_number, lap_time, sector_times, fuel_used, air_temp, track_temp, is_pit_lap, position, incidents, is_valid)
  VALUES (@session_id, @lap_number, @lap_time, @sector_times, @fuel_used, @air_temp, @track_temp, @is_pit_lap, @position, @incidents, @is_valid)
`);

const _insertLapTelemetry = db.prepare(`
  INSERT INTO lap_telemetry (lap_id, data) VALUES (@lap_id, @data)
`);

const _getSessionsByTrack = db.prepare(`
  SELECT s.*, (SELECT COUNT(*) FROM session_laps WHERE session_id = s.id) as actual_laps
  FROM sessions s
  WHERE s.track_name = @track_name AND (s.bridge_id = @bridge_id OR s.is_public = 1)
  ORDER BY s.created_at DESC
  LIMIT @limit OFFSET @offset
`);

const _getSessionById = db.prepare(`
  SELECT * FROM sessions WHERE id = @id
`);

const _getSessionByShareToken = db.prepare(`
  SELECT * FROM sessions WHERE share_token = @token
`);

const _getSessionLaps = db.prepare(`
  SELECT * FROM session_laps WHERE session_id = @session_id ORDER BY lap_number ASC
`);

const _getLapTelemetry = db.prepare(`
  SELECT data FROM lap_telemetry WHERE lap_id = @lap_id
`);

const _updateSessionPublic = db.prepare(`
  UPDATE sessions SET is_public = @is_public WHERE id = @id AND bridge_id = @bridge_id
`);

const _deleteSession = db.prepare(`
  DELETE FROM sessions WHERE id = @id AND bridge_id = @bridge_id
`);

function insertSession(session, laps, telemetry) {
  const txn = db.transaction(() => {
    const result = _insertSession.run(session);
    const sessionId = result.lastInsertRowid;
    for (const lap of laps) {
      const lapResult = _insertSessionLap.run({ ...lap, session_id: sessionId });
      const lapId = lapResult.lastInsertRowid;
      const tel = telemetry.find(t => t.lap_number === lap.lap_number);
      if (tel && tel.data) {
        _insertLapTelemetry.run({ lap_id: lapId, data: tel.data });
      }
    }
    return sessionId;
  });
  return txn();
}

function getSessionsByTrack(trackName, bridgeId, limit, offset) {
  return _getSessionsByTrack.all({ track_name: trackName, bridge_id: bridgeId || '', limit: limit || 50, offset: offset || 0 });
}

function getSessionById(id) {
  return _getSessionById.get({ id });
}

function getSessionByShareToken(token) {
  return _getSessionByShareToken.get({ token });
}

function getSessionLaps(sessionId) {
  return _getSessionLaps.all({ session_id: sessionId });
}

function getLapTelemetry(lapId) {
  const row = _getLapTelemetry.get({ lap_id: lapId });
  return row ? row.data : null;
}

function updateSessionPublic(id, bridgeId, isPublic) {
  return _updateSessionPublic.run({ id, bridge_id: bridgeId, is_public: isPublic ? 1 : 0 });
}

function deleteSession(id, bridgeId) {
  return _deleteSession.run({ id, bridge_id: bridgeId });
}
```

- [ ] **Step 2: Export the new functions**

Add to the `module.exports` block in `src/db.js`:

```js
  insertSession,
  getSessionsByTrack,
  getSessionById,
  getSessionByShareToken,
  getSessionLaps,
  getLapTelemetry,
  updateSessionPublic,
  deleteSession,
```

- [ ] **Step 3: Verify server starts**

```bash
npm run dev
```

- [ ] **Step 4: Commit**

```bash
git add src/db.js
git commit -m "feat: add session data query functions"
```

---

### Task 4: Server API — Session upload endpoint

**Files:**
- Modify: `src/server.js` (add after the track-stats endpoints, before auth middleware, ~line 460)

- [ ] **Step 1: Add POST /api/session endpoint**

Add in the public Bridge API section of `src/server.js` (after track-stats endpoints, before auth middleware):

```js
// ── Session data upload (Bridge → Server) ───────────────────────────
const crypto = require('crypto');

app.post('/api/session', express.json({ limit: '10mb' }), (req, res) => {
  try {
    const { bridge_id, iracing_name, session, laps, telemetry } = req.body;
    if (!bridge_id || !iracing_name || !session || !laps) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!session.track_name || !session.car_class || !session.session_type) {
      return res.status(400).json({ error: 'Missing session fields' });
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
```

- [ ] **Step 2: Verify endpoint works**

```bash
curl -X POST http://localhost:3000/api/session \
  -H "Content-Type: application/json" \
  -d '{"bridge_id":"test-123","iracing_name":"TestDriver","session":{"track_name":"Spa","car_class":"GT3","car_name":"Ferrari","session_type":"practice"},"laps":[{"lap_number":1,"lap_time":120.5}],"telemetry":[]}'
```

Expected: `{"id":1,"share_token":"..."}`

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "feat: add POST /api/session endpoint for session upload"
```

---

### Task 5: Server API — Session query endpoints

**Files:**
- Modify: `src/server.js` (add after the POST /api/session endpoint)

- [ ] **Step 1: Add GET endpoints for session queries**

```js
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
    const session = db.getSessionById(parseInt(req.params.id));
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
    const session = db.getSessionById(parseInt(req.params.id));
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

app.patch('/api/session/:id', express.json(), (req, res) => {
  try {
    const bridgeId = req.query.bridge_id || req.body.bridge_id;
    if (!bridgeId) return res.status(400).json({ error: 'bridge_id required' });
    if (req.body.is_public !== undefined) {
      db.updateSessionPublic(parseInt(req.params.id), bridgeId, req.body.is_public);
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
    const result = db.deleteSession(parseInt(req.params.id), bridgeId);
    if (result.changes === 0) return res.status(404).json({ error: 'Session not found or not owned' });
    res.json({ ok: true });
  } catch(e) {
    console.error('[Session Delete]', e.message);
    res.status(500).json({ error: 'Delete failed' });
  }
});
```

- [ ] **Step 2: Test query endpoints**

```bash
# List sessions for a track
curl "http://localhost:3000/api/sessions/Spa?bridge_id=test-123"

# Get session detail
curl "http://localhost:3000/api/session/1?bridge_id=test-123"

# Get via share token
curl "http://localhost:3000/api/session/share/<token-from-step-4>"
```

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "feat: add session query, share, update, delete endpoints"
```

---

### Task 6: Bridge sessionRecorder.js — Core recording module

**Files:**
- Create: `bridge/sessionRecorder.js`

- [ ] **Step 1: Create the session recorder module**

```js
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const pako = require('pako');
const https = require('https');
const http = require('http');

const UPLOAD_URL = 'https://atletanotifications.com/api/session';
const PENDING_FILE = path.join(os.homedir(), 'Documents', 'Atleta Bridge', 'pending-sessions.json');
const LOG_PATH = path.join(os.homedir(), 'atleta-bridge.log');

function log(msg) {
  const line = '[' + new Date().toISOString() + '] [SessionRec] ' + msg + '\n';
  console.log('[SessionRec]', msg);
  try { fs.appendFileSync(LOG_PATH, line); } catch(e) {}
}

// ── State ───────────────────────────────────────────────────────────
let _bridgeId = '';
let _iracingName = '';
let _trackName = '';
let _carClass = '';
let _carName = '';
let _sessionType = '';  // practice, qualify, race
let _sessionNum = -1;
let _recording = false;

// Current lap telemetry buffer (10Hz samples)
let _currentLapSamples = [];
let _lastLapNumber = -1;
let _pollCount = 0;

// Completed laps for current session
let _laps = [];
let _telemetryBuffers = []; // { lap_number, samples: [[t,b,s,g,st,pct], ...] }

// Context tracked per lap
let _lapStartFuel = 0;
let _lapAirTemp = 0;
let _lapTrackTemp = 0;

// Session-level context
let _conditions = {};
let _sof = 0;
let _driverCount = 0;
let _bestLapTime = 0;

// ── Public API ──────────────────────────────────────────────────────

function init(bridgeId) {
  _bridgeId = bridgeId;
  // Retry any pending uploads from previous sessions
  retryPendingUploads();
}

function setIdentity(iracingName) {
  _iracingName = iracingName;
}

/**
 * Called every poll (~33ms) from telemetry.js with current state.
 * Samples telemetry at 10Hz (every 3rd poll).
 */
function poll(data) {
  if (!_recording) return;
  _pollCount++;

  // Sample at 10Hz (every 3rd poll of 33ms ≈ 100ms)
  if (_pollCount % 3 === 0) {
    _currentLapSamples.push([
      Math.round(data.throttle * 1000) / 1000,
      Math.round(data.brake * 1000) / 1000,
      Math.round(data.speed * 100) / 100,
      data.gear,
      Math.round(data.steer * 1000) / 1000,
      Math.round(data.lapDistPct * 10000) / 10000,
    ]);
  }
}

/**
 * Called when a new session is detected (sessionNum changed).
 */
function onSessionStart(sessionNum, trackName, carClass, carName, sessionType, conditions, sof, driverCount) {
  // If we were recording, finalize the previous session first
  if (_recording && _laps.length > 0) {
    finalizeAndUpload();
  }

  _sessionNum = sessionNum;
  _trackName = trackName;
  _carClass = carClass;
  _carName = carName;
  _sessionType = sessionType;
  _conditions = conditions || {};
  _sof = sof || 0;
  _driverCount = driverCount || 0;
  _bestLapTime = 0;
  _laps = [];
  _telemetryBuffers = [];
  _currentLapSamples = [];
  _lastLapNumber = -1;
  _pollCount = 0;
  _recording = true;

  log('Session started: ' + sessionType + ' at ' + trackName + ' in ' + carClass + ' (' + carName + ')');
}

/**
 * Called when a lap is completed by the focused driver.
 * lapData: { lapNumber, lapTime, position, incidents, inPit, fuelLevel, airTemp, trackTemp }
 */
function onLapComplete(lapData) {
  if (!_recording) return;
  if (_lastLapNumber === lapData.lapNumber) return; // duplicate

  const isFirstLap = _lastLapNumber === -1;
  const fuelUsed = _lapStartFuel > 0 && lapData.fuelLevel > 0 ? _lapStartFuel - lapData.fuelLevel : null;

  // Validate lap
  let isValid = true;
  if (isFirstLap) isValid = false; // outlap
  if (lapData.inPit) isValid = false; // pit lap
  if (lapData.lapTime <= 30) isValid = false; // cut/invalid
  if (_bestLapTime > 0 && lapData.lapTime > _bestLapTime * 2) isValid = false; // off-track/incident

  // Track best
  if (isValid && lapData.lapTime > 0 && (_bestLapTime === 0 || lapData.lapTime < _bestLapTime)) {
    _bestLapTime = lapData.lapTime;
  }

  const lap = {
    lap_number: lapData.lapNumber,
    lap_time: lapData.lapTime,
    sector_times: lapData.sectorTimes || null,
    fuel_used: fuelUsed,
    air_temp: lapData.airTemp || _lapAirTemp,
    track_temp: lapData.trackTemp || _lapTrackTemp,
    is_pit_lap: lapData.inPit ? true : false,
    position: lapData.position || null,
    incidents: lapData.incidents || null,
    is_valid: isValid,
  };
  _laps.push(lap);

  // Store telemetry buffer for this lap
  if (_currentLapSamples.length > 0) {
    _telemetryBuffers.push({
      lap_number: lapData.lapNumber,
      samples: _currentLapSamples,
    });
  }

  // Reset for next lap
  _currentLapSamples = [];
  _lastLapNumber = lapData.lapNumber;
  _lapStartFuel = lapData.fuelLevel;
  _lapAirTemp = lapData.airTemp || 0;
  _lapTrackTemp = lapData.trackTemp || 0;

  log('Lap ' + lapData.lapNumber + ': ' + lapData.lapTime.toFixed(3) + 's' + (isValid ? '' : ' (invalid)') + ' — ' + _currentLapSamples.length + ' would be samples, ' + _telemetryBuffers[_telemetryBuffers.length - 1]?.samples.length + ' actual');
}

/**
 * Called when session ends (sessionNum change, disconnect, or quit).
 */
function onSessionEnd(finishPosition, iratingChange) {
  if (!_recording) return;
  _recording = false;

  if (_laps.length === 0) {
    log('Session ended with no laps — skipping upload');
    return;
  }

  // Update session-level fields
  if (finishPosition) _laps._finishPosition = finishPosition;
  if (iratingChange) _laps._iratingChange = iratingChange;

  finalizeAndUpload(finishPosition, iratingChange);
}

/**
 * Force flush on app quit — upload whatever we have.
 */
function flush() {
  if (_recording && _laps.length > 0) {
    _recording = false;
    finalizeAndUpload();
  }
}

// ── Internal ────────────────────────────────────────────────────────

function finalizeAndUpload(finishPosition, iratingChange) {
  const payload = {
    bridge_id: _bridgeId,
    iracing_name: _iracingName,
    session: {
      track_name: _trackName,
      car_class: _carClass,
      car_name: _carName,
      session_type: _sessionType,
      race_type: _sessionType === 'race' ? null : null, // Will be set by telemetry.js if available
      conditions: _conditions,
      sof: _sof || null,
      finish_position: finishPosition || null,
      irating_change: iratingChange || null,
      driver_count: _driverCount || null,
      best_lap_time: _bestLapTime || null,
      lap_count: _laps.length,
    },
    laps: _laps,
    telemetry: _telemetryBuffers.map(t => ({
      lap_number: t.lap_number,
      data: compressTelemetry(t.samples),
    })),
  };

  log('Finalizing session: ' + _laps.length + ' laps, ' + _telemetryBuffers.length + ' with telemetry');

  // Reset state
  _laps = [];
  _telemetryBuffers = [];
  _currentLapSamples = [];
  _bestLapTime = 0;

  uploadSession(payload);
}

function compressTelemetry(samples) {
  try {
    const json = JSON.stringify(samples);
    const compressed = pako.gzip(json);
    return Buffer.from(compressed).toString('base64');
  } catch(e) {
    log('Compression error: ' + e.message);
    return null;
  }
}

function uploadSession(payload) {
  const jsonStr = JSON.stringify(payload);
  const url = new URL(UPLOAD_URL);
  const mod = url.protocol === 'https:' ? https : http;

  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(jsonStr) },
    timeout: 30000,
  };

  const req = mod.request(options, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      if (res.statusCode === 200) {
        log('Session uploaded successfully: ' + body);
      } else {
        log('Upload failed (HTTP ' + res.statusCode + '): ' + body);
        savePending(payload);
      }
    });
  });
  req.on('error', (e) => {
    log('Upload error: ' + e.message);
    savePending(payload);
  });
  req.on('timeout', () => {
    log('Upload timeout');
    req.destroy();
    savePending(payload);
  });
  req.write(jsonStr);
  req.end();
}

function savePending(payload) {
  try {
    let pending = [];
    if (fs.existsSync(PENDING_FILE)) {
      pending = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    }
    // Keep max 20 pending sessions
    if (pending.length >= 20) pending.shift();
    pending.push(payload);
    fs.writeFileSync(PENDING_FILE, JSON.stringify(pending));
    log('Saved to pending queue (' + pending.length + ' pending)');
  } catch(e) {
    log('Failed to save pending: ' + e.message);
  }
}

function retryPendingUploads() {
  try {
    if (!fs.existsSync(PENDING_FILE)) return;
    const pending = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    if (!pending.length) return;
    log('Retrying ' + pending.length + ' pending session uploads');
    // Clear the file first, re-add failures
    fs.writeFileSync(PENDING_FILE, '[]');
    pending.forEach(p => uploadSession(p));
  } catch(e) {
    log('Retry error: ' + e.message);
  }
}

// Allow telemetry.js to set race_type after detection
function setRaceType(raceType) {
  if (_recording) {
    // Store for the current session — will be included in upload
    _laps._raceType = raceType;
  }
}

module.exports = { init, setIdentity, poll, onSessionStart, onLapComplete, onSessionEnd, flush, setRaceType };
```

- [ ] **Step 2: Commit**

```bash
git add bridge/sessionRecorder.js
git commit -m "feat: add sessionRecorder module for lap + telemetry capture"
```

---

### Task 7: Integrate sessionRecorder into telemetry.js

**Files:**
- Modify: `bridge/telemetry.js`

This task hooks the recorder into the existing poll loop. Three integration points:

1. **Top of file:** Require sessionRecorder, init with bridgeId
2. **Poll loop:** Feed telemetry data to recorder each poll
3. **Session change / disconnect:** Call onSessionStart, onLapComplete, onSessionEnd

- [ ] **Step 1: Require and init sessionRecorder**

At the top of `bridge/telemetry.js`, after other requires:

```js
const sessionRecorder = require('./sessionRecorder');
```

In the initialization section (where `bridgeId` is available from settings — near the `pollInterval` setup at ~line 554), add:

```js
sessionRecorder.init(settings.bridgeId || '');
```

- [ ] **Step 2: Feed telemetry data in the poll loop**

Inside the poll loop (after the inputs broadcast at ~line 829), add:

```js
// Feed session recorder at every poll (it samples internally at 10Hz)
sessionRecorder.poll({
  throttle,
  brake,
  speed,
  gear,
  steer,
  lapDistPct: lapDistPct[playerCarIdx] || 0,
});
```

- [ ] **Step 3: Hook session start detection**

At the session number change detection (~line 582, where `sessionNum !== lastSessionNum`), add after the existing session change logic:

```js
// Start recording new session
const sessionTypes = { Practice: 'practice', 'Lone Qualify': 'qualify', 'Open Qualify': 'qualify', Race: 'race' };
const sType = sessionTypes[currentSessionType] || 'practice';
const playerCar = lastStandings.find(d => d.isPlayer);
sessionRecorder.setIdentity(playerIRacingName || '');
sessionRecorder.onSessionStart(
  sessionNum,
  trackName,
  playerCar ? playerCar.carClass : '',
  playerCar ? playerCar.carMake : '',
  sType,
  { airTemp: airTemp || 0, trackTemp: trackTemp || 0, humidity: humidity || 0, skies: skies || '', windSpeed: windSpeed || 0 },
  lastSofByClass && playerCar ? (lastSofByClass[playerCar.carClass] || 0) : 0,
  lastStandings.length
);
```

- [ ] **Step 4: Hook lap completion detection**

In the standings processing loop, where `lastLap` changes are detected for the player car (the focused driver lap detection logic), add:

```js
// Record completed lap
if (isPlayer && lastLapChanged && lastLapVal > 0) {
  sessionRecorder.onLapComplete({
    lapNumber: lapsCompleted,
    lapTime: lastLapVal,
    sectorTimes: null, // iRacing SDK doesn't expose sector times directly
    position: classPosition,
    incidents: incidentCount,
    inPit: inPit,
    fuelLevel: fuelLevel,
    airTemp: airTemp,
    trackTemp: trackTemp,
  });
}
```

Note: The exact variable names (`lastLapChanged`, `lapsCompleted`, `classPosition`, etc.) must match the existing variables in telemetry.js at the point of integration. Read the surrounding code to use the correct variable names — the names above are representative.

- [ ] **Step 5: Hook session end on disconnect**

At the iRacing disconnect handler (~line 564, where `collectAndUploadTrackStats` is called on disconnect during race), add:

```js
sessionRecorder.onSessionEnd();
```

Also at the session number change block (~line 582-590), before the new session starts:

```js
// End previous session recording
const prevPlayerCar = lastStandings.find(d => d.isPlayer);
sessionRecorder.onSessionEnd(
  prevPlayerCar ? prevPlayerCar.classPosition : null,
  prevPlayerCar ? (prevPlayerCar.iRating - prevPlayerCar.startIRating) : null
);
```

- [ ] **Step 6: Hook race type detection**

Where `getRaceType()` is called and the race type is determined (in the standings/session processing), add:

```js
if (raceType) sessionRecorder.setRaceType(raceType);
```

- [ ] **Step 7: Commit**

```bash
git add bridge/telemetry.js
git commit -m "feat: integrate sessionRecorder into telemetry poll loop"
```

---

### Task 8: Integrate flush into main.js before-quit

**Files:**
- Modify: `bridge/main.js` (line ~687, the `before-quit` handler)

- [ ] **Step 1: Require sessionRecorder and flush on quit**

At the top of `bridge/main.js`, add with other requires:

```js
const sessionRecorder = require('./sessionRecorder');
```

In the `before-quit` handler (line ~687-696), add `sessionRecorder.flush()` before the existing cleanup:

```js
app.on('before-quit', () => {
  sessionRecorder.flush(); // Upload any in-progress session
  persistSettings();
  quitting = true;
  // ... rest of existing cleanup
});
```

- [ ] **Step 2: Commit**

```bash
git add bridge/main.js
git commit -m "feat: flush session data on Bridge quit"
```

---

### Task 9: Version bump + final verification

**Files:**
- Modify: `bridge/package.json`

- [ ] **Step 1: Bump version**

In `bridge/package.json`, change version from `3.12.3` to `3.13.0` (minor bump for new feature).

- [ ] **Step 2: Manual verification checklist**

1. Start the server (`npm run dev`)
2. Start Bridge, connect to iRacing
3. Enter a practice session — check `atleta-bridge.log` for `[SessionRec] Session started: practice at ...`
4. Complete a few laps — check log for `[SessionRec] Lap N: XX.XXXs`
5. Exit to main menu (session change) — check log for `[SessionRec] Finalizing session: N laps`
6. Check log for `[SessionRec] Session uploaded successfully`
7. Verify data on server: `curl "http://localhost:3000/api/sessions/TrackName?bridge_id=YOUR_BRIDGE_ID"`
8. Test the share endpoint: `curl "http://localhost:3000/api/session/share/TOKEN"`
9. Test telemetry endpoint: `curl "http://localhost:3000/api/session/1/telemetry/1?bridge_id=YOUR_BRIDGE_ID"`
10. Kill Bridge mid-session → restart → check `[SessionRec] Retrying N pending session uploads`

- [ ] **Step 3: Commit**

```bash
git add bridge/package.json
git commit -m "v3.13.0: session capture pipeline — per-lap data + telemetry upload"
```

---

## Verification Summary

After all tasks are complete:

| Check | How to verify |
|-------|---------------|
| Practice laps captured | Log shows `[SessionRec] Lap N` during practice |
| Telemetry sampled at 10Hz | Log shows sample counts (~900 for 90s lap) |
| Session uploaded on end | Log shows `Session uploaded successfully` |
| Data in database | `GET /api/sessions/:track` returns session |
| Laps in database | `GET /api/session/:id` returns session + laps |
| Telemetry in database | `GET /api/session/:id/telemetry/:lapId` returns gzip data |
| Share token works | `GET /api/session/share/:token` returns session |
| Privacy default private | New sessions have `is_public: 0` |
| Toggle public works | `PATCH /api/session/:id` with `is_public: true` |
| Delete works | `DELETE /api/session/:id` removes session + laps + telemetry |
| Failed upload queued | Disconnect network → session saved to `pending-sessions.json` |
| Retry on restart | Reconnect → pending sessions uploaded |
| Quit flush works | Close Bridge mid-session → session still uploaded |
| Version bumped | `bridge/package.json` shows `3.13.0` |
