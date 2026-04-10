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
let _sessionType = '';
let _raceType = null;
let _sessionNum = -1;
let _recording = false;

let _currentLapSamples = [];
let _lastLapNumber = -1;
let _pollCount = 0;

let _laps = [];
let _telemetryBuffers = [];

let _lapStartFuel = 0;
let _lapAirTemp = 0;
let _lapTrackTemp = 0;

let _conditions = {};
let _sof = 0;
let _driverCount = 0;
let _bestLapTime = 0;

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
  if (_recording && _laps.length > 0) {
    finalizeAndUpload();
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
  _laps = [];
  _telemetryBuffers = [];
  _currentLapSamples = [];
  _lastLapNumber = -1;
  _pollCount = 0;
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
  _laps.push(lap);

  if (_currentLapSamples.length > 0) {
    _telemetryBuffers.push({
      lap_number: lapData.lapNumber,
      samples: _currentLapSamples,
    });
    log('Lap ' + lapData.lapNumber + ': ' + lapData.lapTime.toFixed(3) + 's' + (isValid ? '' : ' (invalid)') + ' — ' + _currentLapSamples.length + ' telemetry samples');
  }

  _currentLapSamples = [];
  _lastLapNumber = lapData.lapNumber;
  _lapStartFuel = lapData.fuelLevel;
  _lapAirTemp = lapData.airTemp || 0;
  _lapTrackTemp = lapData.trackTemp || 0;
}

function onSessionEnd(finishPosition, iratingChange) {
  if (!_recording) return;
  _recording = false;

  if (_laps.length === 0) {
    log('Session ended with no laps — skipping upload');
    return;
  }

  finalizeAndUpload(finishPosition, iratingChange);
}

function flush() {
  if (_recording && _laps.length > 0) {
    _recording = false;
    finalizeAndUpload();
  }
}

function setRaceType(raceType) {
  _raceType = raceType;
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
      race_type: _raceType || null,
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
    pending.forEach(p => uploadSession(p));
  } catch(e) {
    log('Retry error: ' + e.message);
  }
}

module.exports = { init, setIdentity, poll, onSessionStart, onLapComplete, onSessionEnd, flush, setRaceType };
