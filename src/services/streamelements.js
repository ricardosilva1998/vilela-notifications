const io = require('socket.io-client');
const db = require('../db');
const bus = require('./overlayBus');
const { chatManager } = require('./twitchChat');

class StreamElementsClient {
  constructor(streamerId) {
    this.streamerId = streamerId;
    this.socket = null;
    this.running = false;
  }

  connect() {
    const streamer = db.getStreamerById(this.streamerId);
    if (!streamer || !streamer.streamelements_jwt) {
      console.log(`[StreamElements] Streamer ${this.streamerId}: no JWT token, skipping`);
      return;
    }

    this.running = true;
    console.log(`[StreamElements] Connecting for streamer ${streamer.twitch_display_name || this.streamerId}...`);

    this.socket = io('https://realtime.streamelements.com', {
      transports: ['websocket'],
    });

    this.socket.on('connect', () => {
      console.log(`[StreamElements] Connected for streamer ${this.streamerId}, authenticating...`);
      this.socket.emit('authenticate', { method: 'jwt', token: streamer.streamelements_jwt });
    });

    this.socket.on('authenticated', () => {
      console.log(`[StreamElements] Authenticated for streamer ${this.streamerId}`);
    });

    this.socket.on('unauthorized', () => {
      console.error(`[StreamElements] Auth failed for streamer ${this.streamerId} — check JWT token`);
    });

    const handleTip = (event) => {
      if (event.type === 'tip') {
        const s = db.getStreamerById(this.streamerId);
        if (s && s.overlay_donation_enabled) {
          bus.emit(`overlay:${this.streamerId}`, {
            type: 'donation',
            data: {
              username: event.data.username,
              amount: event.data.amount,
              message: event.data.message || null,
              currency: event.data.currency || 'USD',
            },
          });
          try { db.logOverlayEvent(this.streamerId, 'donation', event.data.username, { amount: event.data.amount, currency: event.data.currency }); } catch (e) {}
          chatManager.sendEventMessage(this.streamerId, 'donation', {
            username: event.data.username,
            amount: event.data.amount,
            currency: event.data.currency || 'USD',
            message: event.data.message || '',
          });
        }
      }
    };

    this.socket.on('event', handleTip);
    this.socket.on('event:test', handleTip);

    this.socket.on('disconnect', () => {
      console.log(`[StreamElements] Disconnected for streamer ${this.streamerId}`);
    });
  }

  disconnect() {
    this.running = false;
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }
}

const clients = new Map();

const streamElementsManager = {
  startAll() {
    const streamers = db.getOverlayEnabledStreamers();
    let count = 0;
    for (const s of streamers) {
      if (s.streamelements_jwt) {
        this.startForStreamer(s.id);
        count++;
      }
    }
    console.log(`[StreamElements] Started ${count} connections`);
  },

  startForStreamer(streamerId) {
    this.stopForStreamer(streamerId);
    const client = new StreamElementsClient(streamerId);
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

module.exports = { streamElementsManager };
