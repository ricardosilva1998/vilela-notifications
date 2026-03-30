'use strict';

const db = require('../db');
const config = require('../config');

// ─── In-memory state ──────────────────────────────────────────────────────────
const permits = new Map();
const lastMessages = new Map();
const offenseCounts = new Map();
const followCache = new Map();
const raidProtectionTimers = new Map();

// ─── URL detection regex ──────────────────────────────────────────────────────
const URL_REGEX = /(?:https?:\/\/|www\.)\S+|[\w-]+\.(?:com|net|org|io|gg|tv|co|me|info|xyz|live)\b/i;

// ─── Check if user is exempt from moderation ─────────────────────────────────
function isExempt(tags, streamer) {
  if (tags.mod || tags.badges?.broadcaster) return true;
  if (streamer.mod_exempt_vips && tags.badges?.vip) return true;
  if (streamer.mod_exempt_subs && tags.subscriber) return true;
  return false;
}

// ─── Filter functions ─────────────────────────────────────────────────────────

function checkBannedWords(message, streamerId) {
  const words = db.getBannedWords(streamerId);
  if (!words.length) return null;
  const lower = message.toLowerCase();
  for (const w of words) {
    if (w.is_regex) {
      try {
        if (new RegExp(w.word, 'i').test(message)) {
          return { violated: true, reason: `Banned pattern: ${w.word}` };
        }
      } catch (e) { /* invalid regex, skip */ }
    } else {
      if (lower.includes(w.word.toLowerCase())) {
        return { violated: true, reason: `Banned word: ${w.word}` };
      }
    }
  }
  return null;
}

