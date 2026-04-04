'use strict';

let statusCallback = null;
let connected = false;
let pollInterval = null;

const { broadcastToChannel } = require('./websocket');
const FuelCalculator = require('./fuel-calculator');
const RelativeCalculator = require('./relative');

const fuelCalc = new FuelCalculator();
const relativeCalc = new RelativeCalculator();

function startTelemetry(onStatusChange) {
  statusCallback = onStatusChange;

  let SDK;
  try {
    const irsdk = require('irsdk-node');
    SDK = irsdk;
  } catch (e) {
    console.error('[Telemetry] irsdk-node not available:', e.message);
    console.log('[Telemetry] Running in stub mode (no iRacing data)');
    return;
  }

  const sdk = new SDK.IRacingSDK();
  let wasConnected = false;

  // Poll for data at 10Hz
  pollInterval = setInterval(() => {
    try {
      const isRunning = sdk.isSimRunning();

      if (isRunning && !wasConnected) {
        console.log('[Telemetry] iRacing connected');
        connected = true;
        wasConnected = true;
        broadcastToChannel('_all', { type: 'status', iracing: true });
        if (statusCallback) statusCallback({ iracing: true });
      } else if (!isRunning && wasConnected) {
        console.log('[Telemetry] iRacing disconnected');
        connected = false;
        wasConnected = false;
        fuelCalc.reset();
        broadcastToChannel('_all', { type: 'status', iracing: false });
        if (statusCallback) statusCallback({ iracing: false });
      }

      if (!isRunning) return;

      // Read telemetry
      const telemetry = sdk.getTelemetry();
      const session = sdk.getSessionInfo();
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

      // Session data (less frequent)
      if (session) {
        const drivers = session.DriverInfo?.Drivers || [];
        const playerCarIdx = session.DriverInfo?.DriverCarIdx || 0;
        const trackName = session.WeekendInfo?.TrackDisplayName || '';
        const sessionType = '';

        broadcastToChannel('session', { type: 'data', channel: 'session', data: {
          playerCarIdx,
          trackName,
          sessionType,
          drivers: drivers.map(d => ({
            carIdx: d.CarIdx,
            driverName: d.UserName,
            carNumber: d.CarNumber,
            classColor: d.CarClassColor ? '#' + d.CarClassColor.toString(16).padStart(6, '0') : '#fff',
          })),
        }});

        // Standings
        const standings = [];
        for (let i = 0; i < drivers.length; i++) {
          const pos = telemetry.CarIdxPosition?.[i] || 0;
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
            onLeadLap: (telemetry.CarIdxLapCompleted?.[i] || 0) >= (telemetry.CarIdxLapCompleted?.[playerCarIdx] || 0),
            classColor: drivers[i]?.CarClassColor ? '#' + drivers[i].CarClassColor.toString(16).padStart(6, '0') : '#fff',
          });
        }
        standings.sort((a, b) => a.position - b.position);
        broadcastToChannel('standings', { type: 'data', channel: 'standings', data: standings });
      }

    } catch (e) {
      // Silently handle errors during polling
    }
  }, 100); // 10Hz
}

function stopTelemetry() {
  connected = false;
  if (pollInterval) clearInterval(pollInterval);
}

function getStatus() {
  return { iracing: connected };
}

module.exports = { startTelemetry, stopTelemetry, getStatus };
