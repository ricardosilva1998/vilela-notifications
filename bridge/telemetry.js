'use strict';

const fs = require('fs');
const path = require('path');

const logPath = path.join(require('os').homedir(), 'atleta-bridge.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(msg);
  try { fs.appendFileSync(logPath, line); } catch(e) {}
}

let statusCallback = null;
let connected = false;
let pollInterval = null;
let connectInterval = null;

const { broadcastToChannel, getClientInfo, getSelectedCarIdx, resetSelectedCar } = require('./websocket');
const { switchCamera } = require('./keyboardSim');
const settings = require('./settings');
const { extractTrackFromIBT, geoKeyFromSessionInfo, loadCachedTrackByGeo, saveCachedTrackByGeo } = require('./trackExtractor');

// Fuel tracking
let fuelHistory = [];
let lapTimeHistory = [];
let lastLap = -1;
let fuelAtLapStart = null;

// Track map — slot-based recording (robust against crashes/off-track)
const TRACK_SLOTS = 500; // Resolution: 500 points around the track
const trackSlots = new Array(TRACK_SLOTS).fill(null); // {x, y} per slot
let trackPathComplete = false;
let trackPathOutput = []; // Final smoothed path sent to overlay
let lastIntX = 0, lastIntY = 0; // Integrated position
let lastRecordedPct = -1;
let filledSlots = 0;

// Track map sources: server DB → local cache → manual mapping
const TRACK_MAPS_DIR = path.join(require('os').homedir(), 'Documents', 'Atleta Bridge', 'trackmaps');
const TRACK_API_URL = 'https://atletanotifications.com/api/track-map';

function loadCachedTrack(trackName) {
  try {
    const file = path.join(TRACK_MAPS_DIR, trackName.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && data.length > 50) return data;
    }
  } catch(e) {}
  return null;
}

function saveCachedTrack(trackName, pathData) {
  try {
    if (!fs.existsSync(TRACK_MAPS_DIR)) fs.mkdirSync(TRACK_MAPS_DIR, { recursive: true });
    const file = path.join(TRACK_MAPS_DIR, trackName.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
    fs.writeFileSync(file, JSON.stringify(pathData));
    log('[TrackMap] Cached locally: ' + trackName + ' (' + pathData.length + ' points)');
  } catch(e) { log('[TrackMap] Cache save error: ' + e.message); }
}

async function fetchTrackFromServer(trackName) {
  try {
    const https = require('https');
    const url = TRACK_API_URL + '/' + encodeURIComponent(trackName);
    return new Promise((resolve) => {
      https.get(url, { timeout: 5000 }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.trackData && data.trackData.length > 50) {
              log('[TrackMap] Fetched from server: ' + trackName + ' (' + data.trackData.length + ' points)');
              resolve(data.trackData);
            } else resolve(null);
          } catch(e) { resolve(null); }
        });
      }).on('error', () => resolve(null)).on('timeout', function() { this.destroy(); resolve(null); });
    });
  } catch(e) { return null; }
}

function uploadTrackToServer(trackName, pathData) {
  try {
    const https = require('https');
    const postData = JSON.stringify({ trackName, trackData: pathData });
    const url = new URL(TRACK_API_URL);
    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => log('[TrackMap] Upload response: ' + res.statusCode + ' ' + body));
    });
    req.on('error', (e) => log('[TrackMap] Upload error: ' + e.message));
    req.on('timeout', () => { req.destroy(); });
    req.write(postData);
    req.end();
  } catch(e) { log('[TrackMap] Upload error: ' + e.message); }
}

function buildTrackPath() {
  // Convert filled slots to a continuous path
  const points = [];
  for (let i = 0; i < TRACK_SLOTS; i++) {
    if (trackSlots[i]) {
      points.push({ x: trackSlots[i].x, y: trackSlots[i].y, pct: i / TRACK_SLOTS });
    }
  }
  if (points.length < 50) return points;

  // Smooth the path with a moving average (window=5) to remove noise
  const smoothed = [];
  const win = 5;
  for (let i = 0; i < points.length; i++) {
    let sx = 0, sy = 0, count = 0;
    for (let j = -win; j <= win; j++) {
      const idx = (i + j + points.length) % points.length;
      sx += points[idx].x;
      sy += points[idx].y;
      count++;
    }
    smoothed.push({ x: sx / count, y: sy / count, pct: points[i].pct });
  }
  return smoothed;
}

// Persistent driver data — keeps drivers visible after they disconnect
const persistedDrivers = new Map();
// Cached lap times — survives pit stops where telemetry returns -1
const cachedBestLaps = new Map(); // carIdx -> best lap time
const cachedLastLaps = new Map(); // carIdx -> last lap time
const cachedLapsCompleted = new Map(); // carIdx -> laps completed
// Session results — lap data from YAML (more complete than real-time telemetry)
const sessionResults = new Map(); // carIdx -> { bestLap, lastLap, lapsComplete }
// Starting iRatings — captured once at session start for gain/loss display
const startingIRatings = new Map(); // carIdx -> starting iRating

// Pit time tracking — measure time lost per pit stop per class
const pitTracking = new Map(); // carIdx -> { wasPitting, bestLapSnapshot, lapsSnapshot, waitingForLap, referenceLap }
let classPitDeltas = {};       // className -> { avgDelta, samples }
const PIT_TIMES_FILE = path.join(require('os').homedir(), 'Documents', 'Atleta Bridge', 'pittimes.json');

function loadPitTimes() {
  try {
    if (fs.existsSync(PIT_TIMES_FILE)) {
      const data = JSON.parse(fs.readFileSync(PIT_TIMES_FILE, 'utf8'));
      // v3.6.7: switched to wall-clock pit timing — clear all old data
      if (!data._version || data._version < 4) {
        log('[PitTimes] Clearing old pit data (formula changed to IN lap measurement)');
        return { _version: 4 };
      }
      return data;
    }
  } catch(e) { log('[PitTimes] Load error: ' + e.message); }
  return { _version: 3 };
}
function savePitTimes(data) {
  try {
    const dir = path.dirname(PIT_TIMES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PIT_TIMES_FILE, JSON.stringify(data, null, 2));
  } catch(e) { log('[PitTimes] Save error: ' + e.message); }
}
let pitTimesData = {}; // { trackName: { className: { avgDelta, samples } } }
const pitStopCounts = new Map(); // carIdx -> number of pit stops
const driverPitDeltas = new Map(); // carIdx -> last pit delta in seconds
const pitEntryTimes = new Map(); // carIdx -> Date.now() when entered pit
const pitLapMap = new Map(); // carIdx -> lapsCompleted when they entered pit
const driverLastLapPoll = new Map(); // carIdx -> { laps, poll } — last time lapsCompleted changed

// Canonical class mapping for track stats
const CLASS_MAP = {
  'GTP': 'GTP', 'Hypercar': 'GTP',
  'LMP2': 'LMP2', 'Dallara P217': 'LMP2',
  'GT3': 'GT3', 'GT3 2025': 'GT3', 'GT3 Class': 'GT3',
  'GT4': 'GT4', 'GT4 Class': 'GT4',
  'LMP3': 'LMP3',
  'MX5': 'Mazda', 'Mazda MX-5': 'Mazda', 'MX-5': 'Mazda',
  'TCR': 'TCR',
  'PCCR': 'Porsche Cup', 'Porsche 992': 'Porsche Cup', 'Porsche Cup': 'Porsche Cup', 'Porsche 911 GT3 Cup': 'Porsche Cup',
  'BMW M2 CS': 'BMW M2', 'BMW M2': 'BMW M2',
  'Toyota GR86': 'Toyota', 'GR86': 'Toyota',
  'GTE': 'GTE',
};
function canonicalClass(shortName) {
  if (!shortName) return null;
  return CLASS_MAP[shortName] || CLASS_MAP[shortName.trim()] || null;
}

