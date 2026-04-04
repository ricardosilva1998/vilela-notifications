'use strict';

const db = require('../db');
const { checkBannedWords } = require('./chatModeration');
const { deleteYoutubeChatMessage, banYoutubeChatUser } = require('./youtube');

// ─── In-memory state (keyed by "yt:streamerId:channelId") ────────────────────
const permits = new Map();
const lastMessages = new Map();
const offenseCounts = new Map();
const authorCache = new Map(); // "yt:streamerId:displayNameLower" -> channelId

const URL_REGEX = /(?:https?:\/\/|www\.)\S+|[\w-]+\.(?:com|net|org|io|gg|tv|co|me|info|xyz|live)\b/i;

// ─── Exempt check for YouTube ────────────────────────────────────────────────
function isExempt(authorDetails, streamer) {
  if (authorDetails.isChatOwner || authorDetails.isChatModerator) return true;
  if (streamer.mod_exempt_subs && authorDetails.isChatSponsor) return true;
  return false;
}

// ─── YouTube-adapted filter functions ────────────────────────────────────────

function checkLinks(message, key, streamer) {
  if (!URL_REGEX.test(message)) return null;
  const permitExpiry = permits.get(key);
  if (permitExpiry && Date.now() < permitExpiry) {
    permits.delete(key);
    return null;
  }
  return { violated: true, reason: 'Link posted without permission' };
}

function checkCaps(message, streamer) {
  if (message.length < streamer.mod_caps_min_length) return null;
  const alpha = message.replace(/[^a-zA-Z]/g, '');
  if (alpha.length === 0) return null;
  const upper = alpha.replace(/[^A-Z]/g, '').length;
  const percent = Math.round((upper / alpha.length) * 100);
  if (percent > streamer.mod_caps_max_percent) {
    return { violated: true, reason: `Excessive caps (${percent}%)` };
  }
  return null;
}

function checkRepetition(message, key, streamer) {
  const now = Date.now();
  const last = lastMessages.get(key);
  lastMessages.set(key, { text: message.toLowerCase().trim(), timestamp: now });
  if (!last) return null;
  const windowMs = (streamer.mod_repetition_window || 30) * 1000;
  if (now - last.timestamp < windowMs && message.toLowerCase().trim() === last.text) {
    return { violated: true, reason: 'Repeated message' };
  }
  return null;
}

function checkSymbolSpam(message, streamer) {
  if (message.length < 5) return null;
  const nonAlphaSpace = message.replace(/[\w\s]/g, '').length;
  const percent = Math.round((nonAlphaSpace / message.length) * 100);
  if (percent > streamer.mod_symbol_max_percent) {
    return { violated: true, reason: `Symbol spam (${percent}%)` };
  }
  return null;
}

// ─── Run YouTube filters ─────────────────────────────────────────────────────
function runFilters(message, key, streamerId, streamer) {
  if (streamer.mod_banned_words_enabled) {
    const r = checkBannedWords(message, streamerId);
    if (r) return r;
  }
  if (streamer.mod_link_protection_enabled) {
    const r = checkLinks(message, key, streamer);
    if (r) return r;
  }
  if (streamer.mod_caps_enabled) {
    const r = checkCaps(message, streamer);
    if (r) return r;
  }
  if (streamer.mod_repetition_enabled) {
    const r = checkRepetition(message, key, streamer);
    if (r) return r;
  }
  if (streamer.mod_symbol_spam_enabled) {
    const r = checkSymbolSpam(message, streamer);
    if (r) return r;
  }
  return null;
}

// ─── Escalation ──────────────────────────────────────────────────────────────
function getAction(key, streamer) {
  if (!streamer.mod_escalation_enabled) {
    return streamer.mod_action_response || 'delete';
  }
  const now = Date.now();
  const record = offenseCounts.get(key) || { count: 0, lastOffense: 0 };
  if (now - record.lastOffense > 24 * 60 * 60 * 1000) record.count = 0;
  record.count++;
  record.lastOffense = now;
  offenseCounts.set(key, record);

  switch (record.count) {
    case 1: return 'warn';
    case 2: return 'timeout_10';
    case 3: return 'timeout_600';
    default: return 'timeout_1800';
  }
}

// ─── Action durations ────────────────────────────────────────────────────────
const TIMEOUT_DURATIONS = {
  timeout_10: 10,
  timeout_60: 60,
  timeout_600: 600,
  timeout_1800: 1800,
};

