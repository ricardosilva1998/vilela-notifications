const tmi = require('tmi.js');
const config = require('../config');
const db = require('../db');
const bus = require('./overlayBus');

let client = null;
const channelMap = new Map(); // channelName -> streamerId
const cooldowns = new Map(); // "streamerId:command" -> timestamp

const chatTypeMap = { subscription: 'sub', follow: 'follow', giftsub: 'giftsub', bits: 'bits', donation: 'donation', raid: 'raid' };

function getStreamerIdForChannel(channel) {
  const clean = channel.replace(/^#/, '').toLowerCase();
  return channelMap.get(clean);
}

function handleMessage(channel, tags, message, self) {
  if (self) return;
  if (!message.startsWith('!')) return;

  const commandName = message.split(' ')[0].substring(1).toLowerCase();
  const streamerId = getStreamerIdForChannel(channel);
  if (!streamerId) return;

  console.log(`[Chat] Command received: !${commandName} from ${tags.username} in ${channel}`);

  // Built-in !song command
  if (commandName === 'song') {
    const songCooldownKey = `${streamerId}:song`;
    const now = Date.now();
    const lastUsed = cooldowns.get(songCooldownKey) || 0;
    if (now - lastUsed < 5000) return;
    cooldowns.set(songCooldownKey, now);

    const streamer = db.getStreamerById(streamerId);
    if (streamer) {
      const { getCurrentlyPlaying } = require('./spotify');
      getCurrentlyPlaying(streamer).then(result => {
        let msg;
        switch (result.status) {
          case 'playing': msg = `🎵 Now playing: ${result.track} by ${result.artist}`; break;
          case 'paused': msg = `⏸️ Paused: ${result.track} by ${result.artist}`; break;
          case 'nothing_playing': msg = `🔇 Nothing playing on Spotify right now`; break;
          case 'not_connected': msg = `Spotify not connected`; break;
          default: msg = `Could not fetch current song`;
        }
        if (client) client.say(channel, msg).catch(() => {});
      }).catch(() => {});
    }
    return;
  }

  // Custom overlay commands — streamer and mods only
  const overlayCmd = db.getCustomOverlayByCommand(streamerId, commandName);
  if (overlayCmd) {
    const isBroadcaster = tags.badges && tags.badges.broadcaster === '1';
    const isMod = tags.mod;
    if (!isBroadcaster && !isMod) return;

    const cooldownKey = `${streamerId}:overlay:${commandName}`;
    const now = Date.now();
    const lastUsed = cooldowns.get(cooldownKey) || 0;
    if (now - lastUsed < 2000) return; // 2s cooldown
    cooldowns.set(cooldownKey, now);

    if (overlayCmd.type === 'custom-alert') {
      // Fire-and-forget — just trigger the alert
      const parsed = { ...overlayCmd, config: JSON.parse(overlayCmd.config || '{}') };
      bus.emit(`custom-overlay:${streamerId}`, { type: 'custom-alert-trigger', overlay: parsed });
    } else {
      // Toggle scene/bar
      const toggled = db.toggleCustomOverlay(overlayCmd.id, streamerId);
      if (toggled) {
        const parsed = { ...toggled, config: JSON.parse(toggled.config || '{}') };

        // Parse optional countdown duration: "!starting 5" → 5 minutes
        if (toggled.type === 'scene' && toggled.is_active) {
          const args = message.split(' ');
          if (args.length > 1) {
            const minutes = parseInt(args[1]);
            if (minutes > 0) parsed.config.countdownMinutes = minutes;
          }
        }

        bus.emit(`custom-overlay:${streamerId}`, { type: `${toggled.type}-toggle`, overlay: parsed });

        // If scene was activated, deactivate other scenes
        if (toggled.type === 'scene' && toggled.is_active) {
          const allScenes = db.getCustomOverlaysByType(streamerId, 'scene');
          for (const scene of allScenes) {
            if (scene.id !== toggled.id) {
              const s = { ...scene, config: JSON.parse(scene.config || '{}'), is_active: 0 };
              bus.emit(`custom-overlay:${streamerId}`, { type: 'scene-toggle', overlay: s });
            }
          }
        }
      }
    }

    return;
  }

  const cmd = db.getChatCommand(streamerId, commandName);
  if (!cmd) return;

  const cooldownKey = `${streamerId}:${commandName}`;
  const now = Date.now();
  const lastUsed = cooldowns.get(cooldownKey) || 0;
  if (now - lastUsed < cmd.cooldown * 1000) return;

  cooldowns.set(cooldownKey, now);
  console.log(`[Chat] Sending response for !${commandName} in ${channel}`);
  client.say(channel, cmd.response).catch((err) => {
    console.error(`[Chat] Failed to send !${commandName} response:`, err.message);
  });
}

const chatManager = {
  connect() {
    const { twitchUsername, twitchToken } = config.bot;
    if (!twitchUsername || !twitchToken) {
      console.log('[Chat] Bot not configured (BOT_TWITCH_USERNAME / BOT_TWITCH_TOKEN not set)');
      return;
    }

    console.log(`[Chat] Connecting as ${twitchUsername}...`);

    client = new tmi.Client({
      options: { debug: false },
      connection: { reconnect: true, secure: true },
      identity: {
        username: twitchUsername,
        password: twitchToken.startsWith('oauth:') ? twitchToken : `oauth:${twitchToken}`,
      },
      channels: [],
    });

    client.on('connected', () => {
      console.log(`[Chat] Bot connected as ${twitchUsername}`);

      const streamers = db.getChatbotEnabledStreamers();
      let joinDelay = 0;
      for (const s of streamers) {
        if (s.twitch_username) {
          setTimeout(() => {
            this.joinChannel(s.id, s.twitch_username);
          }, joinDelay);
          joinDelay += 500;
        }
      }
      console.log(`[Chat] Queued ${streamers.length} channel joins`);
    });

    client.on('disconnected', (reason) => {
      console.log(`[Chat] Bot disconnected: ${reason}`);
    });

    client.on('notice', (channel, msgid, message) => {
      console.log(`[Chat] Notice in ${channel}: [${msgid}] ${message}`);
    });

    client.on('join', (channel, username, self) => {
      if (self) console.log(`[Chat] Joined ${channel}`);
    });

    client.on('part', (channel, username, self) => {
      if (self) console.log(`[Chat] Left ${channel}`);
    });

    client.on('message', handleMessage);

    client.connect().catch((err) => {
      console.error(`[Chat] Failed to connect:`, err.message);
    });
  },

  disconnect() {
    if (client) {
      client.disconnect().catch(() => {});
      client = null;
    }
    channelMap.clear();
    cooldowns.clear();
  },

  joinChannel(streamerId, channel) {
    if (!client) return;
    const clean = channel.toLowerCase();
    channelMap.set(clean, streamerId);
    client.join(clean).catch((err) => {
      console.error(`[Chat] Failed to join #${clean}:`, err.message);
    });
  },

  partChannel(channel) {
    if (!client) return;
    const clean = channel.toLowerCase();
    channelMap.delete(clean);
    client.part(clean).catch((err) => {
      console.error(`[Chat] Failed to leave #${clean}:`, err.message);
    });
  },

  isConnected() {
    if (!client) return false;
    const state = client.readyState();
    console.log(`[Chat] readyState check: ${state}`);
    return state === 'OPEN';
  },

  getJoinedChannels() {
    return Array.from(channelMap.keys());
  },

  sendEventMessage(streamerId, eventType, data) {
    if (!client) return;

    const streamer = db.getStreamerById(streamerId);
    if (!streamer || !streamer.chatbot_enabled || !streamer.twitch_username) return;

    const mappedType = chatTypeMap[eventType] || eventType;

    const enabledKey = `chat_${mappedType}_enabled`;
    if (!streamer[enabledKey]) return;

    const templateKey = `chat_${mappedType}_template`;
    const template = streamer[templateKey];
    if (!template) return;

    let message = template;
    for (const [key, value] of Object.entries(data)) {
      message = message.replace(new RegExp(`\\{${key}\\}`, 'g'), value ?? '');
    }

    client.say(streamer.twitch_username, message).catch((err) => {
      console.error(`[Chat] Failed to send event message for streamer ${streamerId}:`, err.message);
    });
  },

  sendRawMessage(channel, message) {
    if (!client) return;
    client.say(channel, message).catch(err => {
      console.error(`[Chat] Failed to send timed message to ${channel}:`, err.message);
    });
  },

  // Backward-compatible aliases
  startAll() { this.connect(); },
  startForStreamer(streamerId) {
    const streamer = db.getStreamerById(streamerId);
    if (streamer && streamer.twitch_username) {
      this.joinChannel(streamerId, streamer.twitch_username);
    }
  },
  stopForStreamer(streamerId) {
    const streamer = db.getStreamerById(streamerId);
    if (streamer && streamer.twitch_username) {
      this.partChannel(streamer.twitch_username);
    }
  },
  stopAll() { this.disconnect(); },
};

module.exports = { chatManager };
