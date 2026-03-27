const db = require('../db');
const bus = require('./overlayBus');

const activeTimers = new Map(); // notificationId -> intervalHandle

function fireNotification(notification) {
  const streamer = db.getStreamerById(notification.streamer_id);
  if (!streamer) return;

  // Send to Twitch chat
  if (notification.send_to_twitch && streamer.twitch_username) {
    try {
      const { chatManager } = require('./twitchChat');
      chatManager.sendRawMessage(streamer.twitch_username, notification.message);
    } catch (e) {
      console.error('[Timed] Failed to send Twitch message:', e.message);
    }
  }

  // Send to YouTube chat (only if live/polling)
  if (notification.send_to_youtube) {
    try {
      const { youtubeChatManager } = require('./youtubeLiveChat');
      if (youtubeChatManager.isPolling(notification.streamer_id)) {
        const { refreshYoutubeBotToken, sendYoutubeChatMessage } = require('./youtube');
        const liveChatId = youtubeChatManager.getLiveChatId(notification.streamer_id);
        if (liveChatId) {
          refreshYoutubeBotToken().then(token => {
            if (token) sendYoutubeChatMessage(liveChatId, notification.message, token);
          }).catch(() => {});
        }
      }
    } catch (e) {}
  }

  // Show overlay
  if (notification.show_overlay) {
    bus.emit(`overlay:${notification.streamer_id}`, {
      type: 'timed',
      data: {
        message: notification.overlay_text || notification.message,
        name: notification.name,
        position: notification.overlay_position || 'bot-center',
        duration: notification.overlay_duration || 8,
        bgColor: notification.overlay_bg_color || '#1a1a2e',
        textColor: notification.overlay_text_color || '#ffffff',
      },
    });
  }

  console.log(`[Timed] Fired "${notification.name}" for streamer ${notification.streamer_id}`);
}

const timedNotificationManager = {
  startAll() {
    const notifications = db.getEnabledTimedNotifications();
    for (const n of notifications) {
      this.startOne(n);
    }
    console.log(`[Timed] Started ${notifications.length} timed notifications`);
  },

  startOne(notification) {
    this.stopOne(notification.id);
    const intervalMs = (notification.interval_minutes || 15) * 60 * 1000;
    const handle = setInterval(() => fireNotification(notification), intervalMs);
    activeTimers.set(notification.id, handle);
  },

  stopOne(notificationId) {
    const handle = activeTimers.get(notificationId);
    if (handle) {
      clearInterval(handle);
      activeTimers.delete(notificationId);
    }
  },

  restartForStreamer(streamerId) {
    // Stop all for this streamer
    const all = db.getTimedNotifications(streamerId);
    for (const n of all) this.stopOne(n.id);
    // Start enabled ones
    const enabled = all.filter(n => n.enabled);
    for (const n of enabled) this.startOne(n);
  },

  stopAll() {
    for (const [id, handle] of activeTimers) {
      clearInterval(handle);
    }
    activeTimers.clear();
  },
};

module.exports = { timedNotificationManager };
