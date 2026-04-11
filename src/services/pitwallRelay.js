'use strict';

const { WebSocketServer } = require('ws');
const db = require('../db');

// ── State ─────────────────────────────────────────────────────────
// Bridge connections: userId → { ws, teamId, username }
const bridgeClients = new Map();
// Pitwall viewers: ws → { userId, teamId, username, watchingDriverId, channels: Set }
const pitwallClients = new Map();
// Latest telemetry per driver: userId → Map<channel, { data, timestamp }>
const driverData = new Map();
// Last relay time per driver per channel: `${userId}:${channel}` → timestamp
const lastRelayTime = new Map();

// ── Throttle rates (ms between relays) ───────────────────────────
const THROTTLE = {
  standings: 1000,
  relative: 500,
  fuel: 1000,
  wind: 500,
  trackmap: 500,
  inputs: 100,
  session: 1000,
};

const AUTH_TIMEOUT_MS = 10000;

// ── Init ──────────────────────────────────────────────────────────
function init(httpServer) {
  const bridgeWss = new WebSocketServer({ noServer: true });
  const pitwallWss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = req.url.split('?')[0];
    if (url === '/ws/bridge') {
      bridgeWss.handleUpgrade(req, socket, head, ws => bridgeWss.emit('connection', ws, req));
    } else if (url === '/ws/pitwall') {
      pitwallWss.handleUpgrade(req, socket, head, ws => pitwallWss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  bridgeWss.on('connection', handleBridgeConnection);
  pitwallWss.on('connection', handlePitwallConnection);

  // Server-side ping/pong heartbeat — detect dead connections
  setInterval(() => {
    const now = Date.now();
    bridgeWss.clients.forEach(ws => {
      if (ws._pitwallLastPong && now - ws._pitwallLastPong > 60000) {
        ws.terminate();
        return;
      }
      ws._pitwallLastPong = ws._pitwallLastPong || now;
      try { ws.ping(); } catch {}
    });
    pitwallWss.clients.forEach(ws => {
      if (ws._pitwallLastPong && now - ws._pitwallLastPong > 60000) {
        ws.terminate();
        return;
      }
      ws._pitwallLastPong = ws._pitwallLastPong || now;
      try { ws.ping(); } catch {}
    });
  }, 30000);

  console.log('[Pitwall] WebSocket relay initialized (/ws/bridge, /ws/pitwall)');
}

// ── Bridge Connection ─────────────────────────────────────────────
function handleBridgeConnection(ws) {
  let authed = false;
  let userId = null;
  ws._pitwallLastPong = Date.now();
  ws.on('pong', () => { ws._pitwallLastPong = Date.now(); });

  // Auth timeout
  const authTimer = setTimeout(() => {
    if (!authed) {
      trySend(ws, { type: 'auth-error', reason: 'Auth timeout' });
      ws.close();
    }
  }, AUTH_TIMEOUT_MS);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (!authed) {
      if (msg.type === 'auth') {
        clearTimeout(authTimer);
        try {
          const result = authBridge(msg.userId, msg.token);
          if (result.error) {
            trySend(ws, { type: 'auth-error', reason: result.error });
            ws.close();
            return;
          }
          authed = true;
          userId = result.userId;

          // Disconnect previous bridge for same user
          const prev = bridgeClients.get(userId);
          if (prev) {
            trySend(prev.ws, { type: 'auth-error', reason: 'Another Bridge connected' });
            prev.ws.close();
          }

          bridgeClients.set(userId, { ws, teamId: result.teamId, username: result.username });
          driverData.set(userId, new Map());

          trySend(ws, { type: 'auth-ok', userId, teamId: result.teamId });
          broadcastToTeamViewers(result.teamId, { type: 'driver-online', userId, username: result.username });
          console.log('[Pitwall] Bridge authenticated:', result.username, '(team:', result.teamId + ')');
        } catch (e) {
          console.error('[Pitwall] Bridge auth error:', e.message);
          trySend(ws, { type: 'auth-error', reason: 'Server error' });
          ws.close();
        }
      }
      return;
    }

    // Heartbeat ping from Bridge
    if (msg.type === 'ping') {
      trySend(ws, { type: 'pong' });
      return;
    }

    // Telemetry
    if (msg.type === 'telemetry' && msg.channel && msg.data) {
      const channel = msg.channel;
      if (channel === 'proximity') return; // skip proximity relay

      const dd = driverData.get(userId);
      if (dd) {
        dd.set(channel, { data: msg.data, timestamp: Date.now() });
      }

      // Throttled relay to viewers watching this driver
      const throttleMs = THROTTLE[channel];
      if (!throttleMs) return;

      const throttleKey = userId + ':' + channel;
      const now = Date.now();
      const lastTime = lastRelayTime.get(throttleKey) || 0;
      if (now - lastTime < throttleMs) return;
      lastRelayTime.set(throttleKey, now);

      relayToViewers(userId, channel, msg.data);
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (userId && bridgeClients.get(userId)?.ws === ws) {
      const client = bridgeClients.get(userId);
      bridgeClients.delete(userId);
      driverData.delete(userId);
      // Clean throttle keys
      for (const key of lastRelayTime.keys()) {
        if (key.startsWith(userId + ':')) lastRelayTime.delete(key);
      }
      if (client) {
        broadcastToTeamViewers(client.teamId, { type: 'driver-offline', userId, username: client.username });
        console.log('[Pitwall] Bridge disconnected:', client.username);
      }
    }
  });

  ws.on('error', () => ws.close());
}

// ── Pitwall Viewer Connection ─────────────────────────────────────
function handlePitwallConnection(ws, req) {
  ws._pitwallLastPong = Date.now();
  ws.on('pong', () => { ws._pitwallLastPong = Date.now(); });

  // Auth via session cookie
  const sid = parseSessionCookie(req);
  if (!sid) {
    trySend(ws, { type: 'auth-error', reason: 'No session' });
    ws.close();
    return;
  }

  const session = db.getSession(sid);
  if (!session || !session.racing_user_id) {
    trySend(ws, { type: 'auth-error', reason: 'Invalid session' });
    ws.close();
    return;
  }

  const racingUser = db.getRacingUserById(session.racing_user_id);
  if (!racingUser) {
    trySend(ws, { type: 'auth-error', reason: 'User not found' });
    ws.close();
    return;
  }

  const membership = db.getTeamForUser(racingUser.id);
  if (!membership) {
    trySend(ws, { type: 'auth-error', reason: 'Not in a team' });
    ws.close();
    return;
  }

  const viewer = {
    userId: racingUser.id,
    teamId: membership.team_id,
    username: racingUser.username,
    watchingDriverId: null,
    channels: new Set(),
  };
  pitwallClients.set(ws, viewer);

  // Send auth OK with active drivers
  const activeDrivers = getActiveDrivers(membership.team_id);
  trySend(ws, { type: 'auth-ok', teamId: membership.team_id, activeDrivers });
  console.log('[Pitwall] Viewer connected:', racingUser.username);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'subscribe' && Array.isArray(msg.channels)) {
      viewer.channels = new Set(msg.channels);
      if (msg.driverId !== undefined) {
        viewer.watchingDriverId = msg.driverId;
        sendCachedData(ws, viewer);
      }
    } else if (msg.type === 'view-driver' && msg.driverId !== undefined) {
      viewer.watchingDriverId = msg.driverId;
      sendCachedData(ws, viewer);
    }
  });

  ws.on('close', () => {
    pitwallClients.delete(ws);
    console.log('[Pitwall] Viewer disconnected:', racingUser.username);
  });

  ws.on('error', () => ws.close());
}

