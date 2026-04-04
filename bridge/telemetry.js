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

const { broadcastToChannel } = require('./websocket');

// Fuel tracking
let fuelHistory = []; // per-lap fuel usage
let lastLap = -1;
let fuelAtLapStart = null;

function resetFuel() {
  fuelHistory = [];
  lastLap = -1;
  fuelAtLapStart = null;
}

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
  let debugDumped = false;

  connectInterval = setInterval(async () => {
    if (ir && connected) return;
    try {
      ir = await IRSDK.connect();
      if (ir && !connected) {
        connected = true;
        debugDumped = false;
        resetFuel();
        log('[Telemetry] Connected to iRacing!');
        broadcastToChannel('_all', { type: 'status', iracing: true });
        if (statusCallback) statusCallback({ iracing: true });
        startPolling(ir, VARS);
      }
    } catch (e) {
      if (connected) {
        connected = false;
        ir = null;
        log('[Telemetry] Disconnected: ' + e.message);
        broadcastToChannel('_all', { type: 'status', iracing: false });
        if (statusCallback) statusCallback({ iracing: false });
        resetFuel();
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
      }
    }
  }, 3000);

  function startPolling(ir, VARS) {
    if (pollInterval) clearInterval(pollInterval);

    pollInterval = setInterval(() => {
      try {
        if (!ir.isConnected()) {
          if (connected) {
            connected = false;
            log('[Telemetry] Disconnected during poll');
            broadcastToChannel('_all', { type: 'status', iracing: false });
            if (statusCallback) statusCallback({ iracing: false });
            resetFuel();
            clearInterval(pollInterval);
            pollInterval = null;
          }
          return;
        }

        ir.refreshSharedMemory();

        // === Session Info ===
        const si = ir.getSessionInfo?.();
        const drivers = si?.DriverInfo?.Drivers || [];
        const playerCarIdx = si?.DriverInfo?.DriverCarIdx ?? 0;

        // Debug dump once
        if (!debugDumped && si) {
          debugDumped = true;
          log('[Debug] Track: ' + (si.WeekendInfo?.TrackDisplayName || '?'));
          log('[Debug] PlayerCarIdx: ' + playerCarIdx);
          log('[Debug] Drivers: ' + drivers.length);
          drivers.slice(0, 5).forEach((d, i) => log('[Debug] D[' + i + '] idx=' + d.CarIdx + ' ' + d.UserName + ' #' + d.CarNumber));
        }

        // === Fuel ===
        const fuelLevel = ir.get(VARS.FUEL_LEVEL)?.[0] || 0;
        const fuelPct = ir.get(VARS.FUEL_LEVEL_PCT)?.[0] || 0;
        const fuelUsePerHour = ir.get(VARS.FUEL_USE_PER_HOUR)?.[0] || 0;
        const currentLap = ir.get(VARS.LAP)?.[0] || 0;
        const lapsCompleted = ir.get(VARS.LAP_COMPLETED)?.[0] || 0;
        const sessionLapsRemain = ir.get(VARS.SESSION_LAPS_REMAIN_EX)?.[0] || 0;

        // Track fuel per lap
        if (currentLap > lastLap && lastLap >= 0 && fuelAtLapStart !== null) {
          const used = fuelAtLapStart - fuelLevel;
          if (used > 0.01) {
            fuelHistory.push(used);
            if (fuelHistory.length > 20) fuelHistory.shift();
          }
          fuelAtLapStart = fuelLevel;
        }
        if (lastLap < 0 || currentLap > lastLap) {
          if (fuelAtLapStart === null) fuelAtLapStart = fuelLevel;
          lastLap = currentLap;
        }

        const avg5 = fuelHistory.length > 0 ? fuelHistory.slice(-5).reduce((a, b) => a + b, 0) / Math.min(fuelHistory.length, 5) : 0;
        const avg10 = fuelHistory.length > 0 ? fuelHistory.slice(-10).reduce((a, b) => a + b, 0) / Math.min(fuelHistory.length, 10) : 0;
        const avgAll = fuelHistory.length > 0 ? fuelHistory.reduce((a, b) => a + b, 0) / fuelHistory.length : 0;
        const minUsage = fuelHistory.length > 0 ? Math.min(...fuelHistory) : 0;
        const maxUsage = fuelHistory.length > 0 ? Math.max(...fuelHistory) : 0;
        const lapsOfFuel = avgAll > 0 ? fuelLevel / avgAll : 0;
        const isUnlimited = sessionLapsRemain >= 32767;
        const fuelToFinish = (!isUnlimited && avgAll > 0) ? sessionLapsRemain * avgAll : 0;
        const fuelToAdd = fuelToFinish > 0 ? Math.max(0, fuelToFinish - fuelLevel) : 0;

        broadcastToChannel('fuel', { type: 'data', channel: 'fuel', data: {
          fuelLevel,
          fuelPct,
          fuelUsePerHour,
          avgPerLap: avgAll,
          avg5Laps: avg5,
          avg10Laps: avg10,
          minUsage,
          maxUsage,
          lapsOfFuel,
          lapsRemaining: isUnlimited ? '∞' : sessionLapsRemain,
          fuelToFinish,
          fuelToAdd,
          lapsCompleted,
          lapCount: fuelHistory.length,
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

        // === Standings ===
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
          trackName: si?.WeekendInfo?.TrackDisplayName || '',
          drivers: drivers.map(d => ({
            carIdx: d.CarIdx,
            driverName: d.UserName,
            carNumber: d.CarNumber,
          })),
        }});

        // Build standings — include all active cars (lapCompleted >= 0)
        const standings = [];
        for (let i = 0; i < Math.max(positions.length, lapsCompletedArr.length); i++) {
          if (lapsCompletedArr[i] === undefined || lapsCompletedArr[i] < 0) continue;
          const driver = drivers.find(d => d.CarIdx === i);
          if (!driver) continue;

          standings.push({
            carIdx: i,
            position: positions[i] || 0,
            classPosition: classPositions[i] || 0,
            driverName: driver.UserName || '',
            carNumber: driver.CarNumber || '',
            lastLap: lastLaps[i] > 0 ? lastLaps[i].toFixed(3) : '',
            bestLap: bestLaps[i] > 0 ? bestLaps[i].toFixed(3) : '',
            inPit: !!onPitRoad[i],
            lapsCompleted: lapsCompletedArr[i] || 0,
            estTime: estTime[i] || 0,
            lapDistPct: lapDistPct[i] || 0,
            isPlayer: i === playerCarIdx,
          });
        }
        // Sort: by position if available, otherwise by laps completed + distance
        standings.sort((a, b) => {
          if (a.position > 0 && b.position > 0) return a.position - b.position;
          if (a.position > 0) return -1;
          if (b.position > 0) return 1;
          if (a.lapsCompleted !== b.lapsCompleted) return b.lapsCompleted - a.lapsCompleted;
          return b.lapDistPct - a.lapDistPct;
        });
        broadcastToChannel('standings', { type: 'data', channel: 'standings', data: standings });

        // === Relative ===
        const playerEstTime = estTime[playerCarIdx] || 0;
        const playerLapDist = lapDistPct[playerCarIdx] || 0;
        const relative = standings
          .filter(s => s.carIdx !== playerCarIdx && s.estTime > 0)
          .map(s => {
            let gap = s.estTime - playerEstTime;
            // Normalize gap (track is circular)
            if (gap > 50) gap -= 100;
            if (gap < -50) gap += 100;
            return { ...s, gap };
          })
          .sort((a, b) => a.gap - b.gap)
          .filter(s => Math.abs(s.gap) < 30); // Only show cars within 30 seconds

        broadcastToChannel('relative', { type: 'data', channel: 'relative', data: {
          playerCarIdx,
          cars: relative,
        }});

      } catch (e) {
        if (Math.random() < 0.005) log('[Telemetry] Poll error: ' + e.message);
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