// ─── Execute moderation action ───────────────────────────────────────────────
async function executeAction(messageId, liveChatId, channelId, displayName, action, reason, streamer, botToken) {
  try {
    // Delete message for warn/delete actions
    if (action === 'warn' || action === 'delete') {
      await deleteYoutubeChatMessage(messageId, botToken);
    }

    // Timeout via temporary ban
    const duration = TIMEOUT_DURATIONS[action];
    if (duration) {
      await banYoutubeChatUser(liveChatId, channelId, duration, botToken);
    }

    console.log(`[YT Mod] Executed ${action} on ${displayName} (${channelId}) for: ${reason}`);

    // Save to DB log
    try {
      db.addModLogEntry(streamer.id, displayName, channelId, action, reason, null, 'youtube');
    } catch (e) {
      console.error('[YT Mod] Failed to save mod log:', e.message);
    }

    // Discord mod log
    if (streamer.mod_log_discord_enabled && streamer.mod_log_discord_channel_id) {
      logToDiscord(streamer, displayName, reason, action);
    }
  } catch (e) {
    console.error(`[YT Mod] Failed to execute ${action} on ${displayName}:`, e.message);
  }
}

// ─── Discord mod log ─────────────────────────────────────────────────────────
function logToDiscord(streamer, username, reason, action) {
  try {
    const { client: discordClient } = require('../discord');
    const ch = discordClient.channels.cache.get(streamer.mod_log_discord_channel_id);
    if (!ch) return;
    const actionLabels = {
      warn: 'Warning (message deleted)',
      delete: 'Message deleted',
      timeout_10: 'Timeout 10s',
      timeout_60: 'Timeout 60s',
      timeout_600: 'Timeout 10min',
      timeout_1800: 'Timeout 30min',
    };
    ch.send({
      embeds: [{
        title: 'YouTube Moderation Action',
        color: 0xff0000,
        fields: [
          { name: 'User', value: username, inline: true },
          { name: 'Action', value: actionLabels[action] || action, inline: true },
          { name: 'Reason', value: reason, inline: false },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: `Platform: YouTube` },
      }],
    }).catch(() => {});
  } catch (e) {}
}

// ─── Main moderation entry point ─────────────────────────────────────────────
async function moderateYoutubeMessage(streamerId, item, liveChatId, botToken) {
  const message = item.snippet?.textMessageDetails?.messageText || '';
  const authorDetails = item.authorDetails || {};
  const displayName = authorDetails.displayName || 'Unknown';
  const channelId = authorDetails.channelId;
  const messageId = item.id;

  if (!message || !channelId) return { moderated: false };

  const streamer = db.getStreamerById(streamerId);
  if (!streamer?.yt_mod_enabled) return { moderated: false };

  // Cache author for !permit lookups
  const cacheKey = `yt:${streamerId}:${displayName.toLowerCase()}`;
  authorCache.set(cacheKey, channelId);

  // Check exemptions (banned words always enforced, even for exempt users)
  const exempt = isExempt(authorDetails, streamer);

  // Banned words are always checked, even for exempt users
  if (streamer.mod_banned_words_enabled) {
    const r = checkBannedWords(message, streamerId);
    if (r) {
      const key = `yt:${streamerId}:${channelId}`;
      const action = getAction(key, streamer);
      await executeAction(messageId, liveChatId, channelId, displayName, action, r.reason, streamer, botToken);
      return { moderated: true };
    }
  }

  // Other filters only apply to non-exempt users
  if (exempt) return { moderated: false };

  const key = `yt:${streamerId}:${channelId}`;
  const filterResult = runFilters(message, key, streamerId, streamer);
  if (filterResult && !filterResult.flagOnly) {
    const action = getAction(key, streamer);
    await executeAction(messageId, liveChatId, channelId, displayName, action, filterResult.reason, streamer, botToken);
    return { moderated: true };
  }

  return { moderated: false };
}

// ─── Permit system ───────────────────────────────────────────────────────────
function grantYoutubePermit(streamerId, displayName, durationSeconds) {
  const channelId = authorCache.get(`yt:${streamerId}:${displayName.toLowerCase()}`);
  if (!channelId) return false;
  const key = `yt:${streamerId}:${channelId}`;
  permits.set(key, Date.now() + durationSeconds * 1000);
  return true;
}

module.exports = { moderateYoutubeMessage, grantYoutubePermit };
