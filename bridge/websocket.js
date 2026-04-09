'use strict';

const { WebSocketServer } = require('ws');
let wss = null;
const clients = new Map();
let currentIracingStatus = false;
let selectedCarIdx = null;
let nextClientId = 1;
const MAX_LOG_ENTRIES = 500;

const clientLogs = new Map();
const disconnectedMeta = new Map();

function startServer(port) {
  wss = new WebSocketServer({ port });
  console.log(`[WebSocket] Server started on ws://localhost:${port}`);

  wss.on('connection', (ws) => {
    const clientId = nextClientId++;
    const meta = { id: clientId, channels: new Set(), connectedAt: Date.now(), name: 'Client #' + clientId };
    clients.set(ws, meta);
    clientLogs.set(clientId, []);
    console.log('[WebSocket] Client connected (id: ' + clientId + ')');

    try {
      ws.send(JSON.stringify({ type: 'bridge-connected' }));
      ws.send(JSON.stringify({ type: 'status', iracing: currentIracingStatus }));
    } catch(e) {}

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'subscribe' && Array.isArray(msg.channels)) {
          msg.channels.forEach(ch => meta.channels.add(ch));
          meta.name = deriveClientName(meta.channels);
          console.log('[WebSocket] Client ' + clientId + ' (' + meta.name + ') subscribed to:', [...meta.channels]);
        } else if (msg.type === 'select-driver' && msg.carIdx !== undefined) {
          selectedCarIdx = msg.carIdx === null ? null : Number(msg.carIdx);
          broadcastToChannel('_all', { type: 'driver-selected', carIdx: selectedCarIdx });
        }
      } catch (e) {}
    });

    ws.on('close', () => {
      const m = clients.get(ws);
      if (m) {
        console.log('[WebSocket] Client disconnected (id: ' + m.id + ', ' + m.name + ')');
        m.disconnectedAt = Date.now();
        disconnectedMeta.set(m.id, { id: m.id, name: m.name, channels: [...m.channels], disconnectedAt: m.disconnectedAt });
      }
      clients.delete(ws);
    });

    ws.on('error', () => {
      const m = clients.get(ws);
      if (m) {
        m.disconnectedAt = Date.now();
        disconnectedMeta.set(m.id, { id: m.id, name: m.name, channels: [...m.channels], disconnectedAt: m.disconnectedAt });
      }
      clients.delete(ws);
    });
  });
}

function stopServer() {
  if (wss) wss.close();
}

function deriveClientName(channels) {
  if (!channels || channels.size === 0) return 'Unknown';
  const names = [...channels].map(ch => ch.charAt(0).toUpperCase() + ch.slice(1));
  return names.join(', ');
}

function logToClient(clientId, entry) {
  const log = clientLogs.get(clientId);
  if (!log) return;
  log.push(entry);
  if (log.length > MAX_LOG_ENTRIES) log.splice(0, log.length - MAX_LOG_ENTRIES);
}

function broadcastToChannel(channel, data) {
  if (!wss) return;
  if (data && data.type === 'status' && data.iracing !== undefined) {
    currentIracingStatus = data.iracing;
  }
  const msg = JSON.stringify(data);
  const size = msg.length;
  clients.forEach((meta, ws) => {
    if (ws.readyState === 1 && (channel === '_all' || meta.channels.has(channel))) {
      try {
        ws.send(msg);
        logToClient(meta.id, {
          ts: Date.now(),
          channel: channel === '_all' ? 'broadcast' : channel,
          type: data.type || 'unknown',
          size
        });
      } catch (e) {}
    }
  });
}

function getClientInfo() {
  const info = [];
  clients.forEach((meta) => {
    info.push({ id: meta.id, state: 1, channels: [...meta.channels], name: meta.name, connectedAt: meta.connectedAt, logCount: (clientLogs.get(meta.id) || []).length });
  });
  clientLogs.forEach((log, clientId) => {
    if (!info.find(c => c.id === clientId) && log.length > 0) {
      const dm = disconnectedMeta.get(clientId);
      const name = dm ? dm.name : 'Disconnected #' + clientId;
      info.push({ id: clientId, state: 3, channels: dm ? dm.channels : [], name, connectedAt: dm ? dm.disconnectedAt : 0, logCount: log.length });
    }
  });
  return info;
}

function getClientLog(clientId) {
  return clientLogs.get(clientId) || [];
}

function clearClientLog(clientId) {
  clientLogs.set(clientId, []);
}

function clearAllClientLogs() {
  clientLogs.forEach((log, id) => { clientLogs.set(id, []); });
  for (const [id] of clientLogs) {
    let stillConnected = false;
    clients.forEach(meta => { if (meta.id === id) stillConnected = true; });
    if (!stillConnected) {
      clientLogs.delete(id);
      disconnectedMeta.delete(id);
    }
  }
}

function getSelectedCarIdx() { return selectedCarIdx; }
function resetSelectedCar() { selectedCarIdx = null; }

module.exports = { startServer, stopServer, broadcastToChannel, getClientInfo, getClientLog, clearClientLog, clearAllClientLogs, getSelectedCarIdx, resetSelectedCar };
