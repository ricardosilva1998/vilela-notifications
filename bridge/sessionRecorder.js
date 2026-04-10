'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const pako = require('pako');
const https = require('https');
const http = require('http');

const API_BASE = 'https://atletanotifications.com';
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
let _sessionType = '';
let _raceType = null;
let _sessionNum = -1;
let _recording = false;

let _currentLapSamples = [];
let _lastLapNumber = -1;
let _pollCount = 0;

// Server session ID (set after first upload)
let _serverSessionId = null;
let _sessionCreating = false;

// Context tracked per lap
let _lapStartFuel = 0;
let _lapAirTemp = 0;
let _lapTrackTemp = 0;

// Session-level context
let _conditions = {};
let _sof = 0;
let _driverCount = 0;
let _bestLapTime = 0;
let _lapCount = 0;

// Queue for laps waiting to be uploaded (while session is being created)
let _pendingLaps = [];

// ── Public API ──────────────────────────────────────────────────────

function init(bridgeId) {
  _bridgeId = bridgeId;
  retryPendingUploads();
}

function setIdentity(iracingName) {
  _iracingName = iracingName;
}

function poll(data) {
  if (!_recording) return;
  _pollCount++;
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

function onSessionStart(sessionNum, trackName, carClass, carName, sessionType, conditions, sof, driverCount) {
  // If we were recording, finalize the previous session
  if (_recording && _serverSessionId) {
    finishSession();
  }

  _sessionNum = sessionNum;
  _trackName = trackName;
  _carClass = carClass;
  _carName = carName;
  _sessionType = sessionType;
  _raceType = null;
  _conditions = conditions || {};
  _sof = sof || 0;
  _driverCount = driverCount || 0;
  _bestLapTime = 0;
  _lapCount = 0;
  _currentLapSamples = [];
  _lastLapNumber = -1;
  _pollCount = 0;
  _serverSessionId = null;
  _sessionCreating = false;
  _pendingLaps = [];
  _recording = true;

  log('Session started: ' + sessionType + ' at ' + trackName + ' in ' + carClass + ' (' + carName + ')');
}

function onLapComplete(lapData) {
  if (!_recording) return;
  if (_lastLapNumber === lapData.lapNumber) return;

  const isFirstLap = _lastLapNumber === -1;
  const fuelUsed = _lapStartFuel > 0 && lapData.fuelLevel > 0 ? Math.round((_lapStartFuel - lapData.fuelLevel) * 100) / 100 : null;

  let isValid = true;
  if (isFirstLap) isValid = false;
  if (lapData.inPit) isValid = false;
  if (lapData.lapTime <= 30) isValid = false;
  if (_bestLapTime > 0 && lapData.lapTime > _bestLapTime * 2) isValid = false;

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

  const telemetryData = _currentLapSamples.length > 0 ? compressTelemetry(_currentLapSamples) : null;
  const sampleCount = _currentLapSamples.length;

  _lapCount++;
  _currentLapSamples = [];
  _lastLapNumber = lapData.lapNumber;
  _lapStartFuel = lapData.fuelLevel;
  _lapAirTemp = lapData.airTemp || 0;
  _lapTrackTemp = lapData.trackTemp || 0;

  log('Lap ' + lapData.lapNumber + ': ' + lapData.lapTime.toFixed(3) + 's' + (isValid ? '' : ' (invalid)') + ' — ' + sampleCount + ' telemetry samples');

  // Progressive upload: create session on first lap, then append
  if (!_serverSessionId && !_sessionCreating) {
    _sessionCreating = true;
    _pendingLaps.push({ lap, telemetry: telemetryData });
    createSessionOnServer(lap, telemetryData);
  } else if (_serverSessionId) {
    appendLapToServer(_serverSessionId, lap, telemetryData);
  } else {
    // Session is being created, queue this lap
    _pendingLaps.push({ lap, telemetry: telemetryData });
  }
}

function onSessionEnd(finishPosition, iratingChange) {
  if (!_recording) return;
  _recording = false;
  finishSession(finishPosition, iratingChange);
}

function flush() {
  if (_recording) {
    _recording = false;
    finishSession();
  }
}

function setRaceType(raceType) {
  _raceType = raceType;
}

// ── Internal ────────────────────────────────────────────────────────

function createSessionOnServer(firstLap, telemetryData) {
  const payload = {
    bridge_id: _bridgeId,
    iracing_name: _iracingName,
    session: {
      track_name: _trackName,
      car_class: _carClass,
      car_name: _carName,
      session_type: _sessionType,
      race_type: _raceType || null,
      conditions: _conditions,
      sof: _sof || null,
      finish_position: null,
      irating_change: null,
      driver_count: _driverCount || null,
      best_lap_time: firstLap.lap_time || null,
      lap_count: 1,
    },
    laps: [firstLap],
    telemetry: telemetryData ? [{ lap_number: firstLap.lap_number, data: telemetryData }] : [],
  };

  log('Creating session on server...');
  apiRequest('/api/session', payload, (err, data) => {
    if (err) {
      log('Failed to create session: ' + err.message);
      _sessionCreating = false;
      // Save full session as pending for retry
      savePending(payload);
      return;
    }
    _serverSessionId = data.id;
    _sessionCreating = false;
    log('Session created: id=' + data.id + ' token=' + data.share_token);

    // Upload any laps that were queued while creating
    if (_pendingLaps.length > 1) {
      // Skip first (already sent), upload the rest
      for (let i = 1; i < _pendingLaps.length; i++) {
        appendLapToServer(_serverSessionId, _pendingLaps[i].lap, _pendingLaps[i].telemetry);
      }
    }
    _pendingLaps = [];
  });
}

function appendLapToServer(sessionId, lap, telemetryData) {
  const payload = { lap, telemetry: telemetryData || null };
  apiRequest('/api/session/' + sessionId + '/lap', payload, (err) => {
    if (err) {
      log('Failed to append lap ' + lap.lap_number + ': ' + err.message);
    } else {
      log('Lap ' + lap.lap_number + ' uploaded to session ' + sessionId);
    }
  });
}

function finishSession(finishPosition, iratingChange) {
  if (_serverSessionId) {
    const payload = {
      finish_position: finishPosition || null,
      irating_change: iratingChange || null,
      best_lap_time: _bestLapTime || null,
    };
    apiRequest('/api/session/' + _serverSessionId + '/finish', payload, (err) => {
      if (err) log('Failed to finalize session: ' + err.message);
      else log('Session ' + _serverSessionId + ' finalized');
    });
  }
  _serverSessionId = null;
  _pendingLaps = [];
  _bestLapTime = 0;
  _lapCount = 0;
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

function apiRequest(path, body, callback) {
  const jsonStr = JSON.stringify(body);
  const url = new URL(API_BASE + path);
  const mod = url.protocol === 'https:' ? https : http;

  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname,
    method: path.includes('/finish') ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(jsonStr) },
    timeout: 15000,
  };

  const req = mod.request(options, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      try {
        const json = JSON.parse(body);
        if (res.statusCode === 200) callback(null, json);
        else callback(new Error(json.error || 'HTTP ' + res.statusCode));
      } catch(e) { callback(new Error('Invalid response')); }
    });
  });
  req.on('error', (e) => callback(e));
  req.on('timeout', () => { req.destroy(); callback(new Error('Timeout')); });
  req.write(jsonStr);
  req.end();
}

function savePending(payload) {
  try {
    let pending = [];
    if (fs.existsSync(PENDING_FILE)) {
      pending = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    }
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
    fs.writeFileSync(PENDING_FILE, '[]');
    pending.forEach(p => {
      apiRequest('/api/session', p, (err, data) => {
        if (err) { log('Retry failed: ' + err.message); savePending(p); }
        else log('Retry successful: session ' + data.id);
      });
    });
  } catch(e) {
    log('Retry error: ' + e.message);
  }
}

module.exports = { init, setIdentity, poll, onSessionStart, onLapComplete, onSessionEnd, flush, setRaceType };
