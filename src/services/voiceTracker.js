'use strict';

const { joinVoiceChannel, VoiceConnectionStatus, entersState, getVoiceConnection } = require('@discordjs/voice');

const speakingUsers = new Map();
let currentConnection = null;
let currentChannelId = null;
let disconnectTimer = null;
let connecting = false; // Lock to prevent concurrent join attempts

async function ensureConnected(channel) {
  // Already connected to this channel
  if (currentConnection && currentChannelId === channel.id) {
    clearDisconnectTimer();
    return currentConnection;
  }

  // Another attempt is in progress — skip
  if (connecting) return null;
  connecting = true;

  // Disconnect previous
  if (currentConnection) {
    try { currentConnection.destroy(); } catch(e) {}
    currentConnection = null;
    currentChannelId = null;
    speakingUsers.clear();
  }

  try {
    console.log('[VoiceTracker] Joining: ' + channel.name + ' (' + channel.id + ')');

    // Check if a connection already exists for this guild
    const existing = getVoiceConnection(channel.guild.id);
    if (existing) {
      console.log('[VoiceTracker] Destroying existing connection');
      try { existing.destroy(); } catch(e) {}
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    // Log state changes for debugging
    connection.on('stateChange', (oldState, newState) => {
      console.log('[VoiceTracker] State: ' + oldState.status + ' -> ' + newState.status);
    });

    // Wait for Ready with timeout
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20000);
    } catch(e) {
      console.log('[VoiceTracker] Timeout waiting for Ready, current state: ' + connection.state.status);
      // If signalling but not ready, it might still work — don't destroy
      if (connection.state.status !== VoiceConnectionStatus.Ready) {
        try { connection.destroy(); } catch(e2) {}
        connecting = false;
        return null;
      }
    }

    console.log('[VoiceTracker] Connected! State: ' + connection.state.status);

    // Set up speaking detection
    const receiver = connection.receiver;

    if (receiver.speaking) {
      receiver.speaking.on('start', (userId) => {
        speakingUsers.set(userId, { speaking: true, ts: Date.now() });
      });
      receiver.speaking.on('end', (userId) => {
        const entry = speakingUsers.get(userId);
        if (entry) entry.speaking = false;
      });
    }

    // Subscribe to all members for speaking events
    try {
      for (const [, member] of channel.members) {
        if (!member.user.bot) {
          receiver.subscribe(member.id, { end: { behavior: 0 } });
        }
      }
      console.log('[VoiceTracker] Subscribed to ' + channel.members.filter(m => !m.user.bot).size + ' members');
    } catch(e) {
      console.log('[VoiceTracker] Subscribe note: ' + e.message);
    }

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.log('[VoiceTracker] Disconnected, attempting reconnect...');
      try {
        await entersState(connection, VoiceConnectionStatus.Connecting, 5000);
      } catch {
        currentConnection = null;
        currentChannelId = null;
        speakingUsers.clear();
        try { connection.destroy(); } catch(e) {}
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      currentConnection = null;
      currentChannelId = null;
      speakingUsers.clear();
    });

    // Auto-timeout speaking after 3 seconds
    setInterval(() => {
      const now = Date.now();
      for (const [, entry] of speakingUsers) {
        if (entry.speaking && now - entry.ts > 3000) entry.speaking = false;
      }
    }, 1000);

    currentConnection = connection;
    currentChannelId = channel.id;
    connecting = false;
    return connection;
  } catch(e) {
    console.log('[VoiceTracker] Failed: ' + e.message);
    connecting = false;
    return null;
  }
}

function isSpeaking(userId) {
  const entry = speakingUsers.get(userId);
  return entry ? entry.speaking : false;
}

function scheduleDisconnect() {
  clearDisconnectTimer();
  disconnectTimer = setTimeout(() => {
    if (currentConnection) {
      console.log('[VoiceTracker] Auto-disconnect (5min idle)');
      try { currentConnection.destroy(); } catch(e) {}
      currentConnection = null;
      currentChannelId = null;
      speakingUsers.clear();
    }
  }, 5 * 60 * 1000);
}

function clearDisconnectTimer() {
  if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
}

module.exports = { ensureConnected, isSpeaking, scheduleDisconnect };