const TRACK_STATS_URL = 'https://atletanotifications.com/api/track-stats';

// Persisted across polls for use at session-change time
let lastSofByClass = {};
let lastStandings = [];

function collectAndUploadTrackStats(track, standingsData, pitDeltas, sofByClassData, qualifyBest, totalRaceTime) {
  if (!track || !standingsData || standingsData.length === 0) return;

  // Group drivers by canonical class
  const classSummary = {};
  standingsData.forEach(s => {
    const cls = canonicalClass(s.carClass);
    if (!cls) return;
    if (!classSummary[cls]) classSummary[cls] = { bestLaps: [], drivers: 0 };
    classSummary[cls].drivers++;
    if (s.bestLap > 0) classSummary[cls].bestLaps.push(s.bestLap);
  });

  // Detect series from class count + race duration
  const totalMinutes = totalRaceTime / 60;
  const classCount = Object.keys(classSummary).length;
  const hasMulticlass = classCount >= 2;

  // Determine race type per class based on duration + series
  // GT3: Regionals ~20, VRS Sprint ~25, IMSA Sprint ~35, VRS Open ~40, IMSA Open ~45, IMSA Endurance ~160, Global Endurance ~360
  // LMP2: LMP2 Sprint ~20, IMSA Sprint ~35, IMSA Open ~45, IMSA Endurance ~160, Global Endurance ~360
  // GTP: IMSA Sprint ~35, IMSA Open ~45, IMSA Endurance ~160, Global Endurance ~360
  function getRaceType(cls) {
    if (cls === 'GT3') {
      if (totalMinutes >= 300) return 'global_endurance';
      if (totalMinutes >= 120) return 'imsa_endurance';
      if (hasMulticlass && totalMinutes >= 40) return 'imsa_open';
      if (!hasMulticlass && totalMinutes >= 35) return 'vrs_open';
      if (hasMulticlass && totalMinutes >= 30) return 'imsa_sprint';
      if (!hasMulticlass && totalMinutes >= 22) return 'vrs_sprint';
      return 'regionals';
    }
    if (cls === 'LMP2') {
      if (totalMinutes >= 300) return 'global_endurance';
      if (totalMinutes >= 120) return 'imsa_endurance';
      if (hasMulticlass && totalMinutes >= 40) return 'imsa_open';
      if (hasMulticlass && totalMinutes >= 30) return 'imsa_sprint';
      return 'lmp2_sprint';
    }
    if (cls === 'GTP') {
      if (totalMinutes >= 300) return 'global_endurance';
      if (totalMinutes >= 120) return 'imsa_endurance';
      if (totalMinutes >= 40) return 'imsa_open';
      if (totalMinutes >= 30) return 'imsa_sprint';
      return 'prototype_sprint';
    }
    // Other classes: simple sprint/open/endurance
    if (totalMinutes >= 120) return 'endurance';
    if (totalMinutes >= 30) return 'open';
    return 'sprint';
  }

  // Find overall leader pace (fastest class)
  let overallLeaderBest = Infinity;
  Object.values(classSummary).forEach(data => {
    const best = Math.min(...data.bestLaps);
    if (best < overallLeaderBest) overallLeaderBest = best;
  });
  if (overallLeaderBest === Infinity) overallLeaderBest = 0;

  // Build stats per class — each class may have its own raceType
  const statsByRaceType = {};
  Object.entries(classSummary).forEach(([cls, data]) => {
    if (data.bestLaps.length === 0) return;
    const leaderBest = Math.min(...data.bestLaps);
    const pitDelta = (pitDeltas[cls] || pitDeltas[Object.keys(pitDeltas).find(k => canonicalClass(k) === cls)] || {}).avgDelta || 0;
    // Estimated laps: totalRaceTime + leader final lap, minus pit time, divided by class pace
    let estLaps = 0;
    if (leaderBest > 0 && overallLeaderBest > 0 && totalRaceTime > 0) {
      const totalTime = totalRaceTime + overallLeaderBest;
      const estStops = Math.max(0, Math.floor(totalTime / 1800) - 1);
      const effectiveTime = totalTime - (estStops * pitDelta);
      estLaps = parseFloat((effectiveTime / leaderBest).toFixed(2));
    }
    const raceType = getRaceType(cls);
    if (!statsByRaceType[raceType]) statsByRaceType[raceType] = {};
    statsByRaceType[raceType][cls] = {
      avgLapTime: leaderBest,
      avgPitTime: pitDelta,
      avgQualifyTime: qualifyBest[cls] || 0,
      avgSOF: sofByClassData[Object.keys(sofByClassData).find(k => canonicalClass(k) === cls)] || 0,
      estLaps,
      samples: data.drivers,
    };
  });

  if (Object.keys(statsByRaceType).length === 0) return;

  // Upload one request per raceType (all classes sharing that type together)
  Object.entries(statsByRaceType).forEach(([raceType, stats]) => {
    const payload = JSON.stringify({ trackName: track, raceType, stats });
    log('[TrackStats] Uploading: ' + track + ' (' + raceType + ') classes=' + Object.keys(stats).join(','));

    // POST to server (same pattern as uploadTrackToServer)
    try {
      const https = require('https');
      const url = new URL(TRACK_STATS_URL);
      const req = https.request({
        hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 10000,
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => log('[TrackStats] Upload response: ' + res.statusCode + ' ' + body));
      });
      req.on('error', (e) => log('[TrackStats] Upload error: ' + e.message));
      req.on('timeout', () => { req.destroy(); });
      req.write(payload);
      req.end();
    } catch(e) { log('[TrackStats] Upload error: ' + e.message); }
  });
}

/**
 * iRating change calculator — exact formula from iRacing spreadsheet.
 * Source: github.com/arrecio/ircalculator (matches iRacing official calc)
 * Calculates per-class in multiclass races.
 */
const IR_BR = 1600 / Math.LN2; // ~2308.31 — iRacing's Elo-like base constant

function irChance(a, b) {
  const ea = Math.exp(-a / IR_BR);
  const eb = Math.exp(-b / IR_BR);
  const Qa = (1 - ea) * eb;
  const Qb = (1 - eb) * ea;
  return Qa / (Qb + Qa);
}

function estimateIRatingChanges(driverList) {
  const changes = new Map();

  // Group drivers by class
  const classes = {};
  driverList.forEach(d => {
    if (d.iRating > 0 && d.classPosition > 0) {
      const cls = d.carClass || 'Overall';
      if (!classes[cls]) classes[cls] = [];
      classes[cls].push(d);
    }
  });

  for (const cls of Object.keys(classes)) {
    const classDrivers = classes[cls];
    // Sort by class position for calculation
    classDrivers.sort((a, b) => a.classPosition - b.classPosition);
    const N = classDrivers.length;
    if (N < 2) continue;

    const nStarters = N; // assume all started (we filter out non-starters earlier)

    // Calculate expected for each driver
    const expecteds = [];
    for (let i = 0; i < N; i++) {
      let c = -0.5;
      for (let j = 0; j < N; j++) {
        c += irChance(classDrivers[i].iRating, classDrivers[j].iRating);
      }
      expecteds.push(c);
    }

    // Calculate changes
    for (let i = 0; i < N; i++) {
      const pos = i + 1;
      const factor = ((N) / 2 - pos) / 100;
      const change = Math.round((N - pos - expecteds[i] - factor) * 200 / nStarters);
      changes.set(classDrivers[i].carIdx, change);
    }
  }
  return changes;
}

function resetFuel() { fuelHistory = []; lapTimeHistory = []; lastLap = -1; fuelAtLapStart = null; }

