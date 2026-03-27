const db = require('../db');
const bus = require('./overlayBus');

const activeRotations = new Map(); // streamerId -> { handle, currentIndex }
const activeChatRotations = new Map(); // streamerId -> { handle, currentIndex }

// ── Image Rotation (per-image duration via setTimeout chaining) ──

function stopRotation(streamerId) {
  const existing = activeRotations.get(streamerId);
  if (existing) {
    clearTimeout(existing.handle);
    activeRotations.delete(streamerId);
  }
}

function scheduleNextImage(streamerId) {
  const imgs = db.getEnabledSponsorImages(streamerId);
  if (imgs.length === 0) {
    activeRotations.delete(streamerId);
    return;
  }

  const state = activeRotations.get(streamerId);
  if (!state) return;

  const idx = state.currentIndex % imgs.length;
  const img = imgs[idx];

  bus.emit(`overlay:${streamerId}`, {
    type: 'sponsor',
    data: {
      imageUrl: `/sponsors/${streamerId}/${img.filename}`,
      name: img.display_name,
      displayDuration: img.display_duration || 30,
    },
  });

  const durationMs = (img.display_duration || 30) * 1000;
  state.handle = setTimeout(() => {
    state.currentIndex = idx + 1;
    scheduleNextImage(streamerId);
  }, durationMs);

  console.log(`[Sponsor] Showing "${img.display_name}" for ${img.display_duration || 30}s (streamer ${streamerId})`);
}

function startRotation(streamerId) {
  stopRotation(streamerId);
  const streamer = db.getStreamerById(streamerId);
  if (!streamer || !streamer.sponsor_rotation_enabled) return;

  const images = db.getEnabledSponsorImages(streamerId);
  if (images.length === 0) return;

  activeRotations.set(streamerId, { handle: null, currentIndex: 0 });
  scheduleNextImage(streamerId);
  console.log(`[Sponsor] Started image rotation for streamer ${streamerId} (${images.length} images)`);
}

// ── Chat Message Rotation (independent interval) ──

function stopChatRotation(streamerId) {
  const existing = activeChatRotations.get(streamerId);
  if (existing) {
    clearInterval(existing.handle);
    activeChatRotations.delete(streamerId);
  }
}

function startChatRotation(streamerId) {
  stopChatRotation(streamerId);
  const streamer = db.getStreamerById(streamerId);
  if (!streamer || !streamer.sponsor_send_chat) return;

  const messages = db.getEnabledSponsorMessages(streamerId);
  if (messages.length === 0) return;

  const intervalMs = (streamer.sponsor_chat_interval_minutes || 10) * 60 * 1000;
  let currentIndex = 0;

  const handle = setInterval(() => {
    const msgs = db.getEnabledSponsorMessages(streamerId);
    if (msgs.length === 0) return;
    currentIndex = currentIndex % msgs.length;
    const msg = msgs[currentIndex];

    const fullMessage = msg.url ? `${msg.message_text} ${msg.url}` : msg.message_text;

    try {
      const { chatManager } = require('./twitchChat');
      if (streamer.twitch_username) {
        chatManager.sendRawMessage(streamer.twitch_username, fullMessage);
      }
    } catch (e) {
      console.error('[Sponsor Chat] Failed to send chat message:', e.message);
    }

    currentIndex++;
    console.log(`[Sponsor Chat] Sent message "${msg.message_text.substring(0, 40)}..." for streamer ${streamerId}`);
  }, intervalMs);

  activeChatRotations.set(streamerId, { handle, currentIndex: 0 });
  console.log(`[Sponsor Chat] Started chat rotation for streamer ${streamerId} (${messages.length} messages, every ${streamer.sponsor_chat_interval_minutes || 10}min)`);
}

// ── Manager ──

const timedNotificationManager = {
  startAll() {
    const streamers = db.getOverlayEnabledStreamers();
    let imgCount = 0;
    let chatCount = 0;
    for (const s of streamers) {
      if (s.sponsor_rotation_enabled) {
        startRotation(s.id);
        imgCount++;
      }
      if (s.sponsor_send_chat) {
        startChatRotation(s.id);
        chatCount++;
      }
    }
    console.log(`[Sponsor] Started ${imgCount} image rotations, ${chatCount} chat rotations`);
  },

  restartForStreamer(streamerId) {
    stopRotation(streamerId);
    startRotation(streamerId);
  },

  restartChatForStreamer(streamerId) {
    stopChatRotation(streamerId);
    startChatRotation(streamerId);
  },

  stopAll() {
    for (const [, rotation] of activeRotations) {
      clearTimeout(rotation.handle);
    }
    activeRotations.clear();
    for (const [, rotation] of activeChatRotations) {
      clearInterval(rotation.handle);
    }
    activeChatRotations.clear();
  },
};

module.exports = { timedNotificationManager };