// ── Helpers ───────────────────────────────────────────────────────

function authBridge(userId, token) {
  if (!userId || !token) return { error: 'userId and token required' };
  const user = db.getRacingUserById(userId);
  if (!user) return { error: 'Invalid credentials' };
  if (!user.pitwall_token || user.pitwall_token !== token) return { error: 'Invalid token' };
  const membership = db.getTeamForUser(user.id);
  if (!membership) return { error: 'Not in a team' };
  return { userId: user.id, teamId: membership.team_id, username: user.username };
}

function relayToViewers(driverId, channel, data) {
  const msg = JSON.stringify({ type: 'data', channel, data });
  const driverClient = bridgeClients.get(driverId);
  if (!driverClient) return;

  pitwallClients.forEach((viewer, ws) => {
    if (viewer.teamId === driverClient.teamId &&
        viewer.watchingDriverId === driverId &&
        viewer.channels.has(channel) &&
        ws.readyState === 1) {
      try { ws.send(msg); } catch {}
    }
  });
}

function sendCachedData(ws, viewer) {
  if (!viewer.watchingDriverId) return;
  const dd = driverData.get(viewer.watchingDriverId);
  if (!dd) return;
  for (const [channel, entry] of dd) {
    if (viewer.channels.has(channel)) {
      trySend(ws, { type: 'data', channel, data: entry.data });
    }
  }
}

function broadcastToTeamViewers(teamId, data) {
  const msg = JSON.stringify(data);
  pitwallClients.forEach((viewer, ws) => {
    if (viewer.teamId === teamId && ws.readyState === 1) {
      try { ws.send(msg); } catch {}
    }
  });
}

function getActiveDrivers(teamId) {
  const drivers = [];
  bridgeClients.forEach((client, userId) => {
    if (client.teamId === teamId) {
      drivers.push({ userId, username: client.username });
    }
  });
  return drivers;
}

function getDriverCount() {
  return bridgeClients.size;
}

function getViewerCount() {
  return pitwallClients.size;
}

function parseSessionCookie(req) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/(?:^|;\s*)session=([^;]+)/);
  return match ? match[1] : null;
}

function trySend(ws, data) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(data)); } catch {}
  }
}

module.exports = { init, getActiveDrivers, getDriverCount, getViewerCount };
