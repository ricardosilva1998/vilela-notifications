const WebSocket = require('ws');
const config = require('../config');
const db = require('../db');
const bus = require('./overlayBus');
const { refreshBroadcasterToken } = require('./twitch');
const { chatManager } = require('./twitchChat');

const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';

const SUBSCRIPTION_TYPES = [
  { type: 'channel.follow', version: '2', needsModerator: true },
  { type: 'channel.subscribe', version: '1' },
  { type: 'channel.subscription.gift', version: '1' },
  { type: 'channel.subscription.message', version: '1' },
  { type: 'channel.cheer', version: '1' },
  { type: 'channel.raid', version: '1', conditionKey: 'to_broadcaster_user_id' },
];

class EventSubClient {
  constructor(streamerId) {
    this.streamerId = streamerId;
    this.ws = null;
    this.keepaliveTimer = null;
    this.reconnectDelay = 1000;
    this.running = false;
  }

  async connect() {
    const streamer = db.getStreamerById(this.streamerId);
    if (!streamer || !streamer.broadcaster_access_token || !streamer.twitch_user_id) {
      console.log(`[EventSub] Streamer ${this.streamerId}: not configured, skipping`);
      return;
    }

    this.running = true;
    console.log(`[EventSub] Connecting for streamer ${streamer.twitch_display_name || this.streamerId}...`);

    this.ws = new WebSocket(EVENTSUB_URL);

    this.ws.on('open', () => {
      console.log(`[EventSub] Connected for streamer ${this.streamerId}`);
      this.reconnectDelay = 1000;
    });

    this.ws.on('message', (data) => this.handleMessage(data));

    this.ws.on('close', (code) => {
      console.log(`[EventSub] Disconnected for streamer ${this.streamerId} (code: ${code})`);
      this.clearKeepalive();
      if (this.running && code !== 1000) {
        console.log(`[EventSub] Reconnecting in ${this.reconnectDelay / 1000}s...`);
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
      }
    });

    this.ws.on('error', (err) => {
      console.error(`[EventSub] Error for streamer ${this.streamerId}:`, err.message);
    });
  }

  async handleMessage(raw) {
    const msg = JSON.parse(raw.toString());
    const messageType = msg.metadata.message_type;

    switch (messageType) {
      case 'session_welcome': {
        const sessionId = msg.payload.session.id;
        const timeout = msg.payload.session.keepalive_timeout_seconds;
        console.log(`[EventSub] Session ${sessionId} for streamer ${this.streamerId} (keepalive: ${timeout}s)`);
        this.resetKeepalive(timeout);

        for (const subType of SUBSCRIPTION_TYPES) {
          await this.createSubscription(sessionId, subType);
        }
        break;
      }

      case 'session_keepalive':
        this.resetKeepalive(msg.payload?.session?.keepalive_timeout_seconds || 10);
        break;

      case 'notification': {
        const subType = msg.metadata.subscription_type;
        const event = msg.payload.event;
        this.resetKeepalive(10);

        const normalized = this.normalizeEvent(subType, event);
        if (normalized) {
          const streamer = db.getStreamerById(this.streamerId);

          // Emit to overlay — giftsub shows as subscription banner
          const isGift = normalized.type === 'giftsub';
          const overlayType = isGift ? 'subscription' : normalized.type;
          const typeMap = { follow: 'follow', subscription: 'sub', giftsub: 'sub', bits: 'bits', donation: 'donation', raid: 'raid' };
          const enabledKey = `overlay_${typeMap[overlayType] || overlayType}_enabled`;
          if (streamer && streamer[enabledKey]) {
            bus.emit(`overlay:${this.streamerId}`, { ...normalized, type: overlayType, isGift });
          }
          try { db.logOverlayEvent(this.streamerId, normalized.type, normalized.data?.username, normalized.data); } catch (e) {}

          // Emit to chat service
          chatManager.sendEventMessage(this.streamerId, normalized.type, normalized.data);
        }
        break;
      }

      case 'session_reconnect': {
        const reconnectUrl = msg.payload.session.reconnect_url;
        console.log(`[EventSub] Reconnect for streamer ${this.streamerId}`);
        const oldWs = this.ws;
        this.ws = new WebSocket(reconnectUrl);
        this.ws.on('message', (data) => this.handleMessage(data));
        this.ws.on('open', () => oldWs.close());
        this.ws.on('error', (err) => {
          console.error(`[EventSub] Reconnect error for streamer ${this.streamerId}:`, err.message);
        });
        this.ws.on('close', (code) => {
          if (this.running && code !== 1000) {
            setTimeout(() => this.connect(), this.reconnectDelay);
          }
        });
        break;
      }

      case 'revocation':
        console.warn(`[EventSub] Subscription revoked for streamer ${this.streamerId}:`,
          msg.payload.subscription.type, msg.payload.subscription.status);
        break;
    }
  }

