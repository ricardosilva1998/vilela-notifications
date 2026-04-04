'use strict';

const BRIDGE_URL = 'ws://localhost:9100';
let ws = null;
let bridgeConnected = false;
let iracingConnected = false;
const dataHandlers = {};

function connectBridge(channels) {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch (e) {
    console.log('[iRacing] Cannot connect to bridge');
    setTimeout(() => connectBridge(channels), 3000);
    return;
  }

  ws.onopen = () => {
    console.log('[iRacing] Bridge connected');
    bridgeConnected = true;
    updateConnectionStatus();
    ws.send(JSON.stringify({ type: 'subscribe', channels }));
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'status') {
        iracingConnected = msg.iracing;
        updateConnectionStatus();
        if (dataHandlers.status) dataHandlers.status(msg);
      } else if (msg.type === 'data' && dataHandlers[msg.channel]) {
        dataHandlers[msg.channel](msg.data, msg.timestamp);
      }
    } catch (e) {}
  };

  ws.onclose = () => {
    bridgeConnected = false;
    iracingConnected = false;
    updateConnectionStatus();
    setTimeout(() => connectBridge(channels), 3000);
  };

  ws.onerror = () => { ws.close(); };
}

function onData(channel, handler) {
  dataHandlers[channel] = handler;
}

function updateConnectionStatus() {
  const el = document.getElementById('connection-status');
  if (!el) return;
  if (!bridgeConnected) {
    el.innerHTML = '<span class="status-dot disconnected"></span> Bridge not running';
    showDisconnected('Start the Atleta Bridge app to connect.');
  } else if (!iracingConnected) {
    el.innerHTML = '<span class="status-dot waiting"></span> Waiting for iRacing';
    showDisconnected('Waiting for iRacing to start...');
  } else {
    el.innerHTML = '<span class="status-dot connected"></span> Live';
    hideDisconnected();
  }
}

function showDisconnected(msg) {
  let el = document.getElementById('overlay-disconnected');
  if (!el) {
    el = document.createElement('div');
    el.id = 'overlay-disconnected';
    el.className = 'overlay-disconnected';
    document.getElementById('overlay-root').appendChild(el);
  }
  el.textContent = msg;
  el.style.display = 'flex';
}

function hideDisconnected() {
  const el = document.getElementById('overlay-disconnected');
  if (el) el.style.display = 'none';
}

const settings = window.OVERLAY_SETTINGS || {};
function getSetting(key, defaultValue) {
  return settings[key] !== undefined ? settings[key] : defaultValue;
}

console.log('[iRacing] Overlay loaded:', window.OVERLAY_TYPE);
