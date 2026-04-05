'use strict';

const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');

const speakingUsers = new Map();
let currentConnection = null;
let currentChannelId = null;
let disconnectTimer = null;

async function ensureConnected(channel) {
  console.log('[VoiceTracker] ensureConnected called, channel=' + channel.name + ' current=' + currentChannelId);
  if (currentConnection && currentChannelId === channel.id) {
    clearDisconnectTimer();
    return currentConnection;
  }

  if (currentConnection) {
    try { currentConnection.destroy(); } catch(e) {}
    currentConnection = null;
    currentChannelId = null;
    speakingUsers.clear();
  }

  try {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 15000);
    console.log('[VoiceTracker] Connected to: ' + channel.name);

    // Speaking events via receiver
    const receiver = connection.receiver;

    // Method 1: speaking map events (newer versions)
    if (receiver.speaking) {
      console.log('[VoiceTracker] Using receiver.speaking events');
      receiver.speaking.on('start', (userId) => {
        console.log('[VoiceTracker] Speaking START: ' + userId);
        speakingUsers.set(userId, { speaking: true, ts: Date.now() });
      });
      receiver.speaking.on('end', (userId) => {
        console.log('[VoiceTracker] Speaking END: ' + userId);
        const entry = speakingUsers.get(userId);
        if (entry) entry.speaking = false;
      });
    }

    // Method 2: direct 'speaking' event on receiver (some versions)
    receiver.on('speaking', (userId, speaking) => {
      console.log('[VoiceTracker] Speaking event: ' + userId + ' = ' + speaking);
      if (speaking) {
        speakingUsers.set(userId, { speaking: true, ts: Date.now() });
      } else {
        const entry = speakingUsers.get(userId);
        if (entry) entry.speaking = false;
      }
    });

    // Auto-timeout speaking after 3 seconds of no event (safety)
    setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of speakingUsers) {
        if (entry.speaking && now - entry.ts > 3000) {
          entry.speaking = false;
        }
      }
    }, 1000);

    // Subscribe to all members' audio to enable speaking detection
    // Some versions require this for speaking events to fire
    try {
      for (const [, member] of channel.members) {
        if (!member.user.bot) {
          receiver.subscribe(member.id, { end: { behavior: 0 } });
          console.log('[VoiceTracker] Subscribed to: ' + member.user.username);
        }
      }
    } catch(e) {
      console.log('[VoiceTracker] Subscribe error (ok): ' + e.message);
    }

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      console.log('[VoiceTracker] Disconnected');
      currentConnection = null;
      currentChannelId = null;
      speakingUsers.clear();
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      currentConnection = null;
      currentChannelId = null;
      speakingUsers.clear();
    });

    currentConnection = connection;
    currentChannelId = channel.id;
    return connection;
  } catch(e) {
    console.log('[VoiceTracker] Failed: ' + e.message);
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
