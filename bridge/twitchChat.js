'use strict';

const fs = require('fs');
const path = require('path');
const logPath = path.join(require('os').homedir(), 'atleta-bridge.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(msg);
  try { fs.appendFileSync(logPath, line); } catch(e) {}
}

const { broadcastToChannel } = require('./websocket');
let tmiClient = null;
let currentChannel = null;

async function connectToChannel(channel) {
  if (!channel) {
    log('[TwitchChat] No channel specified');
    broadcastToChannel('chat', { type: 'chat-status', status: 'no-channel' });
    return;
  }

  // Normalize channel name
  channel = channel.toLowerCase().replace(/^#/, '').trim();
  if (!channel) return;

  // Disconnect existing connection if channel changed
  if (tmiClient && currentChannel !== channel) {
    try { tmiClient.disconnect(); } catch(e) {}
    tmiClient = null;
    currentChannel = null;
  }

  if (tmiClient && currentChannel === channel) return; // Already connected

  log('[TwitchChat] Connecting to #' + channel);
  broadcastToChannel('chat', { type: 'chat-status', status: 'connecting', channel });

  try {
    const tmi = require('tmi.js');
    tmiClient = new tmi.Client({
      connection: { reconnect: true, secure: true },
      channels: [channel],
    });

    tmiClient.on('message', (ch, tags, message, self) => {
      broadcastToChannel('chat', { type: 'data', channel: 'chat', data: {
        username: tags['display-name'] || tags.username || 'anonymous',
        message,
        color: tags.color || null,
        badges: tags.badges || {},
      }});
    });

    tmiClient.on('connected', () => {
      currentChannel = channel;
      log('[TwitchChat] Connected to #' + channel);
      broadcastToChannel('chat', { type: 'chat-status', status: 'connected', channel: '#' + channel });
    });

    tmiClient.on('disconnected', (reason) => {
      log('[TwitchChat] Disconnected: ' + reason);
      broadcastToChannel('chat', { type: 'chat-status', status: 'disconnected' });
    });

    await tmiClient.connect();
  } catch(e) {
    log('[TwitchChat] Error: ' + e.message);
    broadcastToChannel('chat', { type: 'chat-status', status: 'error' });
    tmiClient = null;
    currentChannel = null;
  }
}

function disconnect() {
  if (tmiClient) {
    try { tmiClient.disconnect(); } catch(e) {}
    tmiClient = null;
    currentChannel = null;
  }
}

function getCurrentChannel() { return currentChannel; }

module.exports = { connectToChannel, disconnect, getCurrentChannel };
