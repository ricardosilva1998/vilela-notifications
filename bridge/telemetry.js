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

const { broadcastToChannel } = require('./websocket');
const FuelCalculator = require('./fuel-calculator');
const RelativeCalculator = require('./relative');

const fuelCalc = new FuelCalculator();
const relativeCalc = new RelativeCalculator();

async function startTelemetry(onStatusChange) {
  statusCallback = onStatusChange;
  log('[Telemetry] Starting telemetry reader...');
  log('[Telemetry] Log file: ' + logPath);

  let sdk;
  try {
    log('[Telemetry] Attempting to load @emiliosp/node-iracing-sdk via dynamic import...');
    const iRacingSDK = await import('@emiliosp/node-iracing-sdk');
    log('[Telemetry] SDK loaded. Exports: ' + Object.keys(iRacingSDK).join(', '));

    const SDKClass = iRacingSDK.iRacingSDK || iRacingSDK.IRacingSDK || iRacingSDK.default || iRacingSDK;
    if (typeof SDKClass === 'function') {
      sdk = new SDKClass();
      log('[Telemetry] SDK instance created from class');
    } else if (typeof SDKClass === 'object' && SDKClass !== null) {
      sdk = SDKClass;
      log('[Telemetry] SDK used as module object');
    } else {
      log('[Telemetry] SDK export type: ' + typeof SDKClass);
      return;
    }
  } catch (e) {
    log('[Telemetry] SDK FAILED: ' + e.message);
    log('[Telemetry] Stack: ' + e.stack);
    log('[Telemetry] Running in stub mode (no iRacing data)');
    return;
  }

  let wasConnected = false;

  pollInterval = setInterval(() => {
    try {
      // Check if iRacing is running
      const isRunning = typeof sdk.isSimRunning === 'function' ? sdk.isSimRunning() :
                        typeof sdk.isConnected === 'function' ? sdk.isConnected() :
                        typeof sdk.waitForData === 'function' ? true : false;

      if (isRunning && !wasConnected) {
        log('[Telemetry] iRacing connected');
        connected = true;
        wasConnected = true;
        broadcastToChannel('_all', { type: 'status', iracing: true });
        if (statusCallback) statusCallback({ iracing: true });
      } else if (!isRunning && wasConnected) {
        log('[Telemetry] iRacing disconnected');
        connected = false;
        wasConnected = false;
        fuelCalc.reset();
        broadcastToChannel('_all', { type: 'status', iracing: false });
        if (statusCallback) statusCallback({ iracing: false });
      }

      if (!isRunning) return;

      // Read telemetry
      const telemetry = typeof sdk.getTelemetry === 'function' ? sdk.getTelemetry() :
                        typeof sdk.getSessionData === 'function' ? sdk.getSessionData() : null;
      const session = typeof sdk.getSessionInfo === 'function' ? sdk.getSessionInfo() : null;

      if (!telemetry) return;

      // Fuel data
      fuelCalc.update(telemetry);
      broadcastToChannel('fuel', { type: 'data', channel: 'fuel', data: fuelCalc.getData() });

      // Wind data
      broadcastToChannel('wind', { type: 'data', channel: 'wind', data: {
        windDirection: telemetry.WindDir || 0,
        windSpeed: telemetry.WindVel || 0,
        carHeading: telemetry.Yaw || 0,
      }});

      // Proximity
      broadcastToChannel('proximity', { type: 'data', channel: 'proximity', data: {
        carLeftRight: telemetry.CarLeftRight || 0,
      }});

      // Session data
      if (session) {
        const drivers = session.DriverInfo?.Drivers || [];
        const playerCarIdx = session.DriverInfo?.DriverCarIdx || 0;
        const trackName = session.WeekendInfo?.TrackDisplayName || '';

        broadcastToChannel('session', { type: 'data', channel: 'session', data: {
          playerCarIdx,
          trackName,
          drivers: drivers.map(d => ({
            carIdx: d.CarIdx,
            driverName: d.UserName,
            carNumber: d.CarNumber,
            classColor: '#fff',
          })),
        }});

        // Standings
        const standings = [];
        if (telemetry.CarIdxPosition) {
          for (let i = 0; i < (telemetry.CarIdxPosition.length || 0); i++) {
            const pos = telemetry.CarIdxPosition[i] || 0;
            if (pos <= 0) continue;
            standings.push({
              carIdx: i,
              position: pos,
              driverName: drivers[i]?.UserName || '',
              carNumber: drivers[i]?.CarNumber || '',
              interval: '',
              lastLap: telemetry.CarIdxLastLapTime?.[i]?.toFixed(3) || '',
              bestLap: telemetry.CarIdxBestLapTime?.[i]?.toFixed(3) || '',
              inPit: !!telemetry.CarIdxOnPitRoad?.[i],
              onLeadLap: true,
              classColor: '#fff',
            });
          }
        }
        standings.sort((a, b) => a.position - b.position);
        broadcastToChannel('standings', { type: 'data', channel: 'standings', data: standings });
      }

    } catch (e) {
      // Log errors periodically (not every frame)
      if (Math.random() < 0.01) log('[Telemetry] Poll error: ' + e.message);
    }
  }, 100);
}

function stopTelemetry() {
  connected = false;
  if (pollInterval) clearInterval(pollInterval);
}

function getStatus() {
  return { iracing: connected };
}

module.exports = { startTelemetry, stopTelemetry, getStatus };
