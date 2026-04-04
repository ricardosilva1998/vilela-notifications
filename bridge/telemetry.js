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

// Fuel tracking
let fuelHistory = [];
let lastLap = -1;
let fuelAtLapStart = null;

// Track map
const trackPath = []; // Array of {lat, lon, pct} points
let trackPathComplete = false;
let lastTrackPct = -1;

// Persistent driver data — keeps drivers visible after they disconnect
const persistedDrivers = new Map();
// Cached lap times — survives pit stops where telemetry returns -1
const cachedBestLaps = new Map(); // carIdx -> best lap time
const cachedLastLaps = new Map(); // carIdx -> last lap time
const cachedLapsCompleted = new Map(); // carIdx -> laps completed

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
        trackPath.length = 0;
        trackPathComplete = false;
        lastTrackPct = -1;
        persistedDrivers.clear();
        cachedBestLaps.clear();
        cachedLastLaps.clear();
        cachedLapsCompleted.clear();
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
        if (!sessionInfoFound || pollCount % 100 === 0) {
          try {
            // getSessionInfo takes a KEY parameter, not called with no args!
            const driverInfo = ir.getSessionInfo('DriverInfo');
            const weekendInfo = ir.getSessionInfo('WeekendInfo');

            if (driverInfo && driverInfo.Drivers) {
              if (!sessionInfoFound) {
                sessionInfoFound = true;
                log('[SessionInfo] Found! Drivers: ' + driverInfo.Drivers.length);
                log('[SessionInfo] Track: ' + (weekendInfo?.TrackDisplayName || '?'));
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
            } else if (pollCount % 100 === 0) {
              log('[SessionInfo] DriverInfo not available yet (poll ' + pollCount + ')');
            }
          } catch(e) {
            if (pollCount % 100 === 0) log('[SessionInfo] Error: ' + e.message);
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

          // Cache lap times — telemetry returns -1 when car is in pits
          const rawBest = bestLaps[i];
          const rawLast = lastLaps[i];
          const rawLapsComp = lapsCompletedArr[i];

          if (rawBest > 0) {
            const prev = cachedBestLaps.get(i) || Infinity;
            cachedBestLaps.set(i, Math.min(prev, rawBest)); // Keep actual best
          }
          if (rawLast > 0) cachedLastLaps.set(i, rawLast);
          if (rawLapsComp >= 0) cachedLapsCompleted.set(i, Math.max(cachedLapsCompleted.get(i) || 0, rawLapsComp));

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
            bestLap: rawBest > 0 ? rawBest : (cachedBestLaps.get(i) || 0),
            lastLap: rawLast > 0 ? rawLast : (cachedLastLaps.get(i) || 0),
            inPit: !!onPitRoad[i],
            lapsCompleted: rawLapsComp >= 0 ? rawLapsComp : (cachedLapsCompleted.get(i) || 0),
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

        // Log standings summary periodically
        if (pollCount === 50 || pollCount === 200) {
          log('[Standings] Built: ' + standings.length + ' (sessionInfo: ' + (sessionInfoFound ? 'yes' : 'no') + ', drivers: ' + drivers.length + ')');
          const classCounts = {};
          standings.forEach(s => { classCounts[s.carClass || '?'] = (classCounts[s.carClass || '?'] || 0) + 1; });
          log('[Standings] Classes: ' + JSON.stringify(classCounts));
          log('[Standings] WithBestLap: ' + standings.filter(s => s.bestLap > 0).length + '/' + standings.length);
        }

        // Only broadcast standings every 1 second (every 10th poll) to prevent flickering
        if (pollCount % 10 === 0) {
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

        if (pollCount % 5 === 0) broadcastToChannel('relative', { type: 'data', channel: 'relative', data: {
          playerCarIdx, cars: relative,
        }});

        // === Track Map ===
        // Try VARS constants first, fall back to direct string names
        let playerLat = ir.get(VARS.LAT)?.[0] || 0;
        let playerLon = ir.get(VARS.LON)?.[0] || 0;
        if (playerLat === 0 && playerLon === 0) {
          playerLat = ir.get('Lat')?.[0] || 0;
          playerLon = ir.get('Lon')?.[0] || 0;
        }
        const playerPct = lapDistPct[playerCarIdx] || 0;

        // Build track path from player GPS as they drive
        if (playerLat !== 0 && playerLon !== 0 && !trackPathComplete) {
          if (lastTrackPct < 0 || Math.abs(playerPct - lastTrackPct) > 0.002) {
            const prevPct = lastTrackPct;
            trackPath.push({ lat: playerLat, lon: playerLon, pct: playerPct });
            lastTrackPct = playerPct;
            // Track is complete when we have points across the full range and wrap back
            if (trackPath.length > 100 && playerPct < 0.05 && prevPct > 0.95) {
              trackPathComplete = true;
              log('[TrackMap] Path complete: ' + trackPath.length + ' points');
            }
          }
        }

        // Broadcast car positions on track
        if (pollCount % 5 === 0) {
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
          // Send partial track path while mapping (>20 points), full path once complete
          const hasUsablePath = trackPathComplete || trackPath.length > 20;
          broadcastToChannel('trackmap', { type: 'data', channel: 'trackmap', data: {
            trackPath: hasUsablePath ? trackPath : [],
            trackPathReady: trackPathComplete,
            cars,
            playerCarIdx,
          }});
        }

      } catch (e) {
        if (pollCount % 100 === 0) log('[Telemetry] Poll error: ' + e.message);
      }
    }, 100);
  }
}

function stopTelemetry() {
  connected = false;
  if (pollInterval) clearInterval(pollInterval);
  if (connectInterval) clearInterval(connectInterval);
}

module.exports = { startTelemetry, stopTelemetry, getStatus: () => ({ iracing: connected }) };