  async createSubscription(sessionId, subType) {
    let streamer = db.getStreamerById(this.streamerId);
    let token = streamer.broadcaster_access_token;

    const conditionKey = subType.conditionKey || 'broadcaster_user_id';
    const condition = { [conditionKey]: streamer.twitch_user_id };
    if (subType.needsModerator) {
      condition.moderator_user_id = streamer.twitch_user_id;
    }

    const body = {
      type: subType.type,
      version: subType.version,
      condition,
      transport: { method: 'websocket', session_id: sessionId },
    };

    let res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Client-Id': config.twitch.clientId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    // Retry with refreshed token on 401
    if (res.status === 401) {
      try {
        streamer = db.getStreamerById(this.streamerId);
        token = await refreshBroadcasterToken(streamer);
        res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Client-Id': config.twitch.clientId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        console.error(`[EventSub] Token refresh failed for streamer ${this.streamerId}:`, err.message);
        return;
      }
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error(`[EventSub] Failed to subscribe ${subType.type} for streamer ${this.streamerId}:`, err.message || res.status);
      return;
    }

    console.log(`[EventSub] Subscribed to ${subType.type} for streamer ${this.streamerId}`);
  }

  normalizeEvent(subType, event) {
    switch (subType) {
      case 'channel.follow':
        return { type: 'follow', data: { username: event.user_name } };

      case 'channel.subscribe':
        return {
          type: 'subscription',
          data: {
            username: event.user_name,
            tier: event.tier === '1000' ? '1' : event.tier === '2000' ? '2' : '3',
            months: 1,
            message: null,
          },
        };

      case 'channel.subscription.gift':
        return {
          type: 'giftsub',
          data: {
            username: event.is_anonymous ? 'Anonymous' : event.user_name,
            tier: event.tier === '1000' ? '1' : event.tier === '2000' ? '2' : '3',
            amount: event.total,
            message: `Gifted ${event.total} sub${event.total > 1 ? 's' : ''}!`,
          },
        };

      case 'channel.subscription.message':
        return {
          type: 'subscription',
          data: {
            username: event.user_name,
            tier: event.tier === '1000' ? '1' : event.tier === '2000' ? '2' : '3',
            months: event.cumulative_months,
            message: event.message ? event.message.text : null,
          },
        };

      case 'channel.cheer':
        return {
          type: 'bits',
          data: {
            username: event.is_anonymous ? 'Anonymous' : event.user_name,
            amount: event.bits,
            message: event.message || null,
          },
        };

      case 'channel.raid':
        return {
          type: 'raid',
          data: {
            username: event.from_broadcaster_user_name,
            viewers: event.viewers,
          },
        };

      default:
        return null;
    }
  }

  resetKeepalive(timeoutSeconds) {
    this.clearKeepalive();
    this.keepaliveTimer = setTimeout(() => {
      console.warn(`[EventSub] Keepalive timeout for streamer ${this.streamerId}`);
      if (this.ws) this.ws.close();
    }, (timeoutSeconds + 5) * 1000);
  }

  clearKeepalive() {
    if (this.keepaliveTimer) {
      clearTimeout(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  disconnect() {
    this.running = false;
    this.clearKeepalive();
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
  }
}

// Manager for all per-streamer connections
const clients = new Map();

const eventSubManager = {
  startAll() {
    const streamers = db.getOverlayEnabledStreamers();
    for (const s of streamers) {
      this.startForStreamer(s.id);
    }
    console.log(`[EventSub] Started ${streamers.length} connections`);
  },

  startForStreamer(streamerId) {
    this.stopForStreamer(streamerId);
    const client = new EventSubClient(streamerId);
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
};

module.exports = { eventSubManager };
