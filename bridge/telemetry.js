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

// Persistent driver data — keeps drivers visible after they disconnect
const persistedDrivers = new Map(); // carIdx -> last known standings entry

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
        persistedDrivers.clear();
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
                  // Log all driver keys to find correct country/license fields
                  const keys = Object.keys(d);
                  log('[SessionInfo] D[' + i + '] keys: ' + keys.join(', '));
                  log('[SessionInfo] D[' + i + '] data: idx=' + d.CarIdx + ' Name=' + d.UserName + ' #' + d.CarNumber +
                    ' iR=' + d.IRating + ' Lic=' + d.LicString + ' Country=' + d.LicCountryCode +
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
            lastLap: lastLaps[i] > 0 ? lastLaps[i] : 0,
            bestLap: bestLaps[i] > 0 ? bestLaps[i] : 0,
            inPit: !!onPitRoad[i],
            lapsCompleted: lapsCompletedArr[i] || 0,
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
            standings.push({ ...data, inPit: true, disconnected: true });
          }
        });

        standings.sort((a, b) => {
          if (a.position > 0 && b.position > 0) return a.position - b.position;
          if (a.position > 0) return -1;
          if (b.position > 0) return 1;
          if (a.lapsCompleted !== b.lapsCompleted) return b.lapsCompleted - a.lapsCompleted;
          return b.lapDistPct - a.lapDistPct;
        });

        // Log standings count periodically
        if (pollCount === 10 || pollCount === 100 || pollCount === 500) {
          log('[Standings] Built: ' + standings.length + ' (sessionInfo: ' + (sessionInfoFound ? 'yes' : 'no') + ', drivers: ' + drivers.length + ')');
          const classCounts = {};
          standings.forEach(s => { classCounts[s.carClass || '?'] = (classCounts[s.carClass || '?'] || 0) + 1; });
          log('[Standings] Classes: ' + JSON.stringify(classCounts));
          const withBest = standings.filter(s => s.bestLap > 0).length;
          log('[Standings] WithBestLap: ' + withBest + '/' + standings.length);

          // Log specific drivers to compare with iRacing
          // Find drivers by name substring to debug
          const debugNames = ['Argenis', 'Cheik', 'Frederico', 'Matus'];
          debugNames.forEach(nameSearch => {
            const found = standings.find(s => s.driverName.includes(nameSearch));
            if (found) {
              log('[Debug] ' + found.driverName + ': carIdx=' + found.carIdx +
                ' best=' + found.bestLap + ' last=' + found.lastLap + ' laps=' + found.lapsCompleted +
                ' pos=' + found.position + ' classPos=' + found.classPosition +
                ' estTime=' + found.estTime + ' lapDist=' + found.lapDistPct);
              // Also log the raw telemetry for this car index
              log('[Debug] Raw idx ' + found.carIdx + ': BestLap=' + (bestLaps[found.carIdx]) +
                ' LastLap=' + (lastLaps[found.carIdx]) + ' LapsCompleted=' + (lapsCompletedArr[found.carIdx]) +
                ' Position=' + (positions[found.carIdx]) + ' EstTime=' + (estTime[found.carIdx]));
            }
          });

          // Dump FULL telemetry arrays to see the actual data
          log('[Debug] Full CarIdxBestLapTime (first 20): ' + JSON.stringify((bestLaps || []).slice(0, 20)));
          log('[Debug] Full CarIdxLastLapTime (first 20): ' + JSON.stringify((lastLaps || []).slice(0, 20)));
          log('[Debug] Full CarIdxLapCompleted (first 20): ' + JSON.stringify((lapsCompletedArr || []).slice(0, 20)));
          log('[Debug] Full CarIdxPosition (first 20): ' + JSON.stringify((positions || []).slice(0, 20)));
          log('[Debug] Full CarIdxEstTime (first 20): ' + JSON.stringify((estTime || []).slice(0, 20)));

          // Check if arrays are proper arrays
          log('[Debug] bestLaps type=' + typeof bestLaps + ' isArray=' + Array.isArray(bestLaps) + ' length=' + (bestLaps?.length || 'N/A'));

          // Try reading a SINGLE CarIdx value directly
          try {
            const singleBest = ir.get('CarIdxBestLapTime');
            log('[Debug] Direct ir.get("CarIdxBestLapTime") type=' + typeof singleBest + ' length=' + (singleBest?.length || 'N/A') + ' first5=' + JSON.stringify(singleBest?.slice?.(0, 5)));
          } catch(e) { log('[Debug] Direct get error: ' + e.message); }

          // Try the VARS value directly
          log('[Debug] VARS.CAR_IDX_BEST_LAP_TIME value = ' + JSON.stringify(VARS.CAR_IDX_BEST_LAP_TIME));
        }

        broadcastToChannel('standings', { type: 'data', channel: 'standings', data: standings });

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

        broadcastToChannel('relative', { type: 'data', channel: 'relative', data: {
          playerCarIdx, cars: relative,
        }});

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
