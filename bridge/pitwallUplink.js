'use strict';

const WebSocket = require('ws');
const settings = require('./settings');

const SERVER_URL = 'wss://atletanotifications.com/ws/bridge';
const RECONNECT_DELAY = 5000;
const HEARTBEAT_INTERVAL = 30000;

let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let isConnected = false;
let enabled = false;

function start() {
  const s = settings.load();
  if (!s.racingUserId || !s.pitwallToken) {
    console.log('[Pitwall Uplink] No credentials — skipping');
    return;
  }
  enabled = true;
  connect();
}

function stop() {
  enabled = false;
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  reconnectTimer = null;
  heartbeatTimer = null;
  if (ws) {
    isConnected = false;
    ws.close();
    ws = null;
  }
}

function connect() {
  if (!enabled) return;
  if (ws) return;

  const s = settings.load();
  if (!s.racingUserId || !s.pitwallToken) return;

  try {
    ws = new WebSocket(SERVER_URL);
  } catch (e) {
    console.error('[Pitwall Uplink] Connection error:', e.message);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    console.log('[Pitwall Uplink] Connected, authenticating...');
    trySend({ type: 'auth', userId: s.racingUserId, token: s.pitwallToken });
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'auth-ok') {
      isConnected = true;
      console.log('[Pitwall Uplink] Authenticated (team:', msg.teamId + ')');
      startHeartbeat();
    } else if (msg.type === 'auth-error') {
      console.error('[Pitwall Uplink] Auth failed:', msg.reason);
      isConnected = false;
      ws.close();
    } else if (msg.type === 'pong') {
      // Heartbeat response — connection alive
    }
  });

  ws.on('close', () => {
    isConnected = false;
    ws = null;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (enabled) scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[Pitwall Uplink] Error:', err.message);
    if (ws) ws.close();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  console.log('[Pitwall Uplink] Reconnecting in', RECONNECT_DELAY / 1000, 's...');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY);
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    trySend({ type: 'ping' });
  }, HEARTBEAT_INTERVAL);
}

// Called by telemetry.js to send data to the server
function sendTelemetry(channel, data) {
  if (!isConnected) return;
  trySend({ type: 'telemetry', channel, data });
}

function trySend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(data)); } catch {}
  }
}

function getStatus() {
  return isConnected ? 'connected' : (enabled ? 'disconnected' : 'disabled');
}

module.exports = { start, stop, sendTelemetry, getStatus };
