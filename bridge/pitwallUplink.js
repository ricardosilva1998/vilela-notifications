'use strict';

const WebSocket = require('ws');
const settings = require('./settings');

const SERVER_URL = 'wss://atletanotifications.com/ws/bridge';
const RECONNECT_BASE = 5000;
const RECONNECT_MAX = 60000;
const HEARTBEAT_INTERVAL = 30000;

let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let isConnected = false;
let enabled = false;
let reconnectDelay = RECONNECT_BASE;
let availableTeams = [];    // Teams returned by server on auth
let broadcastTeamIds = [];  // Teams user chose to broadcast to
let hasAuthedOnce = false;  // True after first successful auth this session

// Callback for control panel to update UI
let onTeamsUpdated = null;

function start() {
  const s = settings.load();
  if (!s.racingUserId || !s.pitwallToken) {
    console.log('[Pitwall Uplink] No credentials — skipping');
    return;
  }
  enabled = true;
  broadcastTeamIds = s.pitwallBroadcastTeamIds || [];
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
      hasAuthedOnce = true;
      reconnectDelay = RECONNECT_BASE;
      availableTeams = msg.teams || [];
      console.log('[Pitwall Uplink] Authenticated (' + availableTeams.length + ' teams)');
      startHeartbeat();

      // Filter saved broadcast teams to only valid ones
      const validIds = new Set(availableTeams.map(t => t.id));
      broadcastTeamIds = broadcastTeamIds.filter(id => validIds.has(id));

      // Send saved broadcast selection
      if (broadcastTeamIds.length > 0) {
        trySend({ type: 'set-teams', teamIds: broadcastTeamIds });
      }

      if (onTeamsUpdated) onTeamsUpdated(availableTeams, broadcastTeamIds);
    } else if (msg.type === 'auth-error') {
      console.error('[Pitwall Uplink] Auth failed:', msg.reason);
      isConnected = false;
      ws.close();
    } else if (msg.type === 'teams-updated') {
      broadcastTeamIds = msg.teamIds || [];
      if (onTeamsUpdated) onTeamsUpdated(availableTeams, broadcastTeamIds);
    } else if (msg.type === 'pong') {
      // Heartbeat response
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
  console.log('[Pitwall Uplink] Reconnecting in', Math.round(reconnectDelay / 1000), 's...');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX);
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    trySend({ type: 'ping' });
  }, HEARTBEAT_INTERVAL);
}

function sendTelemetry(channel, data) {
  if (!isConnected) return;
  trySend({ type: 'telemetry', channel, data });
}

function setBroadcastTeams(teamIds) {
  broadcastTeamIds = teamIds;
  // Persist to settings
  const s = settings.load();
  s.pitwallBroadcastTeamIds = teamIds;
  settings.save(s);
  // Send to server
  if (isConnected) {
    trySend({ type: 'set-teams', teamIds });
  }
}

function trySend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(data)); } catch {}
  }
}

function getStatus() {
  return isConnected ? 'connected' : (enabled ? 'disconnected' : 'disabled');
}

function getAvailableTeams() {
  return availableTeams;
}

function getBroadcastTeamIds() {
  return broadcastTeamIds;
}

function setOnTeamsUpdated(cb) {
  onTeamsUpdated = cb;
  // If we've authenticated at least once this session, fire with last known teams
  if (hasAuthedOnce) {
    cb(availableTeams, broadcastTeamIds);
  }
}

module.exports = { start, stop, sendTelemetry, setBroadcastTeams, getStatus, getAvailableTeams, getBroadcastTeamIds, setOnTeamsUpdated };
