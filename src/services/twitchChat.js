const tmi = require('tmi.js');
const config = require('../config');
const db = require('../db');
const bus = require('./overlayBus');
const { isExempt, runFilters, getAction, executeAction, grantPermit, activateRaidProtection, checkBannedWords } = require('./chatModeration');

let client = null;
const channelMap = new Map(); // channelName -> streamerId
const cooldowns = new Map(); // "streamerId:command" -> timestamp

const chatTypeMap = { subscription: 'sub', follow: 'follow', giftsub: 'giftsub', bits: 'bits', donation: 'donation', raid: 'raid' };

function getStreamerIdForChannel(channel) {
  const clean = channel.replace(/^#/, '').toLowerCase();
  return channelMap.get(clean);
}

async function handleMessage(channel, tags, message, self) {
  if (self) return;

  const streamerId = getStreamerIdForChannel(channel);
  if (!streamerId) return;

  const streamer = db.getStreamerById(streamerId);
  if (!streamer) return;

  // Banned words always enforced (except mods/broadcaster)
  if (!(tags.mod || tags.badges?.broadcaster) && streamer.mod_banned_words_enabled) {
    const bwViolation = checkBannedWords(message, streamer.id);
    if (bwViolation) {
      const action = getAction(channel, tags.username, streamer);
      await executeAction(client, channel, tags, action, bwViolation.reason, streamer);
      return;
    }
  }

  // Run remaining moderation filters for non-exempt users
  if (!isExempt(tags, streamer)) {
    const violation = await runFilters(channel, tags, message, streamer);
    if (violation) {
      if (violation.flagOnly) {
        client.say(channel, `[Mod] ${violation.reason}`).catch(() => {});
      } else {
        const action = getAction(channel, tags.username, streamer);
        await executeAction(client, channel, tags, action, violation.reason, streamer);
        return;
      }
    }
  }

  // Mod-only commands
  if (message.startsWith('!') && (tags.mod || tags.badges?.broadcaster)) {
    const parts = message.split(' ');
    const modCmd = parts[0].substring(1).toLowerCase();

    if (modCmd === 'permit' && parts[1]) {
      const targetUser = parts[1].replace(/^@/, '').toLowerCase();
      const duration = streamer.mod_permit_duration || 60;
      grantPermit(channel, targetUser, duration);
      client.say(channel, `@${targetUser} has been permitted to post a link for ${duration} seconds.`).catch(() => {});
      return;
    }

    if (modCmd === 'slow') {
      const seconds = parseInt(parts[1], 10) || 30;
      client.slow(channel, seconds).catch(() => {});
      client.say(channel, `Slow mode enabled (${seconds}s).`).catch(() => {});
      return;
    }

    if (modCmd === 'slowoff') {
      client.slowoff(channel).catch(() => {});
      client.say(channel, `Slow mode disabled.`).catch(() => {});
      return;
    }
  }

  if (!message.startsWith('!')) return;

  const commandName = message.split(' ')[0].substring(1).toLowerCase();

  console.log(`[Chat] Command received: !${commandName} from ${tags.username} in ${channel}`);

  // Built-in !song command
  if (commandName === 'song') {
    const songCooldownKey = `${streamerId}:song`;
    const now = Date.now();
    const lastUsed = cooldowns.get(songCooldownKey) || 0;
    if (now - lastUsed < 5000) return;
    cooldowns.set(songCooldownKey, now);

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
    return;
  }

  // Custom overlay commands — DISABLED for now
  // const overlayCmd = db.getCustomOverlayByCommand(streamerId, commandName);
  // if (overlayCmd) { ... }

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

    if (eventType === 'raid' && client) {
      activateRaidProtection(client, streamer.twitch_username, streamer);
    }
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
