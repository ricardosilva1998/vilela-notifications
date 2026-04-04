'use strict';

const { WebSocketServer } = require('ws');
let wss = null;
const clients = new Map();
let currentIracingStatus = false; // Track current status to send to new clients

function startServer(port) {
  wss = new WebSocketServer({ port });
  console.log(`[WebSocket] Server started on ws://localhost:${port}`);

  wss.on('connection', (ws) => {
    clients.set(ws, new Set());
    console.log('[WebSocket] Client connected');
    // Send immediate status so client knows bridge is running + current iRacing state
    try {
      ws.send(JSON.stringify({ type: 'bridge-connected' }));
      ws.send(JSON.stringify({ type: 'status', iracing: currentIracingStatus }));
    } catch(e) {}

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'subscribe' && Array.isArray(msg.channels)) {
          const subs = clients.get(ws);
          msg.channels.forEach(ch => subs.add(ch));
          console.log('[WebSocket] Client subscribed to:', [...subs]);
        }
      } catch (e) {}
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log('[WebSocket] Client disconnected');
    });

    ws.on('error', () => { clients.delete(ws); });
  });
}

function stopServer() {
  if (wss) wss.close();
}

function broadcastToChannel(channel, data) {
  if (!wss) return;
  // Track iRacing status for new clients
  if (data && data.type === 'status' && data.iracing !== undefined) {
    currentIracingStatus = data.iracing;
  }
  const msg = JSON.stringify(data);
  clients.forEach((subs, ws) => {
    if (ws.readyState === 1 && (channel === '_all' || subs.has(channel))) {
      try { ws.send(msg); } catch (e) {}
    }
  });
}

module.exports = { startServer, stopServer, broadcastToChannel };
