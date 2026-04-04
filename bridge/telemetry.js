'use strict';

let irsdk = null;
let telemetryInterval = null;
let sessionInterval = null;
let statusCallback = null;
let connected = false;

const { broadcastToChannel } = require('./websocket');
const FuelCalculator = require('./fuel-calculator');
const RelativeCalculator = require('./relative');

const fuelCalc = new FuelCalculator();
const relativeCalc = new RelativeCalculator();

function startTelemetry(onStatusChange) {
  statusCallback = onStatusChange;

  try {
    irsdk = require('node-irsdk');
  } catch (e) {
    console.error('[Telemetry] node-irsdk not available:', e.message);
    console.log('[Telemetry] Running in stub mode (no iRacing data)');
    return;
  }

  const iracing = irsdk.init({ telemetryUpdateInterval: 100, sessionInfoUpdateInterval: 1000 });

  iracing.on('Connected', () => {
    console.log('[Telemetry] iRacing connected');
    connected = true;
    broadcastToChannel('_all', { type: 'status', iracing: true });
    if (statusCallback) statusCallback({ iracing: true });
  });

  iracing.on('Disconnected', () => {
    console.log('[Telemetry] iRacing disconnected');
    connected = false;
    fuelCalc.reset();
    broadcastToChannel('_all', { type: 'status', iracing: false });
    if (statusCallback) statusCallback({ iracing: false });
  });

  iracing.on('Telemetry', (data) => {
    const t = data.values;
    if (!t) return;

    // Fuel data
    fuelCalc.update(t);
    broadcastToChannel('fuel', { type: 'data', channel: 'fuel', data: fuelCalc.getData() });

    // Wind data
    broadcastToChannel('wind', { type: 'data', channel: 'wind', data: {
      windDirection: t.WindDir || 0,
      windSpeed: t.WindVel || 0,
      carHeading: t.Yaw || 0,
    }});

    // Proximity
    broadcastToChannel('proximity', { type: 'data', channel: 'proximity', data: {
      carLeftRight: t.CarLeftRight || 0,
    }});
  });

  iracing.on('SessionInfo', (data) => {
    const session = data.data;
    if (!session) return;

    const drivers = session.DriverInfo?.Drivers || [];
    const playerCarIdx = session.DriverInfo?.DriverCarIdx || 0;
    const trackName = session.WeekendInfo?.TrackDisplayName || '';
    const sessionType = session.SessionInfo?.Sessions?.[session.SessionNum]?.SessionType || '';

    // Session data
    broadcastToChannel('session', { type: 'data', channel: 'session', data: {
      playerCarIdx,
      trackName,
      sessionType,
      drivers: drivers.map(d => ({ carIdx: d.CarIdx, name: d.UserName, carNumber: d.CarNumber, classColor: d.CarClassColor })),
    }});

    // Standings
    // Note: Full standings require telemetry data merged with session info
    // This is a simplified version
    broadcastToChannel('standings', { type: 'data', channel: 'standings', data: [] });

    // Relative
    broadcastToChannel('relative', { type: 'data', channel: 'relative', data: [] });
  });
}

function stopTelemetry() {
  connected = false;
}

function getStatus() {
  return { iracing: connected };
}

module.exports = { startTelemetry, stopTelemetry, getStatus };
