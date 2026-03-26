const tmi = require('tmi.js');
const db = require('../db');
const { refreshBotToken } = require('./twitch');

class TwitchChatClient {
  constructor(streamerId) {
    this.streamerId = streamerId;
    this.client = null;
    this.running = false;
    this.cooldowns = new Map(); // command -> last used timestamp
  }

  async connect() {
    let streamer = db.getStreamerById(this.streamerId);
    if (!streamer || !streamer.bot_access_token || !streamer.twitch_username) {
      console.log(`[Chat] Streamer ${this.streamerId}: bot not configured, skipping`);
      return;
    }

    // Refresh token if expired
    let token = streamer.bot_access_token;
    if (streamer.bot_token_expires_at && Date.now() >= streamer.bot_token_expires_at) {
      try {
        token = await refreshBotToken(streamer);
        streamer = db.getStreamerById(this.streamerId);
      } catch (err) {
        console.error(`[Chat] Bot token refresh failed for streamer ${this.streamerId}:`, err.message);
        return;
      }
    }

    this.running = true;
    const channel = streamer.twitch_username;

    console.log(`[Chat] Connecting bot to #${channel}...`);

    this.client = new tmi.Client({
      options: { debug: false },
      connection: { reconnect: true, secure: true },
      identity: {
        username: streamer.bot_username,
        password: `oauth:${token}`,
      },
      channels: [channel],
    });

    this.client.on('connected', () => {
      console.log(`[Chat] Bot connected to #${channel}`);
    });

    this.client.on('disconnected', (reason) => {
      console.log(`[Chat] Bot disconnected from #${channel}: ${reason}`);
    });

    // Handle chat commands
    this.client.on('message', (ch, tags, message, self) => {
      if (self) return;
      if (!message.startsWith('!')) return;

      const commandName = message.split(' ')[0].substring(1).toLowerCase();
      console.log(`[Chat] Command received: !${commandName} from ${tags.username} in ${ch}`);
      this.handleCommand(ch, commandName, tags);
    });

    this.client.on('join', (channel, username, self) => {
      if (self) console.log(`[Chat] Bot successfully joined ${channel}`);
    });

    this.client.connect().catch((err) => {
      console.error(`[Chat] Failed to connect bot to #${channel}:`, err.message);
    });
  }

  handleCommand(channel, commandName, tags) {
    const cmd = db.getChatCommand(this.streamerId, commandName);
    if (!cmd) {
      console.log(`[Chat] Command !${commandName} not found for streamer ${this.streamerId}`);
      return;
    }

    // Check cooldown
    const now = Date.now();
    const lastUsed = this.cooldowns.get(commandName) || 0;
    if (now - lastUsed < cmd.cooldown * 1000) {
      console.log(`[Chat] Command !${commandName} on cooldown`);
      return;
    }

    this.cooldowns.set(commandName, now);
    console.log(`[Chat] Sending response for !${commandName} in ${channel}: ${cmd.response}`);
    this.client.say(channel, cmd.response).catch((err) => {
      console.error(`[Chat] Failed to send !${commandName} response:`, err.message);
    });
  }

  sendMessage(message) {
    if (!this.client) return;
    const streamer = db.getStreamerById(this.streamerId);
    if (!streamer || !streamer.twitch_username) return;

    this.client.say(streamer.twitch_username, message).catch((err) => {
      console.error(`[Chat] Failed to send message for streamer ${this.streamerId}:`, err.message);
    });
  }

  sendEventMessage(eventType, data) {
    const streamer = db.getStreamerById(this.streamerId);
    if (!streamer || !streamer.chatbot_enabled) return;

    // Map event types to DB column names (subscription -> sub)
    const chatTypeMap = { subscription: 'sub', follow: 'follow', giftsub: 'giftsub', bits: 'bits', donation: 'donation', raid: 'raid' };
    const mappedType = chatTypeMap[eventType] || eventType;

    // Check if this event type is enabled
    const enabledKey = `chat_${mappedType}_enabled`;
    if (!streamer[enabledKey]) return;

    // Get template
    const templateKey = `chat_${mappedType}_template`;
    const template = streamer[templateKey];
    if (!template) return;

    // Replace variables
    let message = template;
    for (const [key, value] of Object.entries(data)) {
      message = message.replace(new RegExp(`\\{${key}\\}`, 'g'), value ?? '');
    }

    this.sendMessage(message);
  }

  disconnect() {
    this.running = false;
    if (this.client) {
      this.client.disconnect().catch(() => {});
      this.client = null;
    }
  }
}

const clients = new Map();

const chatManager = {
  startAll() {
    const streamers = db.getChatbotEnabledStreamers();
    for (const s of streamers) {
      this.startForStreamer(s.id);
    }
    console.log(`[Chat] Started ${streamers.length} bot connections`);
  },

  startForStreamer(streamerId) {
    this.stopForStreamer(streamerId);
    const client = new TwitchChatClient(streamerId);
    clients.set(streamerId, client);
    client.connect();
  },

  stopForStreamer(streamerId) {
    const client = clients.get(streamerId);
    if (client) {
      client.disconnect();
      clients.delete(streamerId);
    }
  },

  stopAll() {
    for (const [id, client] of clients) {
      client.disconnect();
    }
    clients.clear();
  },

  // Called by EventSub/StreamElements when an event occurs
  sendEventMessage(streamerId, eventType, data) {
    const client = clients.get(streamerId);
    if (client) {
      client.sendEventMessage(eventType, data);
    }
  },
};

module.exports = { chatManager };