function checkLinks(message, channel, username, streamer) {
  if (!URL_REGEX.test(message)) return null;
  const key = `${channel}:${username.toLowerCase()}`;
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

function checkEmoteSpam(message, tags, streamer) {
  let count = 0;
  if (tags.emotes) {
    for (const emoteId in tags.emotes) {
      count += tags.emotes[emoteId].length;
    }
  }
  if (count > streamer.mod_emote_max_count) {
    return { violated: true, reason: `Emote spam (${count} emotes)` };
  }
  return null;
}

function checkRepetition(message, channel, username, streamer) {
  const key = `${channel}:${username.toLowerCase()}`;
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

async function checkFollowAge(channel, username, streamer) {
  const key = `${channel}:${username.toLowerCase()}`;
  const now = Date.now();
  const cached = followCache.get(key);
  if (cached && now - cached.cachedAt < 5 * 60 * 1000) {
    if (!cached.following) {
      return { violated: true, reason: 'Not following the channel' };
    }
    const ageMinutes = (now - new Date(cached.followedAt).getTime()) / 60000;
    if (ageMinutes < streamer.mod_follow_age_minutes) {
      return { violated: true, reason: `Follow age too short (${Math.round(ageMinutes)}min < ${streamer.mod_follow_age_minutes}min)` };
    }
    return null;
  }
  try {
    const { getFollowAge } = require('./twitch');
    const result = await getFollowAge(channel.replace(/^#/, ''), username);
    followCache.set(key, { following: result.following, followedAt: result.followedAt, cachedAt: now });
    if (!result.following) {
      return { violated: true, reason: 'Not following the channel' };
    }
    const ageMinutes = (now - new Date(result.followedAt).getTime()) / 60000;
    if (ageMinutes < streamer.mod_follow_age_minutes) {
      return { violated: true, reason: `Follow age too short (${Math.round(ageMinutes)}min)` };
    }
  } catch (e) {
    return null;
  }
  return null;
}

function checkFirstTimeChatter(tags) {
  if (tags['first-msg']) {
    return { flagOnly: true, reason: `First-time chatter: ${tags['display-name'] || tags.username}` };
  }
  return null;
}

// ─── Run all filters ──────────────────────────────────────────────────────────
async function runFilters(channel, tags, message, streamer) {
  const streamerId = streamer.id;
  const username = tags.username;

  if (streamer.mod_banned_words_enabled) {
    const r = checkBannedWords(message, streamerId);
    if (r) return r;
  }
  if (streamer.mod_link_protection_enabled) {
    const r = checkLinks(message, channel, username, streamer);
    if (r) return r;
  }
  if (streamer.mod_caps_enabled) {
    const r = checkCaps(message, streamer);
    if (r) return r;
  }
  if (streamer.mod_emote_spam_enabled) {
    const r = checkEmoteSpam(message, tags, streamer);
    if (r) return r;
  }
  if (streamer.mod_repetition_enabled) {
    const r = checkRepetition(message, channel, username, streamer);
    if (r) return r;
  }
  if (streamer.mod_symbol_spam_enabled) {
    const r = checkSymbolSpam(message, streamer);
    if (r) return r;
  }
  if (streamer.mod_follow_age_enabled) {
    const r = await checkFollowAge(channel, username, streamer);
    if (r) return r;
  }
  if (streamer.mod_first_chatter_enabled) {
    const r = checkFirstTimeChatter(tags);
    if (r) return r;
  }
  return null;
}

// ─── Determine action based on escalation ─────────────────────────────────────
function getAction(channel, username, streamer) {
  if (!streamer.mod_escalation_enabled) {
    return streamer.mod_action_response || 'delete';
  }
  const key = `${channel}:${username.toLowerCase()}`;
  const now = Date.now();
  const record = offenseCounts.get(key) || { count: 0, lastOffense: 0 };
  if (now - record.lastOffense > 24 * 60 * 60 * 1000) {
    record.count = 0;
  }
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

// ─── Helix API helpers for moderation ─────────────────────────────────────────
let botUserId = null;

async function getBotUserId() {
  if (botUserId) return botUserId;
  const token = config.bot.twitchToken.replace(/^oauth:/, '');
  try {
    const res = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Client-ID': config.twitch.clientId, 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.data && data.data[0]) {
      botUserId = data.data[0].id;
      console.log(`[Mod] Bot user ID resolved: ${botUserId}`);
    }
  } catch (e) {
    console.error('[Mod] Failed to get bot user ID:', e.message);
  }
  return botUserId;
}

async function helixDeleteMessage(broadcasterId, messageId) {
  const modId = await getBotUserId();
  if (!modId) return;
  const token = config.bot.twitchToken.replace(/^oauth:/, '');
  const url = `https://api.twitch.tv/helix/moderation/chat?broadcaster_id=${broadcasterId}&moderator_id=${modId}&message_id=${messageId}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Client-ID': config.twitch.clientId, 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[Mod] Helix delete failed (${res.status}):`, body);
  }
}

async function helixBanUser(broadcasterId, userId, duration, reason) {
  const modId = await getBotUserId();
  if (!modId) return;
  const token = config.bot.twitchToken.replace(/^oauth:/, '');
  const body = { data: { user_id: userId, reason: reason || '' } };
  if (duration) body.data.duration = duration;
  const res = await fetch(`https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${modId}`, {
    method: 'POST',
    headers: { 'Client-ID': config.twitch.clientId, 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[Mod] Helix ban/timeout failed (${res.status}):`, text);
  }
}

// ─── Execute moderation action ────────────────────────────────────────────────
async function executeAction(client, channel, tags, action, reason, streamer) {
  const username = tags.username;
  const broadcasterId = streamer.twitch_user_id;
  const userId = tags['user-id'];

  try {
    switch (action) {
      case 'warn':
        if (broadcasterId && tags.id) await helixDeleteMessage(broadcasterId, tags.id).catch(e => console.error('[Mod]', e.message));
        await client.say(channel, `@${username}, warning: ${reason}`).catch(() => {});
        break;
      case 'delete':
        if (broadcasterId && tags.id) await helixDeleteMessage(broadcasterId, tags.id).catch(e => console.error('[Mod]', e.message));
        break;
      case 'timeout_10':
        if (broadcasterId && userId) await helixBanUser(broadcasterId, userId, 10, reason).catch(e => console.error('[Mod]', e.message));
        break;
      case 'timeout_60':
        if (broadcasterId && userId) await helixBanUser(broadcasterId, userId, 60, reason).catch(e => console.error('[Mod]', e.message));
        break;
      case 'timeout_600':
        if (broadcasterId && userId) await helixBanUser(broadcasterId, userId, 600, reason).catch(e => console.error('[Mod]', e.message));
        break;
      case 'timeout_1800':
        if (broadcasterId && userId) await helixBanUser(broadcasterId, userId, 1800, reason).catch(e => console.error('[Mod]', e.message));
        break;
    }
    console.log(`[Mod] Executed ${action} on ${username} in ${channel} for: ${reason}`);
  } catch (e) {
    console.error(`[Mod] Failed to execute ${action} on ${username}:`, e.message);
  }

  if (streamer.mod_log_discord_enabled && streamer.mod_log_discord_channel_id) {
    logToDiscord(streamer, username, reason, action);
  }
}

// ─── Discord mod log ──────────────────────────────────────────────────────────
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
        title: 'Moderation Action',
        color: 0xff4444,
        fields: [
          { name: 'User', value: username, inline: true },
          { name: 'Action', value: actionLabels[action] || action, inline: true },
          { name: 'Reason', value: reason, inline: false },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: `Channel: ${streamer.twitch_username}` },
      }],
    }).catch(() => {});
  } catch (e) {}
}

// ─── Permit system ────────────────────────────────────────────────────────────
function grantPermit(channel, username, durationSeconds) {
  const key = `${channel}:${username.toLowerCase()}`;
  permits.set(key, Date.now() + durationSeconds * 1000);
}

// ─── Raid protection ──────────────────────────────────────────────────────────
function activateRaidProtection(client, channel, streamer) {
  if (!streamer.mod_raid_protection_enabled) return;
  const duration = streamer.mod_raid_protection_duration || 120;
  const clean = channel.replace(/^#/, '').toLowerCase();

  const existing = raidProtectionTimers.get(clean);
  if (existing) clearTimeout(existing);

  client.followers(channel, 10).catch(() => {});
  client.say(channel, `Raid protection activated for ${duration} seconds. Followers-only mode enabled.`).catch(() => {});

  const timer = setTimeout(() => {
    client.followersoff(channel).catch(() => {});
    client.say(channel, `Raid protection ended. Followers-only mode disabled.`).catch(() => {});
    raidProtectionTimers.delete(clean);
  }, duration * 1000);
  raidProtectionTimers.set(clean, timer);
}

module.exports = {
  isExempt,
  checkBannedWords,
  runFilters,
  getAction,
  executeAction,
  grantPermit,
  activateRaidProtection,
};
