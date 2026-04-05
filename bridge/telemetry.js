'use strict';

const fs = require('fs');
const path = require('path');

const logPath = path.join(require('os').homedir(), 'atleta-bridge.log');
try { fs.writeFileSync(logPath, ''); } catch(e) {}
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(msg);
  try { fs.appendFileSync(logPath, line); } catch(e) {}
}

let statusCallback = null;
let connected = false;
let pollInterval = null;
let connectInterval = null;

const { broadcastToChannel, getClientInfo } = require('./websocket');
const settings = require('./settings');
const { extractTrackFromIBT, geoKeyFromSessionInfo, loadCachedTrackByGeo, saveCachedTrackByGeo } = require('./trackExtractor');

// Fuel tracking
let fuelHistory = [];
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

function resetFuel() { fuelHistory = []; lastLap = -1; fuelAtLapStart = null; }

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
  let pollCount = 0;

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

        // === Get session info (requires key parameter!) ===
        if (!sessionInfoFound || pollCount % 300 === 0) {
          try {
            // getSessionInfo takes a KEY parameter, not called with no args!
            const driverInfo = ir.getSessionInfo('DriverInfo');
            const weekendInfo = ir.getSessionInfo('WeekendInfo');

            if (driverInfo && driverInfo.Drivers) {
              if (!sessionInfoFound) {
                sessionInfoFound = true;
                trackName = weekendInfo?.TrackDisplayName || '';
                log('[SessionInfo] Found! Drivers: ' + driverInfo.Drivers.length);
                log('[SessionInfo] Track: ' + trackName);

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
                      // Try .ibt files
                      const ibtResult = await extractTrackFromIBT();
                      if (ibtResult && ibtResult.points && !trackPathComplete) {
                        trackPathOutput = ibtResult.points;
                        trackPathComplete = true;
                        filledSlots = TRACK_SLOTS;
                        if (trackGeoKey) saveCachedTrackByGeo(trackGeoKey, ibtResult.points);
                        saveCachedTrack(trackName, ibtResult.points);
                        uploadTrackToServer(trackGeoKey || trackName, ibtResult.points);
                        log('[TrackMap] Extracted from .ibt (' + ibtResult.points.length + ' points)');
                      }
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
              trackName = weekendInfo?.TrackDisplayName || '';
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

        if (currentLap > lastLap && lastLap >= 0 && fuelAtLapStart !== null) {
          const used = fuelAtLapStart - fuelLevel;
          if (used > 0.01) { fuelHistory.push(used); if (fuelHistory.length > 20) fuelHistory.shift(); }
          fuelAtLapStart = fuelLevel;
        }
        if (lastLap < 0 || currentLap > lastLap) { if (fuelAtLapStart === null) fuelAtLapStart = fuelLevel; lastLap = currentLap; }

        const avg5 = fuelHistory.length > 0 ? fuelHistory.slice(-5).reduce((a,b) => a+b, 0) / Math.min(fuelHistory.length, 5) : 0;
        const avg10 = fuelHistory.length > 0 ? fuelHistory.slice(-10).reduce((a,b) => a+b, 0) / Math.min(fuelHistory.length, 10) : 0;
        const avgAll = fuelHistory.length > 0 ? fuelHistory.reduce((a,b) => a+b, 0) / fuelHistory.length : 0;
        const minUsage = fuelHistory.length > 0 ? Math.min(...fuelHistory) : 0;
        const maxUsage = fuelHistory.length > 0 ? Math.max(...fuelHistory) : 0;
        const lapsOfFuel = avgAll > 0 ? fuelLevel / avgAll : 0;
        const isUnlimited = sessionLapsRemain >= 32767;
        const fuelToFinish = (!isUnlimited && avgAll > 0) ? sessionLapsRemain * avgAll : 0;
        const fuelToAdd = fuelToFinish > 0 ? Math.max(0, fuelToFinish - fuelLevel) : 0;

        broadcastToChannel('fuel', { type: 'data', channel: 'fuel', data: {
          fuelLevel, fuelPct, fuelUsePerHour, avgPerLap: avgAll, avg5Laps: avg5, avg10Laps: avg10,
          minUsage, maxUsage, lapsOfFuel, lapsRemaining: isUnlimited ? '∞' : sessionLapsRemain,
          fuelToFinish, fuelToAdd, lapsCompleted, lapCount: fuelHistory.length,
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

        // === Wind ===
        broadcastToChannel('wind', { type: 'data', channel: 'wind', data: {
          windDirection: ir.get(VARS.WIND_DIR)?.[0] || 0,
          windSpeed: ir.get(VARS.WIND_VEL)?.[0] || 0,
          carHeading: ir.get(VARS.YAW)?.[0] || 0,
        }});

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
        const estTime = ir.get(VARS.CAR_IDX_EST_TIME) || [];
        const lapDistPct = ir.get(VARS.CAR_IDX_LAP_DIST_PCT) || [];

        broadcastToChannel('session', { type: 'data', channel: 'session', data: {
          playerCarIdx,
          trackName,
          drivers: drivers.map(d => ({
            carIdx: d.CarIdx, driverName: d.UserName, carNumber: d.CarNumber,
            carMake: d.CarScreenNameShort || d.CarScreenName || '',
            country: d.LicCountryCode || '', license: d.LicString || '',
            iRating: d.IRating || 0,
          })),
        }});

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
        drivers.forEach(d => { if (d.CarIdx !== undefined && d.UserName && d.UserName !== 'Pace Car') activeIndices.add(d.CarIdx); });

        for (const i of activeIndices) {
          const driver = drivers.find(d => d.CarIdx === i);
          const name = driver?.UserName || ('Car ' + i);
          const number = driver?.CarNumber || String(i);
          if (name === 'Pace Car') continue;

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
            country: driver?.ClubName || '',
            license: driver?.LicString || '',
            iRating: driver?.IRating || 0,
            bestLap,
            lastLap: lastLapVal,
            inPit: !!onPitRoad[i],
            lapsCompleted: lapsComp,
            estTime: estTime[i] || 0,
            lapDistPct: lapDistPct[i] || 0,
            isPlayer: i === playerCarIdx,
          });
        }

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

        standings.sort((a, b) => {
          if (a.position > 0 && b.position > 0) return a.position - b.position;
          if (a.position > 0) return -1;
          if (b.position > 0) return 1;
          if (a.lapsCompleted !== b.lapsCompleted) return b.lapsCompleted - a.lapsCompleted;
          return b.lapDistPct - a.lapDistPct;
        });

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

        // Only broadcast standings every 1 second (every 10th poll) to prevent flickering
        if (pollCount % 30 === 0) {
          broadcastToChannel('standings', { type: 'data', channel: 'standings', data: standings });
        }

        // === Relative ===
        // Relative: use lapDistPct for gap calculation (more reliable than estTime in practice)
        const playerLapDist = lapDistPct[playerCarIdx] || 0;
        const playerLaps = lapsCompletedArr[playerCarIdx] || 0;
        const relative = standings
          .filter(s => s.carIdx !== playerCarIdx)
          .map(s => {
            // Gap based on track distance (0-1 for one lap)
            let distGap = s.lapDistPct - playerLapDist;
            // Normalize to -0.5 to 0.5
            if (distGap > 0.5) distGap -= 1;
            if (distGap < -0.5) distGap += 1;
            // Convert to approximate seconds using estTime if available
            let gapSeconds = 0;
            if (s.estTime > 0 && estTime[playerCarIdx] > 0) {
              gapSeconds = s.estTime - estTime[playerCarIdx];
              if (gapSeconds > 50) gapSeconds -= 100;
              if (gapSeconds < -50) gapSeconds += 100;
            } else {
              // Rough estimate: assume ~90 second lap time
              gapSeconds = distGap * 90;
            }
            return { ...s, gap: gapSeconds, distGap };
          })
          .sort((a, b) => a.distGap - b.distGap);

        if (pollCount % 15 === 0) broadcastToChannel('relative', { type: 'data', channel: 'relative', data: {
          playerCarIdx, cars: relative,
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