async function startTelemetry(onStatusChange) {
  statusCallback = onStatusChange;
  log('[Telemetry] Starting...');

  let IRSDK, VARS;
  try {
    const sdk = await import('@emiliosp/node-iracing-sdk');
    IRSDK = sdk.IRSDK;
    VARS = sdk.VARS;
    log('[Telemetry] SDK loaded. VARS: ' + Object.keys(VARS).length);
  } catch (e) {
    log('[Telemetry] SDK FAILED: ' + e.message);
    return;
  }

  let ir = null;
  let sessionInfoFound = false;
  let drivers = [];
  let playerCarIdx = 0;
  let trackName = '';
  let lastFocusCarIdx = -1;
  let _wasInPit = false;
  let _stintStartLap = 0;
  let _stintStartTime = 0;
  let _lastPlayerIRChange = 0;
  let lastCameraSwitchPoll = -999;
  let lastSessionNum = -1;
  let pollCount = 0;
  let qualifyBestByClass = {}; // className -> best lap time from qualify session
  let raceSessionTotalTime = 0; // total race duration for sprint/open/endurance detection

  connectInterval = setInterval(async () => {
    if (ir && connected) return;
    try {
      ir = await IRSDK.connect();
      if (ir && !connected) {
        connected = true;
        sessionInfoFound = false;
        drivers = [];
        playerCarIdx = 0;
        pollCount = 0;
        lastFocusCarIdx = -1;
        resetSelectedCar();
        startingIRatings.clear();
        pitTracking.clear();
        pitStopCounts.clear();
        driverPitDeltas.clear();
        pitEntryTimes.clear();
        pitLapMap.clear();
        driverLastLapPoll.clear();
        classPitDeltas = {};
        resetFuel();
        trackSlots.fill(null);
        trackPathComplete = false;
        trackPathOutput = [];
        lastIntX = 0; lastIntY = 0;
        lastRecordedPct = -1;
        filledSlots = 0;
        persistedDrivers.clear();
        cachedBestLaps.clear();
        cachedLastLaps.clear();
        cachedLapsCompleted.clear();
        sessionResults.clear();
        log('[Telemetry] Connected to iRacing!');
        broadcastToChannel('_all', { type: 'status', iracing: true });
        if (statusCallback) statusCallback({ iracing: true });
        startPolling();
      }
    } catch (e) {
      if (connected) {
        connected = false; ir = null;
        log('[Telemetry] Disconnected: ' + e.message);
        broadcastToChannel('_all', { type: 'status', iracing: false });
        if (statusCallback) statusCallback({ iracing: false });
        resetFuel();
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
      }
    }
  }, 3000);

  function startPolling() {
    if (pollInterval) clearInterval(pollInterval);

    pollInterval = setInterval(() => {
      try {
        if (!ir.isConnected()) {
          if (connected) {
            // Upload track stats if disconnected during a race
            try {
              const si = ir.getSessionInfo('SessionInfo');
              const sn = lastSessionNum >= 0 ? lastSessionNum : 0;
              const sessType = si?.Sessions?.[sn]?.SessionType || '';
              if (sessType.toLowerCase().includes('race') && lastStandings.length > 0) {
                collectAndUploadTrackStats(trackName, lastStandings, classPitDeltas, lastSofByClass, qualifyBestByClass, raceSessionTotalTime);
              }
            } catch(e) {}
            connected = false;
            log('[Telemetry] Disconnected during poll');
            broadcastToChannel('_all', { type: 'status', iracing: false });
            if (statusCallback) statusCallback({ iracing: false });
            resetFuel(); clearInterval(pollInterval); pollInterval = null;
          }
          return;
        }

        ir.refreshSharedMemory();
        pollCount++;

        // === Session change detection ===
        try {
          const sessionNum = ir.get(VARS.SESSION_NUM)?.[0] ?? -1;
          if (sessionNum !== lastSessionNum && lastSessionNum >= 0) {
            const sessionInfo = ir.getSessionInfo('SessionInfo');
            const prevType = sessionInfo?.Sessions?.[lastSessionNum]?.SessionType || '';
            const newType = sessionInfo?.Sessions?.[sessionNum]?.SessionType || '';
            const isQualToRace = prevType.toLowerCase().includes('qualify') && newType.toLowerCase().includes('race');
            // Upload track stats when leaving a Race session
            if (prevType.toLowerCase().includes('race') && lastStandings.length > 0) {
              collectAndUploadTrackStats(trackName, lastStandings, classPitDeltas, lastSofByClass, qualifyBestByClass, raceSessionTotalTime);
            }
            if (!isQualToRace) {
              cachedBestLaps.clear();
              cachedLastLaps.clear();
              cachedLapsCompleted.clear();
              sessionResults.clear();
              persistedDrivers.clear();
              pitStopCounts.clear();
        driverPitDeltas.clear();
        pitEntryTimes.clear();
        pitLapMap.clear();
        driverLastLapPoll.clear();
              qualifyBestByClass = {};
              raceSessionTotalTime = 0;
              log('[Session] Cleared data: ' + prevType + ' → ' + newType);
            } else {
              log('[Session] Kept data: ' + prevType + ' → ' + newType);
            }
          }
          if (lastSessionNum < 0) lastSessionNum = sessionNum;
          else lastSessionNum = sessionNum;
        } catch(e) {}

        // === Get session info (requires key parameter!) ===
        if (!sessionInfoFound || pollCount % 300 === 0) {
          try {
            // getSessionInfo takes a KEY parameter, not called with no args!
            const driverInfo = ir.getSessionInfo('DriverInfo');
            const weekendInfo = ir.getSessionInfo('WeekendInfo');

            if (driverInfo && driverInfo.Drivers) {
              const newTrackName = weekendInfo?.TrackDisplayName || '';

              // Detect track/session change — reset track map when track changes
              if (sessionInfoFound && newTrackName && newTrackName !== trackName) {
                log('[SessionInfo] Track changed: ' + trackName + ' → ' + newTrackName);
                trackSlots.fill(null);
                trackPathComplete = false;
                trackPathOutput = [];
                lastIntX = 0; lastIntY = 0;
                lastRecordedPct = -1;
                filledSlots = 0;
                sessionInfoFound = false; // re-trigger full init below
              }

              if (!sessionInfoFound) {
                sessionInfoFound = true;
                trackName = newTrackName;
                // Load persisted pit times for this track
                pitTimesData = loadPitTimes();
                classPitDeltas = {};
                pitTracking.clear();
                if (pitTimesData[trackName]) {
                  Object.entries(pitTimesData[trackName]).forEach(([cls, d]) => {
                    classPitDeltas[cls] = { avgDelta: d.avgDelta || 0, samples: d.samples || 0 };
                  });
                  log('[PitTimes] Loaded for ' + trackName + ': ' + Object.entries(classPitDeltas).map(([c, d]) => c + '=' + d.avgDelta.toFixed(1) + 's (' + d.samples + ')').join(', '));
                }
                // Store starting iRatings for gain/loss tracking
                driverInfo.Drivers.forEach(d => {
                  if (d.IRating > 0 && !startingIRatings.has(d.CarIdx)) {
                    startingIRatings.set(d.CarIdx, d.IRating);
                  }
                });
                log('[SessionInfo] Found! Drivers: ' + driverInfo.Drivers.length);
                log('[SessionInfo] Track: ' + trackName);
                // Dump ALL fields from first driver to discover country data
                if (driverInfo.Drivers[0]) {
                  log('[SessionInfo] ALL FIELDS D[0]: ' + JSON.stringify(driverInfo.Drivers[0]));
                }

                // Load track map: geo-key cache → server → .ibt files → manual mapping
                const trackGeoKey = geoKeyFromSessionInfo(
                  weekendInfo?.TrackLatitude, weekendInfo?.TrackLongitude
                );
                log('[TrackMap] Track: ' + trackName + ' geo=' + (trackGeoKey || 'unknown'));

                if (!trackPathComplete && trackPathOutput.length === 0) {
                  // Try local geo-key cache first (also try old name-based cache)
                  const cached = (trackGeoKey && loadCachedTrackByGeo(trackGeoKey)) || loadCachedTrack(trackName);
                  if (cached) {
                    trackPathOutput = cached;
                    trackPathComplete = true;
                    filledSlots = TRACK_SLOTS;
                    log('[TrackMap] Loaded from cache (' + cached.length + ' points)');
                  } else {
                    // Try server, then .ibt files (async, non-blocking)
                    (async () => {
                      // Try server by geo-key and by name
                      let serverData = trackGeoKey ? await fetchTrackFromServer(trackGeoKey) : null;
                      if (!serverData) serverData = await fetchTrackFromServer(trackName);
                      if (serverData && !trackPathComplete) {
                        trackPathOutput = serverData;
                        trackPathComplete = true;
                        filledSlots = TRACK_SLOTS;
                        if (trackGeoKey) saveCachedTrackByGeo(trackGeoKey, serverData);
                        saveCachedTrack(trackName, serverData);
                        log('[TrackMap] Loaded from server (' + serverData.length + ' points)');
                        return;
                      }
                      // .ibt extraction disabled — causes OOM by importing SDK per file
                      // Track maps come from: server, geo-key cache, or manual driving
                    })();
                  }
                }
                driverInfo.Drivers.slice(0, 3).forEach((d, i) => {
                  const keys = Object.keys(d);
                  log('[SessionInfo] D[' + i + '] keys: ' + keys.join(', '));
                  log('[SessionInfo] D[' + i + '] data: idx=' + d.CarIdx + ' Name=' + d.UserName + ' #' + d.CarNumber +
                    ' iR=' + d.IRating + ' Lic=' + d.LicString +
                    ' ClubName=' + d.ClubName + ' ClubID=' + d.ClubID +
                    ' ClassShort=' + d.CarClassShortName + ' ClassColor=' + d.CarClassColor +
                    ' CarShort=' + d.CarScreenNameShort);
                });
              }
              drivers = driverInfo.Drivers;
              playerCarIdx = driverInfo.DriverCarIdx ?? 0;
              trackName = newTrackName;

              // Retry track map fetch every ~30s if still missing
              if (sessionInfoFound && !trackPathComplete && trackPathOutput.length === 0 && pollCount % 900 === 0 && pollCount > 0) {
                const retryGeoKey = geoKeyFromSessionInfo(weekendInfo?.TrackLatitude, weekendInfo?.TrackLongitude);
                log('[TrackMap] Retrying server fetch (geo=' + (retryGeoKey || 'unknown') + ' name=' + trackName + ')');
                (async () => {
                  let data = retryGeoKey ? await fetchTrackFromServer(retryGeoKey) : null;
                  if (!data) data = await fetchTrackFromServer(trackName);
                  if (data && !trackPathComplete) {
                    trackPathOutput = data;
                    trackPathComplete = true;
                    filledSlots = TRACK_SLOTS;
                    if (retryGeoKey) saveCachedTrackByGeo(retryGeoKey, data);
                    saveCachedTrack(trackName, data);
                    log('[TrackMap] Loaded from server on retry (' + data.length + ' points)');
                  }
                })();
              }
            } else if (pollCount % 300 === 0) {
              log('[SessionInfo] DriverInfo not available yet (poll ' + pollCount + ')');
            }

            // Read session results for lap times (more complete than real-time telemetry)
            const sessionInfo = ir.getSessionInfo('SessionInfo');
            if (sessionInfo && sessionInfo.Sessions) {
              // Use the last (most recent/active) session's results
              for (let si = sessionInfo.Sessions.length - 1; si >= 0; si--) {
                const results = sessionInfo.Sessions[si].ResultsPositions;
                if (results && results.length > 0) {
                  results.forEach(r => {
                    if (r.CarIdx !== undefined) {
                      const prev = sessionResults.get(r.CarIdx);
                      const bestTime = r.FastestTime > 0 ? r.FastestTime : (prev?.bestLap || 0);
                      const lastTime = r.LastTime > 0 ? r.LastTime : (prev?.lastLap || 0);
                      const laps = r.LapsComplete >= 0 ? r.LapsComplete : (prev?.lapsComplete || 0);
                      sessionResults.set(r.CarIdx, { bestLap: bestTime, lastLap: lastTime, lapsComplete: laps });
                    }
                  });
                  break; // Use only the most recent session with results
                }
              }
            }
          } catch(e) {
            if (pollCount % 300 === 0) log('[SessionInfo] Error: ' + e.message);
          }
        }

        // === Fuel ===
        const fuelLevel = ir.get(VARS.FUEL_LEVEL)?.[0] || 0;
        const fuelPct = ir.get(VARS.FUEL_LEVEL_PCT)?.[0] || 0;
        const fuelUsePerHour = ir.get(VARS.FUEL_USE_PER_HOUR)?.[0] || 0;
        const currentLap = ir.get(VARS.LAP)?.[0] || 0;
        const lapsCompleted = ir.get(VARS.LAP_COMPLETED)?.[0] || 0;
        const sessionLapsRemain = ir.get(VARS.SESSION_LAPS_REMAIN_EX)?.[0] || 0;
        const sessionTimeRemainFuel = ir.get(VARS.SESSION_TIME_REMAIN)?.[0] || 0;
        const lastLapTime = ir.get(VARS.LAP_LAST_LAP_TIME)?.[0] || 0;

        if (currentLap > lastLap && lastLap >= 0) {
          // Track fuel used
          if (fuelAtLapStart !== null) {
            const used = fuelAtLapStart - fuelLevel;
            if (used > 0.01) { fuelHistory.push(used); if (fuelHistory.length > 20) fuelHistory.shift(); }
          }
          fuelAtLapStart = fuelLevel;
          // Track lap times
          if (lastLapTime > 0 && lastLapTime < 600) {
            lapTimeHistory.push(lastLapTime);
            if (lapTimeHistory.length > 20) lapTimeHistory.shift();
          }
        }
        if (lastLap < 0 || currentLap > lastLap) { if (fuelAtLapStart === null) fuelAtLapStart = fuelLevel; lastLap = currentLap; }

        const avg5 = fuelHistory.length > 0 ? fuelHistory.slice(-5).reduce((a,b) => a+b, 0) / Math.min(fuelHistory.length, 5) : 0;
        const avg10 = fuelHistory.length > 0 ? fuelHistory.slice(-10).reduce((a,b) => a+b, 0) / Math.min(fuelHistory.length, 10) : 0;
        const avgAll = fuelHistory.length > 0 ? fuelHistory.reduce((a,b) => a+b, 0) / fuelHistory.length : 0;
        const minUsage = fuelHistory.length > 0 ? Math.min(...fuelHistory) : 0;
        const maxUsage = fuelHistory.length > 0 ? Math.max(...fuelHistory) : 0;
        const lapsOfFuel = avgAll > 0 ? fuelLevel / avgAll : 0;
        const avgLapTime = lapTimeHistory.length > 0 ? lapTimeHistory.reduce((a,b) => a+b, 0) / lapTimeHistory.length : 0;

        // Estimate laps remaining: prefer lap-based, fallback to time-based
        const isUnlimited = sessionLapsRemain >= 32767;
        let estLapsRemain = 0;
        if (!isUnlimited && sessionLapsRemain > 0) {
          // Lap-based race: use iRacing's laps remaining
          estLapsRemain = sessionLapsRemain;
        } else if (sessionTimeRemainFuel > 0 && avgLapTime > 0) {
          // Timed race: estimate from time remaining + average lap time (+1 for finish lap)
          estLapsRemain = Math.ceil(sessionTimeRemainFuel / avgLapTime) + 1;
        }

        const fuelToFinish = (estLapsRemain > 0 && avgAll > 0) ? estLapsRemain * avgAll : 0;
        const fuelToAdd = fuelToFinish > 0 ? Math.max(0, fuelToFinish - fuelLevel) : 0;

        broadcastToChannel('fuel', { type: 'data', channel: 'fuel', data: {
          fuelLevel, fuelPct, fuelUsePerHour, avgPerLap: avgAll, avg5Laps: avg5, avg10Laps: avg10,
          minUsage, maxUsage, lapsOfFuel,
          lapsRemaining: isUnlimited && estLapsRemain > 0 ? estLapsRemain : (isUnlimited ? '∞' : sessionLapsRemain),
          fuelToFinish, fuelToAdd, lapsCompleted, lapCount: fuelHistory.length,
          avgLapTime,
        }});

        // === Driver Inputs ===
        const throttle = ir.get(VARS.THROTTLE)?.[0] || 0;
        const brake = ir.get(VARS.BRAKE)?.[0] || 0;
        const rawClutch = ir.get(VARS.CLUTCH)?.[0] || 0;
        const clutch = 1 - rawClutch; // iRacing: 1=released, 0=pressed → invert for display
        const steer = ir.get(VARS.STEERING_WHEEL_ANGLE)?.[0] || 0;
        const gear = ir.get(VARS.GEAR)?.[0] || 0;
        const speed = ir.get(VARS.SPEED)?.[0] || 0; // m/s

        broadcastToChannel('inputs', { type: 'data', channel: 'inputs', data: {
          throttle, brake, clutch, steer, gear, speed,
        }});

        // === Wind === (broadcast moved after focusCarIdx is determined, see below)

        // === Proximity ===
        broadcastToChannel('proximity', { type: 'data', channel: 'proximity', data: {
          carLeftRight: ir.get(VARS.CAR_LEFT_RIGHT)?.[0] || 0,
        }});

        // === Standings (even without session info, use car indices) ===
        const positions = ir.get(VARS.CAR_IDX_POSITION) || [];
        const classPositions = ir.get(VARS.CAR_IDX_CLASS_POSITION) || [];
        const lapsCompletedArr = ir.get(VARS.CAR_IDX_LAP_COMPLETED) || [];
        const bestLaps = ir.get(VARS.CAR_IDX_BEST_LAP_TIME) || [];
        const lastLaps = ir.get(VARS.CAR_IDX_LAST_LAP_TIME) || [];
        const onPitRoad = ir.get(VARS.CAR_IDX_ON_PIT_ROAD) || [];
        const carIdxFlags = ir.get(VARS.CAR_IDX_SESSION_FLAGS) || [];
        const estTime = ir.get(VARS.CAR_IDX_EST_TIME) || [];
        const lapDistPct = ir.get(VARS.CAR_IDX_LAP_DIST_PCT) || [];

        // === Session info (weather, temps, SOF, timing) ===
        const airTemp = ir.get(VARS.AIR_TEMP)?.[0] || 0;
        const trackTemp = ir.get(VARS.TRACK_TEMP)?.[0] || 0;
        const humidity = (ir.get(VARS.RELATIVE_HUMIDITY)?.[0] || 0) * 100;
        const trackWetness = ir.get(VARS.TRACK_WETNESS)?.[0] || 0;
        const sessionTime = ir.get(VARS.SESSION_TIME)?.[0] || 0;
        const sessionTimeRemain = ir.get(VARS.SESSION_TIME_REMAIN)?.[0] || 0;
        const timeOfDay = ir.get(VARS.SESSION_TIME_OF_DAY)?.[0] || 0;

        // SOF = harmonic mean of iRatings (closest match to iRacing's official SOF)
        const iRatings = drivers.filter(d => d.IRating > 0 && !d.IsSpectator && d.UserName !== 'Pace Car').map(d => d.IRating);
        const sof = iRatings.length > 0 ? Math.round(iRatings.length / iRatings.reduce((s, r) => s + 1 / r, 0)) : 0;

        // SOF per class
        const sofByClass = {};
        drivers.filter(d => d.IRating > 0).forEach(d => {
          const cls = d.CarClassShortName || 'Unknown';
          if (!sofByClass[cls]) sofByClass[cls] = [];
          sofByClass[cls].push(d.IRating);
        });
        Object.keys(sofByClass).forEach(cls => {
          const arr = sofByClass[cls];
          sofByClass[cls] = Math.round(arr.length / arr.reduce((s, r) => s + 1 / r, 0));
        });

        const incidentCount = ir.get(VARS.PLAYER_CAR_MY_INCIDENT_COUNT)?.[0] || 0;
        const fogLevel = ir.get(VARS.FOG_LEVEL)?.[0] || 0;
        const precipitation = ir.get(VARS.PRECIPITATION)?.[0] || 0;
        const weatherWet = ir.get(VARS.WEATHER_DECLARED_WET)?.[0] || 0;
        const fuelLevelSession = ir.get(VARS.FUEL_LEVEL)?.[0] || 0;
        const waterTemp = ir.get(VARS.WATER_TEMP)?.[0] || 0;
        const oilTemp = ir.get(VARS.OIL_TEMP)?.[0] || 0;

        // Event type + sky conditions from session info
        let eventType = '';
        let skies = '';
        let weatherType = '';
        try {
          const si = ir.getSessionInfo('SessionInfo');
          const sn = ir.get(VARS.SESSION_NUM)?.[0] ?? 0;
          eventType = si?.Sessions?.[sn]?.SessionType || '';
          // Log session type changes
          if (pollCount % 600 === 5) {
            const allSessions = si?.Sessions || [];
            log('[Session] SessionNum=' + sn + ' Type=' + eventType + ' AllSessions: ' + allSessions.map((s, i) => i + '=' + (s.SessionType || '?')).join(', '));
          }
          const wi = ir.getSessionInfo('WeekendInfo');
          skies = wi?.TrackSkies || '';
          weatherType = wi?.TrackWeatherType || '';
        } catch(e) {}

        // Capture total race session time on first race poll
        if (eventType.toLowerCase().includes('race') && raceSessionTotalTime === 0) {
          raceSessionTotalTime = sessionTime + sessionTimeRemain;
        }

        // Stint tracking (laps + time since last pit)
        const _pitRoad = ir.get(VARS.CAR_IDX_ON_PIT_ROAD) || [];
        const _lapsDone = ir.get(VARS.LAP_COMPLETED)?.[0] || 0;
        const playerOnPit = !!_pitRoad[playerCarIdx];
        if (playerOnPit && !_wasInPit) { _stintStartLap = _lapsDone; _stintStartTime = sessionTime; }
        _wasInPit = playerOnPit;
        const stintLaps = _lapsDone - (_stintStartLap || 0);
        const stintTime = sessionTime - (_stintStartTime || 0);

        // Player's estimated iRating change (from previous poll's calculation)

        broadcastToChannel('session', { type: 'data', channel: 'session', data: {
          playerCarIdx,
          trackName,
          airTemp, trackTemp, humidity, trackWetness,
          sessionTime, sessionTimeRemain, timeOfDay, sof, sofByClass,
          incidentCount, fogLevel, precipitation, weatherWet, skies, weatherType,
          windDir: ir.get(VARS.WIND_DIR)?.[0] || 0,
          windSpeed: ir.get(VARS.WIND_VEL)?.[0] || 0,
          fuelLevel: fuelLevelSession, waterTemp, oilTemp,
          sessionLapsRemain, eventType, sessionNum: ir.get(VARS.SESSION_NUM)?.[0] ?? 0, stintLaps, stintTime,
          playerIRChange: _lastPlayerIRChange,
          pitDeltas: classPitDeltas,
          fuelPerLap: avgAll > 0 ? avgAll : 0,
          fuelCapacity: fuelPct > 0 ? fuelLevel / fuelPct : 0,
          drivers: drivers.map(d => ({
            carIdx: d.CarIdx, driverName: d.UserName, carNumber: d.CarNumber,
            carMake: d.CarScreenNameShort || d.CarScreenName || '',
            country: d.LicCountryCode || '', license: d.LicString || '',
            iRating: d.IRating || 0,
          })),
        }});

        // Read camera spectated car index (for replay/spectate)
        let camCarIdx = playerCarIdx;
        try {
          const cam = ir.get(VARS.CAM_CAR_IDX);
          if (cam !== undefined && cam !== null) camCarIdx = Array.isArray(cam) ? cam[0] : cam;
        } catch(e) {}

        const userSelectedIdx = getSelectedCarIdx();
        const currentSelection = userSelectedIdx;
        const focusCarIdx = currentSelection !== null ? currentSelection : camCarIdx;

        // Switch iRacing camera when USER selects a driver from overlay
        if (currentSelection !== null && currentSelection !== lastFocusCarIdx && switchCamera) {
          const focusDriver = drivers.find(d => d.CarIdx === currentSelection);
          if (focusDriver && focusDriver.CarNumberRaw !== undefined) {
            log('[Focus] Overlay click → camera switch to car#' + focusDriver.CarNumberRaw + ' (idx=' + currentSelection + ')');
            switchCamera(focusDriver.CarNumberRaw, 0);
            lastCameraSwitchPoll = pollCount; // grace period before checking iRacing camera
          }
        }

        // Detect when iRacing camera changes (user pressed F3 or entered car)
        // Only check after grace period (60 polls = ~2s) to let our camera switch take effect
        if (currentSelection !== null && (pollCount - lastCameraSwitchPoll) > 60) {
          if (camCarIdx !== currentSelection && camCarIdx !== lastFocusCarIdx) {
            log('[Focus] iRacing camera changed to idx=' + camCarIdx + ', clearing overlay selection (was ' + currentSelection + ')');
            resetSelectedCar();
          }
        }

        lastFocusCarIdx = focusCarIdx;

        // Log focus state periodically
        if (pollCount === 90 || pollCount === 600) {
          log('[Focus] camCarIdx=' + camCarIdx + ' userSelected=' + userSelectedIdx + ' focusCarIdx=' + focusCarIdx + ' playerCarIdx=' + playerCarIdx);
        }

        // Use PLAYER_CAR_IDX from telemetry if session info unavailable
        if (!sessionInfoFound) {
          const pci = ir.get(VARS.PLAYER_CAR_POSITION);
          // Try to find our car idx from telemetry
        }

        const standings = [];
        // Build set of all known car indices from drivers + telemetry
        const activeIndices = new Set();
        for (let i = 0; i < lapsCompletedArr.length; i++) {
          if ((lapsCompletedArr[i] !== undefined && lapsCompletedArr[i] >= 0) || estTime[i] > 0 || lapDistPct[i] > 0) {
            activeIndices.add(i);
          }
        }
        // Also include all cars from session info (even if not on track yet)
        drivers.forEach(d => { if (d.CarIdx !== undefined && d.UserName && d.UserName !== 'Pace Car' && !d.IsSpectator) activeIndices.add(d.CarIdx); });

        const tireCompounds = ir.get(VARS.CAR_IDX_TIRE_COMPOUND) || [];

        for (const i of activeIndices) {
          const driver = drivers.find(d => d.CarIdx === i);
          const name = driver?.UserName || ('Car ' + i);
          const number = driver?.CarNumber || String(i);
          if (name === 'Pace Car') continue;
          if (driver?.IsSpectator) continue;

          // Lap times: real-time telemetry > cache > session results (YAML)
          // Real-time telemetry only has data for nearby cars; session results has all
          const rawBest = bestLaps[i];
          const rawLast = lastLaps[i];
          const rawLapsComp = lapsCompletedArr[i];
          const sr = sessionResults.get(i);

          if (rawBest > 0) {
            const prev = cachedBestLaps.get(i) || Infinity;
            cachedBestLaps.set(i, Math.min(prev, rawBest));
          }
          if (rawLast > 0) cachedLastLaps.set(i, rawLast);
          if (rawLapsComp >= 0) cachedLapsCompleted.set(i, Math.max(cachedLapsCompleted.get(i) || 0, rawLapsComp));

          const bestLap = rawBest > 0 ? rawBest : (cachedBestLaps.get(i) || sr?.bestLap || 0);
          const lastLapVal = rawLast > 0 ? rawLast : (cachedLastLaps.get(i) || sr?.lastLap || 0);
          const lapsComp = rawLapsComp >= 0 ? rawLapsComp : (cachedLapsCompleted.get(i) || sr?.lapsComplete || 0);

          standings.push({
            carIdx: i,
            position: positions[i] || 0,
            classPosition: classPositions[i] || 0,
            driverName: name,
            carNumber: number,
            carMake: driver?.CarScreenNameShort || driver?.CarScreenName || '',
            carClass: driver?.CarClassShortName || '',
            carClassColor: driver?.CarClassColor ? '#' + parseInt(driver.CarClassColor).toString(16).padStart(6, '0') : '#fff',
            safetyRating: driver?.LicString || '',
            country: driver?.FlairName || driver?.ClubName || '',
            clubId: driver?.ClubID || 0,
            license: driver?.LicString || '',
            iRating: driver?.IRating || 0,
            startIRating: startingIRatings.get(i) || 0,
            bestLap,
            lastLap: lastLapVal,
            inPit: !!onPitRoad[i],
            sessionFlags: carIdxFlags[i] || 0,
            lapsCompleted: lapsComp,
            estTime: estTime[i] || 0,
            lapDistPct: lapDistPct[i] || 0,
            isPlayer: i === playerCarIdx,
            isSpectated: i === focusCarIdx,
            tireCompound: tireCompounds[i] ?? -1,
            pitStops: pitStopCounts.get(i) || 0,
            lastPitDelta: driverPitDeltas.get(i) || 0,
            pitLap: pitLapMap.get(i) || 0,
            pitTimeLive: 0, // filled by pit detection below
            isStopped: false, // filled below
            gapToLeader: 0,
          });
        }

        // === Pit time measurement (wall-clock timing) ===
        // Measures actual time spent in pit lane: entry → exit using Date.now().
        // The IN-lap approach doesn't work because lapsCompleted only updates at the finish line,
        // which is after pit exit — so laps never complete while inPit is true.
        standings.forEach(s => {
          let pt = pitTracking.get(s.carIdx);
          if (!pt) {
            pt = { wasPitting: false };
            pitTracking.set(s.carIdx, pt);
          }
          // Driver just entered pit
          if (s.inPit && !pt.wasPitting) {
            pt.wasPitting = true;
            pitStopCounts.set(s.carIdx, (pitStopCounts.get(s.carIdx) || 0) + 1);
            pitEntryTimes.set(s.carIdx, Date.now());
            pitLapMap.set(s.carIdx, s.lapsCompleted || 0);
          }
          // Track live pit time
          if (s.inPit) {
            const entryTime = pitEntryTimes.get(s.carIdx);
            if (entryTime) s.pitTimeLive = (Date.now() - entryTime) / 1000;
          }
          // Driver just exited pit — measure duration
          if (!s.inPit && pt.wasPitting) {
            pt.wasPitting = false;
            const entryTime = pitEntryTimes.get(s.carIdx);
            if (entryTime) {
              const duration = (Date.now() - entryTime) / 1000;
              pitEntryTimes.delete(s.carIdx);
              // Store per-driver pit duration
              if (duration > 5) driverPitDeltas.set(s.carIdx, duration);
              // Smart filter for class average: first sample 15-60s, then ±15s of avg
              if (s.carClass && duration > 5) {
                const cls = s.carClass;
                const currentAvg = classPitDeltas[cls] ? classPitDeltas[cls].avgDelta : 0;
                const isReasonable = currentAvg === 0 ? (duration > 15 && duration < 60) : (Math.abs(duration - currentAvg) <= 5);
                if (isReasonable) {
                  if (!classPitDeltas[cls]) classPitDeltas[cls] = { avgDelta: 0, samples: 0 };
                  const d = classPitDeltas[cls];
                  d.avgDelta = (d.avgDelta * d.samples + duration) / (d.samples + 1);
                  d.samples++;
                  if (!pitTimesData[trackName]) pitTimesData[trackName] = {};
                  pitTimesData[trackName][cls] = { avgDelta: d.avgDelta, samples: d.samples };
                  savePitTimes(pitTimesData);
                  log('[PitTimes] ' + s.driverName + ' (' + cls + ') pit=' + duration.toFixed(1) + 's avg=' + d.avgDelta.toFixed(1) + 's (' + d.samples + ' samples)');
                } else {
                  log('[PitTimes] ' + s.driverName + ' (' + cls + ') pit=' + duration.toFixed(1) + 's FILTERED (avg=' + currentAvg.toFixed(1) + 's)');
                }
              }
            }
          }
        });

        // Detect stopped drivers (lapsCompleted hasn't changed for 3+ minutes)
        // Uses laps, not lapDistPct — as spectator, lapDistPct only updates for nearby cars
        standings.forEach(s => {
          const prev = driverLastLapPoll.get(s.carIdx);
          if (!prev) {
            driverLastLapPoll.set(s.carIdx, { laps: s.lapsCompleted || 0, poll: pollCount });
          } else if ((s.lapsCompleted || 0) > prev.laps) {
            driverLastLapPoll.set(s.carIdx, { laps: s.lapsCompleted, poll: pollCount });
          }
          const entry = driverLastLapPoll.get(s.carIdx);
          // 1800 polls = ~3 minutes at 10Hz — no lap completed in 3 min = likely out
          // Only mark if they've done at least 1 lap (not just joined)
          if (entry && entry.laps > 0 && (pollCount - entry.poll) > 1800 && !s.inPit) {
            s.isStopped = true;
          }
        });

        // Update persisted data for active drivers
        standings.forEach(s => persistedDrivers.set(s.carIdx, s));

        // Include persisted drivers who are no longer active (left session) but had data
        persistedDrivers.forEach((data, idx) => {
          if (!standings.find(s => s.carIdx === idx)) {
            // Use cached lap data — persisted snapshot may have stale values from disconnect transition
            standings.push({
              ...data,
              bestLap: cachedBestLaps.get(idx) || data.bestLap || 0,
              lastLap: cachedLastLaps.get(idx) || data.lastLap || 0,
              lapsCompleted: cachedLapsCompleted.get(idx) || data.lapsCompleted || 0,
              inPit: true,
              disconnected: true,
            });
          }
        });

        // Sort: use iRacing positions when available, fallback to laps+distance
        standings.sort((a, b) => {
          // Both have iRacing positions — use those (stable, updated at finish line)
          if (a.position > 0 && b.position > 0) return a.position - b.position;
          if (a.position > 0) return -1;
          if (b.position > 0) return 1;
          // Fallback: laps completed then track distance
          if (a.lapsCompleted !== b.lapsCompleted) return b.lapsCompleted - a.lapsCompleted;
          return b.lapDistPct - a.lapDistPct;
        });

        // Calculate gap to class leader in seconds (using estTime, fallback to lap-based)
        const classLeaderData = {};
        standings.forEach(s => {
          if (!classLeaderData[s.carClass] && s.classPosition === 1) {
            classLeaderData[s.carClass] = { estTime: s.estTime || 0, laps: s.lapsCompleted || 0, bestLap: s.bestLap || 0 };
          }
        });
        standings.forEach(s => {
          const leader = classLeaderData[s.carClass];
          if (!leader) return;
          if (leader.estTime > 0 && s.estTime > 0) {
            s.gapToLeader = s.estTime - leader.estTime;
          } else if (leader.laps > 0 && s.lapsCompleted >= 0 && leader.bestLap > 0) {
            // Fallback: laps behind * leader best lap + track position difference
            const lapsBehind = leader.laps - (s.lapsCompleted || 0);
            if (lapsBehind > 0) {
              s.gapToLeader = lapsBehind * leader.bestLap;
            }
          }
        });

        // Track qualify best laps per class
        if (eventType.toLowerCase().includes('qual') || eventType.toLowerCase().includes('lone')) {
          standings.forEach(s => {
            const cls = canonicalClass(s.carClass);
            if (cls && s.bestLap > 0 && s.classPosition === 1) {
              qualifyBestByClass[cls] = s.bestLap;
            }
          });
        }

        // Persist standings and SOF for use at session-change time
        lastStandings = standings;
        lastSofByClass = sofByClass;

        // Diagnostic: log standings count
        if (pollCount === 90 || pollCount === 300) {
          log('[Diag] Standings: ' + standings.length + ' drivers (active indices: ' + activeIndices.size + ', session drivers: ' + drivers.length + ')');
        }

        // Diagnostic: log lap time sources (first few polls only)
        if (pollCount === 90 || pollCount === 300) {
          log('[Diag] === LAP TIME DIAGNOSTICS ===');
          log('[Diag] SessionResults entries: ' + sessionResults.size);
          const sample = standings.slice(0, 5);
          sample.forEach(s => {
            const idx = s.carIdx;
            const sr = sessionResults.get(idx);
            log('[Diag] ' + s.driverName + ' (idx=' + idx + '): telemetry=' + bestLaps[idx] +
              ' cached=' + cachedBestLaps.get(idx) +
              ' sessionResult=' + (sr ? sr.bestLap : 'none') +
              ' -> final=' + s.bestLap + ' laps=' + s.lapsCompleted);
          });
          log('[Diag] WithBestLap: ' + standings.filter(s => s.bestLap > 0).length + '/' + standings.length);
        }

        // Compute estimated iRating changes from current positions
        const irChanges = estimateIRatingChanges(standings);
        standings.forEach(s => { s.estIRatingChange = irChanges.get(s.carIdx) || 0; });
        _lastPlayerIRChange = irChanges.get(playerCarIdx) || 0;

        // Diagnostic: log flag values (first poll only)
        if (pollCount === 90) {
          const flagged = standings.filter(s => s.sessionFlags && s.sessionFlags !== 0);
          if (flagged.length > 0) {
            log('[Flags] Drivers with flags:');
            flagged.slice(0, 5).forEach(s => log('[Flags]   ' + s.driverName + ' flags=0x' + s.sessionFlags.toString(16) + ' (' + s.sessionFlags + ')'));
          } else {
            // Log first 3 drivers to see what the default flag value is
            standings.slice(0, 3).forEach(s => log('[Flags]   ' + s.driverName + ' flags=0x' + (s.sessionFlags || 0).toString(16)));
          }
        }

        // Diagnostic: log per-class iRating details
        if (pollCount === 90 || pollCount === 600) {
          // Group by class for logging
          const classDiag = {};
          standings.filter(s => s.iRating > 0 && s.classPosition > 0).forEach(s => {
            const cls = s.carClass || 'Overall';
            if (!classDiag[cls]) classDiag[cls] = [];
            classDiag[cls].push(s);
          });
          for (const [cls, drivers] of Object.entries(classDiag)) {
            drivers.sort((a, b) => a.classPosition - b.classPosition);
            const classIRs = drivers.map(d => d.iRating);
            const classSOF = Math.round(classIRs.reduce((a, b) => a + b, 0) / classIRs.length);
            log('[iRating] ' + cls + ': ' + drivers.length + ' drivers, SOF=' + classSOF + ' (shown=' + (sofByClass[cls] || '?') + ')');
            drivers.forEach(s => {
              log('[iRating]   CP' + s.classPosition + ' #' + s.carNumber + ' ' + s.driverName + ' iR=' + s.iRating + ' est=' + (irChanges.get(s.carIdx) || 0));
            });
          }
        }

        // Only broadcast standings every 1 second (every 10th poll) to prevent flickering
        if (pollCount % 30 === 0) {
          broadcastToChannel('standings', { type: 'data', channel: 'standings', data: standings, spectatedCarIdx: focusCarIdx });
        }

        // === Wind === (after focusCarIdx so we can send the right heading)
        const playerYawVal = ir.get(VARS.YAW)?.[0] || 0;
        let windHeading = playerYawVal;

        // When focused on another driver, estimate their heading from track position
        if (focusCarIdx !== playerCarIdx && trackPathOutput.length > 10) {
          const focusPct = lapDistPct[focusCarIdx] || 0;
          if (focusPct > 0) {
            // Find two nearby track path points to get direction
            const SLOTS = trackPathOutput.length;
            const idx = Math.floor(focusPct * SLOTS) % SLOTS;
            const nextIdx = (idx + 1) % SLOTS;
            const p1 = trackPathOutput[idx];
            const p2 = trackPathOutput[nextIdx];
            if (p1 && p2) {
              // Track path is in GPS coords (x=lon, y=lat) — heading from p1 to p2
              const dx = p2.x - p1.x;
              const dy = p2.y - p1.y;
              windHeading = Math.atan2(dx, dy); // radians, 0=north
            }
          }
        }

        broadcastToChannel('wind', { type: 'data', channel: 'wind', data: {
          windDirection: ir.get(VARS.WIND_DIR)?.[0] || 0,
          windSpeed: ir.get(VARS.WIND_VEL)?.[0] || 0,
          carHeading: windHeading,
        }});

        // === Relative ===
        // Use spectated car as reference point (so relative re-centers when spectating another driver)
        const refCarIdx = focusCarIdx;
        const refLapDist = lapDistPct[refCarIdx] || 0;
        const relative = standings
          .filter(s => s.carIdx !== refCarIdx && s.carIdx !== playerCarIdx)
          .map(s => {
            // Gap based on track distance (0-1 for one lap)
            let distGap = s.lapDistPct - refLapDist;
            // Normalize to -0.5 to 0.5
            if (distGap > 0.5) distGap -= 1;
            if (distGap < -0.5) distGap += 1;
            // Convert to approximate seconds using estTime if available
            let gapSeconds = 0;
            if (s.estTime > 0 && estTime[refCarIdx] > 0) {
              gapSeconds = s.estTime - estTime[refCarIdx];
              if (gapSeconds > 50) gapSeconds -= 100;
              if (gapSeconds < -50) gapSeconds += 100;
            } else {
              // Rough estimate: assume ~90 second lap time
              gapSeconds = distGap * 90;
            }
            return { ...s, gap: gapSeconds, distGap };
          })
          .sort((a, b) => a.distGap - b.distGap);

        // Find the focused car's data for the center row
        const focusCar = standings.find(s => s.carIdx === refCarIdx) || null;

        if (pollCount % 5 === 0) broadcastToChannel('relative', { type: 'data', channel: 'relative', data: {
          playerCarIdx, spectatedCarIdx: focusCarIdx, cars: relative, focusCar,
        }});

        // === Track Map ===
        // Slot-based recording: only records when on-track and moving
        // Survives crashes/off-tracks — bad slots get overwritten on clean passes
        const playerPct = lapDistPct[playerCarIdx] || 0;
        const playerSpeed = ir.get(VARS.SPEED)?.[0] || 0;
        const playerYaw = ir.get(VARS.YAW_NORTH)?.[0] || 0;
        const trackSurface = ir.get(VARS.PLAYER_TRACK_SURFACE)?.[0] || 0;
        // iRacing TrackSurface: -1=NotInWorld, 0=OffTrack, 1=InPitStall, 2=ApproachPits, 3=OnTrack
        const isOnTrack = trackSurface >= 2; // Record on track + pit approach

        // Diagnostic: log track map state periodically
        if (pollCount === 150 || pollCount === 900) {
          log('[TrackMap] Diag: speed=' + playerSpeed.toFixed(1) + ' surface=' + trackSurface +
            ' isOnTrack=' + isOnTrack + ' pct=' + playerPct.toFixed(3) +
            ' slots=' + filledSlots + '/' + TRACK_SLOTS +
            ' complete=' + trackPathComplete + ' outputLen=' + trackPathOutput.length);
        }

        if (!trackPathComplete && playerSpeed > 5 && isOnTrack) {
          // Integrate position from heading + speed
          const dt = 0.1;
          const dx = Math.sin(playerYaw) * playerSpeed * dt;
          const dy = Math.cos(playerYaw) * playerSpeed * dt;
          lastIntX += dx;
          lastIntY += dy;

          // Write to the slot for this pct value
          const slotIdx = Math.floor(playerPct * TRACK_SLOTS) % TRACK_SLOTS;
          const isNew = !trackSlots[slotIdx];
          if (isNew) filledSlots++;
          trackSlots[slotIdx] = { x: lastIntX, y: lastIntY };
          // Log progress every 50 new slots
          if (isNew && filledSlots % 50 === 0) {
            log('[TrackMap] Mapping: ' + filledSlots + '/' + TRACK_SLOTS + ' slots (' + Math.round(filledSlots/TRACK_SLOTS*100) + '%)');
          }

          // Check completion: >90% of slots filled
          if (filledSlots > TRACK_SLOTS * 0.9) {
            trackPathComplete = true;
            trackPathOutput = buildTrackPath();
            log('[TrackMap] Path complete: ' + trackPathOutput.length + ' points (' + filledSlots + '/' + TRACK_SLOTS + ' slots)');
            if (trackName) {
              saveCachedTrack(trackName, trackPathOutput);
              uploadTrackToServer(trackName, trackPathOutput);
            }
          }

          // Build partial path for progressive display every 50 polls
          if (!trackPathComplete && pollCount % 150 === 0 && filledSlots > 30) {
            trackPathOutput = buildTrackPath();
          }
        }

        // Broadcast car positions every poll (100ms) for smooth movement
        const cars = [];
        for (const s of standings) {
          if (s.lapDistPct > 0 || s.estTime > 0) {
            cars.push({
              carIdx: s.carIdx,
              pct: s.lapDistPct,
              carNumber: s.carNumber,
              driverName: s.driverName,
              carClass: s.carClass,
              carClassColor: s.carClassColor,
              isPlayer: s.isPlayer,
              isSpectated: s.isSpectated,
              inPit: s.inPit,
            });
          }
        }
        broadcastToChannel('trackmap', { type: 'data', channel: 'trackmap', data: {
          trackPath: trackPathOutput.length > 0 ? trackPathOutput : [],
          trackPathReady: trackPathComplete,
          cars,
          playerCarIdx,
        }});

      } catch (e) {
        if (pollCount % 300 === 0) log('[Telemetry] Poll error: ' + e.message);
      }
    }, 33); // ~30Hz for responsive driver inputs graph
  }
}

function stopTelemetry() {
  connected = false;
  if (pollInterval) clearInterval(pollInterval);
  if (connectInterval) clearInterval(connectInterval);
}

module.exports = { startTelemetry, stopTelemetry, getStatus: () => ({ iracing: connected }) };
