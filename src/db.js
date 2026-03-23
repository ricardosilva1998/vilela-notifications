const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'bot.db');

// Ensure data directory exists
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Migrations ---

// Migration 1: drop old schema if it doesn't have discord_user_id
try {
  const cols = db.prepare("PRAGMA table_info(streamers)").all();
  if (cols.length > 0 && !cols.find((c) => c.name === 'discord_user_id')) {
    console.log('[DB] Old schema detected, dropping all tables for migration...');
    db.exec('DROP TABLE IF EXISTS sessions');
    db.exec('DROP TABLE IF EXISTS user_links');
    db.exec('DROP TABLE IF EXISTS poller_state');
    db.exec('DROP TABLE IF EXISTS guilds');
    db.exec('DROP TABLE IF EXISTS streamers');
    console.log('[DB] Old tables dropped, will recreate with new schema');
  }
} catch {}

// Migration 2: add enabled/admin_note columns if missing
try {
  const cols = db.prepare("PRAGMA table_info(streamers)").all();
  if (cols.length > 0 && !cols.find((c) => c.name === 'enabled')) {
    db.exec('ALTER TABLE streamers ADD COLUMN enabled INTEGER DEFAULT 1');
    db.exec('ALTER TABLE streamers ADD COLUMN admin_note TEXT');
    console.log('[DB] Added enabled/admin_note columns to streamers');
  }
} catch {}

// Migration 3: rename discord_channel_id to live_channel_id + add clips_channel_id
try {
  const cols = db.prepare("PRAGMA table_info(watched_channels)").all();
  if (cols.length > 0 && cols.find((c) => c.name === 'discord_channel_id')) {
    db.exec('ALTER TABLE watched_channels RENAME COLUMN discord_channel_id TO live_channel_id');
    db.exec('ALTER TABLE watched_channels ADD COLUMN clips_channel_id TEXT');
    // Copy live_channel_id to clips_channel_id for existing rows
    db.exec('UPDATE watched_channels SET clips_channel_id = live_channel_id');
    console.log('[DB] Migrated watched_channels: split discord_channel_id into live_channel_id + clips_channel_id');
  }
} catch {}

// Migration 4: add activity feed toggle columns to guilds
try {
  const cols = db.prepare("PRAGMA table_info(guilds)").all();
  if (cols.length > 0 && !cols.find((c) => c.name === 'recap_enabled')) {
    db.exec('ALTER TABLE guilds ADD COLUMN recap_enabled INTEGER DEFAULT 0');
    db.exec('ALTER TABLE guilds ADD COLUMN milestones_enabled INTEGER DEFAULT 0');
    db.exec('ALTER TABLE guilds ADD COLUMN weekly_highlights_enabled INTEGER DEFAULT 0');
    console.log('[DB] Added activity feed toggle columns to guilds');
  }
} catch {}

// Migration 5: add stream session columns to channel_state
try {
  const cols = db.prepare("PRAGMA table_info(channel_state)").all();
  if (cols.length > 0 && !cols.find((c) => c.name === 'stream_title')) {
    db.exec('ALTER TABLE channel_state ADD COLUMN stream_title TEXT');
    db.exec('ALTER TABLE channel_state ADD COLUMN stream_category TEXT');
    db.exec('ALTER TABLE channel_state ADD COLUMN stream_thumbnail_url TEXT');
    db.exec('ALTER TABLE channel_state ADD COLUMN stream_started_at TEXT');
    console.log('[DB] Added stream session columns to channel_state');
  }
} catch {}

// Migration 6: add profile_image_url to watched_channels
try {
  const cols = db.prepare("PRAGMA table_info(watched_channels)").all();
  if (cols.length > 0 && !cols.find((c) => c.name === 'profile_image_url')) {
    db.exec('ALTER TABLE watched_channels ADD COLUMN profile_image_url TEXT');
    console.log('[DB] Added profile_image_url column to watched_channels');
  }
} catch {}

// --- Schema ---

db.exec(`
  CREATE TABLE IF NOT EXISTS streamers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_user_id TEXT UNIQUE NOT NULL,
    discord_username TEXT NOT NULL,
    discord_display_name TEXT,
    discord_avatar TEXT,
    twitch_user_id TEXT UNIQUE,
    twitch_username TEXT,
    twitch_display_name TEXT,
    broadcaster_access_token TEXT,
    broadcaster_refresh_token TEXT,
    broadcaster_token_expires_at INTEGER DEFAULT 0,
    youtube_channel_id TEXT,
    youtube_api_key TEXT,
    enabled INTEGER DEFAULT 1,
    admin_note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS guilds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    streamer_id INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    guild_name TEXT,
    twitch_live_channel_id TEXT,
    twitch_clips_channel_id TEXT,
    youtube_channel_id TEXT,
    welcome_channel_id TEXT,
    sub_role_id TEXT,
    welcome_message TEXT,
    twitch_live_enabled INTEGER DEFAULT 1,
    twitch_clips_enabled INTEGER DEFAULT 1,
    youtube_enabled INTEGER DEFAULT 0,
    welcome_enabled INTEGER DEFAULT 0,
    sub_sync_enabled INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(guild_id, streamer_id)
  );

  CREATE TABLE IF NOT EXISTS poller_state (
    streamer_id INTEGER PRIMARY KEY REFERENCES streamers(id) ON DELETE CASCADE,
    twitch_is_live INTEGER DEFAULT 0,
    twitch_broadcaster_id TEXT,
    last_clip_created_at TEXT,
    known_video_ids TEXT DEFAULT '[]',
    youtube_is_live INTEGER DEFAULT 0,
    youtube_live_video_id TEXT
  );

  CREATE TABLE IF NOT EXISTS user_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    streamer_id INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    discord_user_id TEXT NOT NULL,
    twitch_user_id TEXT NOT NULL,
    twitch_username TEXT NOT NULL,
    UNIQUE(streamer_id, discord_user_id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    streamer_id INTEGER NOT NULL REFERENCES streamers(id),
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notification_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    streamer_id INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    guild_id TEXT NOT NULL,
    type TEXT NOT NULL,
    success INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_notification_log_streamer ON notification_log(streamer_id);
  CREATE INDEX IF NOT EXISTS idx_notification_log_created ON notification_log(created_at);

  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    streamer_id INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    tier TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'active',
    paypal_subscription_id TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT,
    cancelled_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    streamer_id INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    subscription_id INTEGER REFERENCES subscriptions(id),
    paypal_payment_id TEXT,
    amount REAL NOT NULL,
    currency TEXT DEFAULT 'EUR',
    discount_code TEXT,
    discount_percent INTEGER DEFAULT 0,
    status TEXT DEFAULT 'completed',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS discount_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    discount_percent INTEGER NOT NULL,
    max_uses INTEGER,
    current_uses INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    streamer_id INTEGER REFERENCES streamers(id) ON DELETE SET NULL,
    discord_username TEXT,
    subject TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT DEFAULT 'open',
    admin_reply TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS watched_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    streamer_id INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    twitch_username TEXT NOT NULL,
    twitch_broadcaster_id TEXT,
    live_channel_id TEXT,
    clips_channel_id TEXT,
    notify_live INTEGER DEFAULT 1,
    notify_clips INTEGER DEFAULT 1,
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(guild_id, streamer_id, twitch_username)
  );

  CREATE TABLE IF NOT EXISTS channel_state (
    twitch_username TEXT PRIMARY KEY,
    twitch_broadcaster_id TEXT,
    is_live INTEGER DEFAULT 0,
    last_clip_created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS watched_youtube_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    streamer_id INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    youtube_channel_id TEXT NOT NULL,
    youtube_channel_name TEXT,
    videos_channel_id TEXT,
    live_channel_id TEXT,
    notify_videos INTEGER DEFAULT 1,
    notify_live INTEGER DEFAULT 1,
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(guild_id, streamer_id, youtube_channel_id)
  );

  CREATE TABLE IF NOT EXISTS youtube_channel_state (
    youtube_channel_id TEXT PRIMARY KEY,
    known_video_ids TEXT DEFAULT '[]',
    is_live INTEGER DEFAULT 0,
    live_video_id TEXT
  );

  CREATE TABLE IF NOT EXISTS weekly_digest_state (
    guild_id TEXT PRIMARY KEY,
    last_digest_date TEXT
  );

  CREATE TABLE IF NOT EXISTS channel_milestones (
    twitch_username TEXT PRIMARY KEY,
    last_follower_count INTEGER DEFAULT 0,
    last_subscriber_count INTEGER DEFAULT 0,
    last_follower_milestone INTEGER DEFAULT 0,
    last_subscriber_milestone INTEGER DEFAULT 0
  );
`);

// --- Seed: ensure Ricardo Apple has enterprise subscription ---
try {
  const streamer = db.prepare("SELECT id FROM streamers WHERE discord_display_name = 'Ricardo Apple' OR discord_username = 'Ricardo Apple'").get();
  if (streamer) {
    const hasSub = db.prepare("SELECT id FROM subscriptions WHERE streamer_id = ? AND tier = 'enterprise' AND status = 'active'").get(streamer.id);
    if (!hasSub) {
      db.prepare("UPDATE subscriptions SET status = 'cancelled', cancelled_at = datetime('now') WHERE streamer_id = ? AND status = 'active'").run(streamer.id);
      db.prepare("INSERT INTO subscriptions (streamer_id, tier, status) VALUES (?, 'enterprise', 'active')").run(streamer.id);
      console.log('[DB] Granted enterprise subscription to Ricardo Apple');
    }
  }
} catch {}

// --- Streamers ---

const _getStreamerByDiscordId = db.prepare('SELECT * FROM streamers WHERE discord_user_id = ?');
const _getStreamerByTwitchId = db.prepare('SELECT * FROM streamers WHERE twitch_user_id = ?');
const _getStreamerById = db.prepare('SELECT * FROM streamers WHERE id = ?');
const _getAllStreamers = db.prepare('SELECT * FROM streamers WHERE twitch_user_id IS NOT NULL');
const _upsertStreamerDiscord = db.prepare(`
  INSERT INTO streamers (discord_user_id, discord_username, discord_display_name, discord_avatar)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(discord_user_id) DO UPDATE SET
    discord_username = excluded.discord_username,
    discord_display_name = excluded.discord_display_name,
    discord_avatar = excluded.discord_avatar
  RETURNING *
`);
const _clearOldTwitchLink = db.prepare('UPDATE streamers SET twitch_user_id = NULL, twitch_username = NULL, twitch_display_name = NULL WHERE twitch_user_id = ?');
const _linkTwitch = db.prepare(`
  UPDATE streamers SET
    twitch_user_id = ?,
    twitch_username = ?,
    twitch_display_name = ?
  WHERE id = ?
`);
const _updateStreamerBroadcasterTokens = db.prepare(`
  UPDATE streamers SET
    broadcaster_access_token = ?,
    broadcaster_refresh_token = ?,
    broadcaster_token_expires_at = ?
  WHERE id = ?
`);
const _updateStreamerYoutube = db.prepare(`
  UPDATE streamers SET youtube_channel_id = ?, youtube_api_key = ? WHERE id = ?
`);

function getStreamerByDiscordId(discordUserId) {
  return _getStreamerByDiscordId.get(discordUserId);
}

function getStreamerByTwitchId(twitchUserId) {
  return _getStreamerByTwitchId.get(twitchUserId);
}

function getStreamerById(id) {
  return _getStreamerById.get(id);
}

function getAllStreamers() {
  return _getAllStreamers.all();
}

function upsertStreamerDiscord(discordUserId, discordUsername, discordDisplayName, discordAvatar) {
  return _upsertStreamerDiscord.get(discordUserId, discordUsername, discordDisplayName, discordAvatar);
}

function linkTwitch(streamerId, twitchUserId, twitchUsername, twitchDisplayName) {
  _clearOldTwitchLink.run(twitchUserId); // clear if another streamer had this Twitch linked
  _linkTwitch.run(twitchUserId, twitchUsername, twitchDisplayName, streamerId);
}

function updateStreamerBroadcasterTokens(streamerId, accessToken, refreshToken, expiresAt) {
  _updateStreamerBroadcasterTokens.run(accessToken, refreshToken, expiresAt, streamerId);
}

function updateStreamerYoutube(streamerId, youtubeChannelId, youtubeApiKey) {
  _updateStreamerYoutube.run(youtubeChannelId, youtubeApiKey, streamerId);
}

// --- Guilds ---

const _getGuildsForStreamer = db.prepare('SELECT * FROM guilds WHERE streamer_id = ?');
const _getGuildConfig = db.prepare('SELECT * FROM guilds WHERE guild_id = ? AND streamer_id = ?');
const _getGuildConfigsByGuildId = db.prepare('SELECT guilds.*, streamers.twitch_username FROM guilds JOIN streamers ON guilds.streamer_id = streamers.id WHERE guild_id = ?');
const _upsertGuild = db.prepare(`
  INSERT INTO guilds (guild_id, streamer_id, guild_name)
  VALUES (?, ?, ?)
  ON CONFLICT(guild_id, streamer_id) DO UPDATE SET guild_name = excluded.guild_name
  RETURNING *
`);
const _updateGuildConfig = db.prepare(`
  UPDATE guilds SET
    twitch_live_channel_id = ?,
    twitch_clips_channel_id = ?,
    youtube_channel_id = ?,
    welcome_channel_id = ?,
    sub_role_id = ?,
    welcome_message = ?,
    twitch_live_enabled = ?,
    twitch_clips_enabled = ?,
    youtube_enabled = ?,
    welcome_enabled = ?,
    sub_sync_enabled = ?,
    recap_enabled = ?,
    milestones_enabled = ?,
    weekly_highlights_enabled = ?
  WHERE guild_id = ? AND streamer_id = ?
`);
const _deleteGuild = db.prepare('DELETE FROM guilds WHERE guild_id = ? AND streamer_id = ?');

const _getAllClaimedGuildIds = db.prepare('SELECT DISTINCT guild_id FROM guilds');

function getAllClaimedGuildIds() {
  return new Set(_getAllClaimedGuildIds.all().map((r) => r.guild_id));
}

function getGuildsForStreamer(streamerId) {
  return _getGuildsForStreamer.all(streamerId);
}

function getGuildConfig(guildId, streamerId) {
  return _getGuildConfig.get(guildId, streamerId);
}

function getGuildConfigsByGuildId(guildId) {
  return _getGuildConfigsByGuildId.all(guildId);
}

function upsertGuild(guildId, streamerId, guildName) {
  return _upsertGuild.get(guildId, streamerId, guildName);
}

function updateGuildConfig(guildId, streamerId, config) {
  _updateGuildConfig.run(
    config.twitch_live_channel_id || null,
    config.twitch_clips_channel_id || null,
    config.youtube_channel_id || null,
    config.welcome_channel_id || null,
    config.sub_role_id || null,
    config.welcome_message || null,
    config.twitch_live_enabled ? 1 : 0,
    config.twitch_clips_enabled ? 1 : 0,
    config.youtube_enabled ? 1 : 0,
    config.welcome_enabled ? 1 : 0,
    config.sub_sync_enabled ? 1 : 0,
    config.recap_enabled ? 1 : 0,
    config.milestones_enabled ? 1 : 0,
    config.weekly_highlights_enabled ? 1 : 0,
    guildId,
    streamerId
  );
}

function deleteGuild(guildId, streamerId) {
  _deleteGuild.run(guildId, streamerId);
}

// --- Poller State ---

const _getPollerState = db.prepare('SELECT * FROM poller_state WHERE streamer_id = ?');
const _upsertPollerState = db.prepare(`
  INSERT INTO poller_state (streamer_id) VALUES (?)
  ON CONFLICT(streamer_id) DO NOTHING
`);
const _updatePollerState = db.prepare(`
  UPDATE poller_state SET
    twitch_is_live = COALESCE(?, twitch_is_live),
    twitch_broadcaster_id = COALESCE(?, twitch_broadcaster_id),
    last_clip_created_at = COALESCE(?, last_clip_created_at),
    known_video_ids = COALESCE(?, known_video_ids),
    youtube_is_live = COALESCE(?, youtube_is_live),
    youtube_live_video_id = COALESCE(?, youtube_live_video_id)
  WHERE streamer_id = ?
`);

function getPollerState(streamerId) {
  _upsertPollerState.run(streamerId);
  return _getPollerState.get(streamerId);
}

function updatePollerState(streamerId, updates) {
  _updatePollerState.run(
    updates.twitch_is_live ?? null,
    updates.twitch_broadcaster_id ?? null,
    updates.last_clip_created_at ?? null,
    updates.known_video_ids ?? null,
    updates.youtube_is_live ?? null,
    updates.youtube_live_video_id ?? null,
    streamerId
  );
}

// --- User Links ---

const _getLinkedUsers = db.prepare('SELECT * FROM user_links WHERE streamer_id = ?');
const _linkUser = db.prepare(`
  INSERT INTO user_links (streamer_id, discord_user_id, twitch_user_id, twitch_username)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(streamer_id, discord_user_id) DO UPDATE SET
    twitch_user_id = excluded.twitch_user_id,
    twitch_username = excluded.twitch_username
`);

function getLinkedUsers(streamerId) {
  return _getLinkedUsers.all(streamerId);
}

function linkUser(streamerId, discordUserId, twitchUserId, twitchUsername) {
  _linkUser.run(streamerId, discordUserId, twitchUserId, twitchUsername);
}

// --- Sessions ---

const _createSession = db.prepare('INSERT OR REPLACE INTO sessions (sid, streamer_id, expires_at) VALUES (?, ?, ?)');
const _getSession = db.prepare('SELECT * FROM sessions WHERE sid = ? AND expires_at > ?');
const _deleteSession = db.prepare('DELETE FROM sessions WHERE sid = ?');
const _cleanExpiredSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

function createSession(sid, streamerId, expiresAt) {
  _createSession.run(sid, streamerId, expiresAt);
}

function getSession(sid) {
  return _getSession.get(sid, Date.now());
}

function deleteSession(sid) {
  _deleteSession.run(sid);
}

function cleanExpiredSessions() {
  _cleanExpiredSessions.run(Date.now());
}

// --- Notification Logging ---

const _logNotification = db.prepare(`
  INSERT INTO notification_log (streamer_id, guild_id, type, success) VALUES (?, ?, ?, ?)
`);

function logNotification(streamerId, guildId, type, success) {
  _logNotification.run(streamerId, guildId, type, success ? 1 : 0);
}

// --- Streamer Stats (for account page) ---

const _getStreamerStats = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM guilds WHERE streamer_id = ?) AS total_guilds,
    (SELECT COUNT(*) FROM watched_channels WHERE streamer_id = ?) AS total_twitch_channels,
    (SELECT COUNT(*) FROM watched_youtube_channels WHERE streamer_id = ?) AS total_youtube_channels,
    (SELECT COUNT(*) FROM notification_log WHERE streamer_id = ?) AS total_notifications,
    (SELECT COUNT(*) FROM notification_log WHERE streamer_id = ? AND created_at > datetime('now', '-1 day')) AS notifications_today,
    (SELECT COUNT(*) FROM notification_log WHERE streamer_id = ? AND created_at > datetime('now', '-7 days')) AS notifications_week,
    (SELECT COUNT(*) FROM notification_log WHERE streamer_id = ? AND created_at > datetime('now', '-30 days')) AS notifications_month
`);

const _getStreamerNotificationsOverTime = db.prepare(`
  SELECT strftime(?, created_at) AS period, COUNT(*) AS count
  FROM notification_log WHERE streamer_id = ? GROUP BY period ORDER BY period DESC LIMIT ?
`);

const _getStreamerNotificationsByType = db.prepare(`
  SELECT type, COUNT(*) AS count
  FROM notification_log WHERE streamer_id = ? GROUP BY type ORDER BY count DESC
`);

function getStreamerStats(streamerId) {
  return _getStreamerStats.get(streamerId, streamerId, streamerId, streamerId, streamerId, streamerId, streamerId);
}

function getStreamerNotificationsOverTime(streamerId, format, limit) {
  return _getStreamerNotificationsOverTime.all(format, streamerId, limit).reverse();
}

function getStreamerNotificationsByType(streamerId) {
  return _getStreamerNotificationsByType.all(streamerId);
}

const _getGuildNotificationStats = db.prepare(`
  SELECT
    COALESCE(SUM(CASE WHEN type = 'twitch_live' THEN 1 ELSE 0 END), 0) AS live_count,
    COALESCE(SUM(CASE WHEN type = 'twitch_clip' THEN 1 ELSE 0 END), 0) AS clip_count,
    COALESCE(SUM(CASE WHEN type = 'twitch_recap' THEN 1 ELSE 0 END), 0) AS recap_count,
    COALESCE(SUM(CASE WHEN type = 'youtube_video' THEN 1 ELSE 0 END), 0) AS youtube_video_count,
    COALESCE(SUM(CASE WHEN type = 'youtube_live' THEN 1 ELSE 0 END), 0) AS youtube_live_count,
    COALESCE(SUM(CASE WHEN type = 'twitch_milestone' THEN 1 ELSE 0 END), 0) AS milestone_count,
    COALESCE(SUM(CASE WHEN type = 'weekly_digest' THEN 1 ELSE 0 END), 0) AS digest_count,
    COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN created_at > datetime('now', '-7 days') THEN 1 ELSE 0 END), 0) AS week_total
  FROM notification_log WHERE streamer_id = ? AND guild_id = ?
`);

function getGuildNotificationStats(streamerId, guildId) {
  return _getGuildNotificationStats.get(streamerId, guildId);
}

const _getGuildStatsByPeriod = db.prepare(`
  SELECT
    COALESCE(SUM(CASE WHEN type = 'twitch_live' THEN 1 ELSE 0 END), 0) AS live_count,
    COALESCE(SUM(CASE WHEN type = 'twitch_clip' THEN 1 ELSE 0 END), 0) AS clip_count,
    COALESCE(SUM(CASE WHEN type = 'twitch_recap' THEN 1 ELSE 0 END), 0) AS recap_count,
    COALESCE(SUM(CASE WHEN type = 'youtube_video' THEN 1 ELSE 0 END), 0) AS youtube_video_count,
    COALESCE(SUM(CASE WHEN type = 'youtube_live' THEN 1 ELSE 0 END), 0) AS youtube_live_count,
    COALESCE(SUM(CASE WHEN type = 'twitch_milestone' THEN 1 ELSE 0 END), 0) AS milestone_count,
    COALESCE(SUM(CASE WHEN type = 'weekly_digest' THEN 1 ELSE 0 END), 0) AS digest_count,
    COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) AS success_count,
    COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS fail_count
  FROM notification_log WHERE streamer_id = ? AND guild_id = ? AND created_at > datetime('now', ?)
`);

const _getGuildStatsLifetime = db.prepare(`
  SELECT
    COALESCE(SUM(CASE WHEN type = 'twitch_live' THEN 1 ELSE 0 END), 0) AS live_count,
    COALESCE(SUM(CASE WHEN type = 'twitch_clip' THEN 1 ELSE 0 END), 0) AS clip_count,
    COALESCE(SUM(CASE WHEN type = 'twitch_recap' THEN 1 ELSE 0 END), 0) AS recap_count,
    COALESCE(SUM(CASE WHEN type = 'youtube_video' THEN 1 ELSE 0 END), 0) AS youtube_video_count,
    COALESCE(SUM(CASE WHEN type = 'youtube_live' THEN 1 ELSE 0 END), 0) AS youtube_live_count,
    COALESCE(SUM(CASE WHEN type = 'twitch_milestone' THEN 1 ELSE 0 END), 0) AS milestone_count,
    COALESCE(SUM(CASE WHEN type = 'weekly_digest' THEN 1 ELSE 0 END), 0) AS digest_count,
    COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) AS success_count,
    COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS fail_count
  FROM notification_log WHERE streamer_id = ? AND guild_id = ?
`);

const _getGuildNotificationsOverTime = db.prepare(`
  SELECT strftime(?, created_at) AS period, COUNT(*) AS count
  FROM notification_log WHERE streamer_id = ? AND guild_id = ? AND created_at > datetime('now', ?)
  GROUP BY period ORDER BY period ASC
`);

const _getGuildNotificationsByTypeOverTime = db.prepare(`
  SELECT strftime(?, created_at) AS period, type, COUNT(*) AS count
  FROM notification_log WHERE streamer_id = ? AND guild_id = ? AND created_at > datetime('now', ?)
  GROUP BY period, type ORDER BY period ASC
`);

function getGuildStatsByPeriod(streamerId, guildId, period) {
  if (period === 'lifetime') {
    return _getGuildStatsLifetime.get(streamerId, guildId);
  }
  const offsets = { '24h': '-1 day', '7d': '-7 days', '30d': '-30 days', '1y': '-365 days' };
  return _getGuildStatsByPeriod.get(streamerId, guildId, offsets[period] || '-7 days');
}

function getGuildNotificationsOverTime(streamerId, guildId, period) {
  const config = {
    '24h': { format: '%H:00', offset: '-1 day' },
    '7d': { format: '%Y-%m-%d', offset: '-7 days' },
    '30d': { format: '%Y-%m-%d', offset: '-30 days' },
    '1y': { format: '%Y-%m', offset: '-365 days' },
    'lifetime': { format: '%Y-%m', offset: '-10 years' },
  };
  const c = config[period] || config['7d'];
  return _getGuildNotificationsOverTime.all(c.format, streamerId, guildId, c.offset);
}

function getGuildNotificationsByTypeOverTime(streamerId, guildId, period) {
  const config = {
    '24h': { format: '%H:00', offset: '-1 day' },
    '7d': { format: '%Y-%m-%d', offset: '-7 days' },
    '30d': { format: '%Y-%m-%d', offset: '-30 days' },
    '1y': { format: '%Y-%m', offset: '-365 days' },
    'lifetime': { format: '%Y-%m', offset: '-10 years' },
  };
  const c = config[period] || config['30d'];
  const rows = _getGuildNotificationsByTypeOverTime.all(c.format, streamerId, guildId, c.offset);

  // Build a map: period -> { type: count, ... }
  const periods = new Map();
  for (const row of rows) {
    if (!periods.has(row.period)) periods.set(row.period, {});
    periods.get(row.period)[row.type] = row.count;
  }

  // Convert to array sorted by period
  return [...periods.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([period, types]) => ({ period, ...types }));
}

// --- Admin ---

const _disableStreamer = db.prepare('UPDATE streamers SET enabled = 0, admin_note = ? WHERE id = ?');
const _enableStreamer = db.prepare('UPDATE streamers SET enabled = 1, admin_note = NULL WHERE id = ?');
const _deleteStreamer = db.prepare('DELETE FROM streamers WHERE id = ?');

const _getAllStreamersAdmin = db.prepare(`
  SELECT s.*,
    (SELECT COUNT(*) FROM guilds WHERE streamer_id = s.id) AS guild_count,
    (SELECT COUNT(*) FROM notification_log WHERE streamer_id = s.id) AS total_notifications,
    (SELECT COUNT(*) FROM notification_log WHERE streamer_id = s.id AND created_at > datetime('now', '-1 day')) AS notifications_today
  FROM streamers s
  ORDER BY s.created_at DESC
`);

const _getGlobalStats = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM streamers) AS total_streamers,
    (SELECT COUNT(*) FROM streamers WHERE enabled = 1) AS active_streamers,
    (SELECT COUNT(*) FROM guilds) AS total_guilds,
    (SELECT COUNT(*) FROM notification_log) AS total_notifications,
    (SELECT COUNT(*) FROM notification_log WHERE created_at > datetime('now', '-1 day')) AS notifications_today,
    (SELECT COUNT(*) FROM notification_log WHERE created_at > datetime('now', '-7 days')) AS notifications_week
`);

const _getRecentNotifications = db.prepare(`
  SELECT nl.*, s.twitch_username, s.discord_username
  FROM notification_log nl
  JOIN streamers s ON nl.streamer_id = s.id
  ORDER BY nl.created_at DESC
  LIMIT 50
`);

function disableStreamer(id, note) {
  _disableStreamer.run(note || null, id);
}

function enableStreamer(id) {
  _enableStreamer.run(id);
}

function deleteStreamer(id) {
  _deleteStreamer.run(id);
}

function getAllStreamersAdmin() {
  return _getAllStreamersAdmin.all();
}

function getGlobalStats() {
  return _getGlobalStats.get();
}

function getRecentNotifications() {
  return _getRecentNotifications.all();
}

// --- Watched Channels ---

const _addWatchedChannel = db.prepare(`
  INSERT OR IGNORE INTO watched_channels (guild_id, streamer_id, twitch_username, live_channel_id, clips_channel_id, notify_live, notify_clips, profile_image_url)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const _updateWatchedChannelProfileImage = db.prepare('UPDATE watched_channels SET profile_image_url = ? WHERE id = ?');
const _removeWatchedChannel = db.prepare('DELETE FROM watched_channels WHERE id = ? AND streamer_id = ?');
const _getWatchedChannelsForGuild = db.prepare('SELECT * FROM watched_channels WHERE guild_id = ? AND streamer_id = ?');
const _getAllUniqueWatchedChannels = db.prepare('SELECT DISTINCT twitch_username FROM watched_channels WHERE enabled = 1');
const _getWatchersForChannel = db.prepare(`
  SELECT wc.*, s.id AS owner_id, s.enabled AS streamer_enabled
  FROM watched_channels wc
  JOIN streamers s ON wc.streamer_id = s.id
  WHERE wc.twitch_username = ? AND wc.enabled = 1 AND s.enabled = 1
`);
const _getChannelState = db.prepare('SELECT * FROM channel_state WHERE twitch_username = ?');
const _upsertChannelState = db.prepare(`
  INSERT INTO channel_state (twitch_username) VALUES (?)
  ON CONFLICT(twitch_username) DO NOTHING
`);
const _updateChannelState = db.prepare(`
  UPDATE channel_state SET
    twitch_broadcaster_id = COALESCE(?, twitch_broadcaster_id),
    is_live = COALESCE(?, is_live),
    last_clip_created_at = COALESCE(?, last_clip_created_at),
    stream_title = COALESCE(?, stream_title),
    stream_category = COALESCE(?, stream_category),
    stream_thumbnail_url = COALESCE(?, stream_thumbnail_url),
    stream_started_at = COALESCE(?, stream_started_at)
  WHERE twitch_username = ?
`);

function addWatchedChannel(guildId, streamerId, twitchUsername, liveChannelId, clipsChannelId, notifyLive, notifyClips, profileImageUrl = null) {
  _addWatchedChannel.run(guildId, streamerId, twitchUsername.toLowerCase(), liveChannelId || null, clipsChannelId || null, notifyLive ? 1 : 0, notifyClips ? 1 : 0, profileImageUrl);
  // Ensure channel_state row exists
  _upsertChannelState.run(twitchUsername.toLowerCase());
}

function updateWatchedChannelProfileImage(id, profileImageUrl) {
  _updateWatchedChannelProfileImage.run(profileImageUrl, id);
}

const _updateWatchedChannel = db.prepare(`
  UPDATE watched_channels SET live_channel_id = ?, clips_channel_id = ?,
    notify_live = ?, notify_clips = ?
  WHERE id = ? AND streamer_id = ?
`);

function updateWatchedChannel(id, streamerId, liveChannelId, clipsChannelId) {
  _updateWatchedChannel.run(
    liveChannelId || null, clipsChannelId || null,
    liveChannelId ? 1 : 0, clipsChannelId ? 1 : 0,
    id, streamerId
  );
}

const _updateWatchedYoutubeChannel = db.prepare(`
  UPDATE watched_youtube_channels SET videos_channel_id = ?, live_channel_id = ?,
    notify_videos = ?, notify_live = ?
  WHERE id = ? AND streamer_id = ?
`);

function updateWatchedYoutubeChannel(id, streamerId, videosChannelId, liveChannelId) {
  _updateWatchedYoutubeChannel.run(
    videosChannelId || null, liveChannelId || null,
    videosChannelId ? 1 : 0, liveChannelId ? 1 : 0,
    id, streamerId
  );
}

function removeWatchedChannel(id, streamerId) {
  _removeWatchedChannel.run(id, streamerId);
}

function getWatchedChannelsForGuild(guildId, streamerId) {
  return _getWatchedChannelsForGuild.all(guildId, streamerId);
}

function getAllUniqueWatchedChannels() {
  return _getAllUniqueWatchedChannels.all();
}

function getWatchersForChannel(twitchUsername) {
  return _getWatchersForChannel.all(twitchUsername.toLowerCase());
}

function getChannelState(twitchUsername) {
  _upsertChannelState.run(twitchUsername.toLowerCase());
  return _getChannelState.get(twitchUsername.toLowerCase());
}

function updateChannelState(twitchUsername, updates) {
  _updateChannelState.run(
    updates.twitch_broadcaster_id ?? null,
    updates.is_live ?? null,
    updates.last_clip_created_at ?? null,
    updates.stream_title ?? null,
    updates.stream_category ?? null,
    updates.stream_thumbnail_url ?? null,
    updates.stream_started_at ?? null,
    twitchUsername.toLowerCase()
  );
}

// --- Watched Channel Feature Queries ---

const _getWatchersForChannelWithFeatures = db.prepare(`
  SELECT wc.*, g.recap_enabled, g.milestones_enabled, g.weekly_highlights_enabled,
         s.id AS owner_id, s.enabled AS streamer_enabled
  FROM watched_channels wc
  JOIN guilds g ON wc.guild_id = g.guild_id AND wc.streamer_id = g.streamer_id
  JOIN streamers s ON wc.streamer_id = s.id
  WHERE wc.twitch_username = ? AND wc.enabled = 1 AND s.enabled = 1
`);

function getWatchersForChannelWithFeatures(twitchUsername) {
  return _getWatchersForChannelWithFeatures.all(twitchUsername.toLowerCase());
}

// --- Channel Milestones ---

const _getChannelMilestones = db.prepare('SELECT * FROM channel_milestones WHERE twitch_username = ?');
const _upsertChannelMilestones = db.prepare(`
  INSERT INTO channel_milestones (twitch_username) VALUES (?)
  ON CONFLICT(twitch_username) DO NOTHING
`);
const _updateChannelMilestones = db.prepare(`
  UPDATE channel_milestones SET
    last_follower_count = COALESCE(?, last_follower_count),
    last_subscriber_count = COALESCE(?, last_subscriber_count),
    last_follower_milestone = COALESCE(?, last_follower_milestone),
    last_subscriber_milestone = COALESCE(?, last_subscriber_milestone)
  WHERE twitch_username = ?
`);

function getChannelMilestones(twitchUsername) {
  _upsertChannelMilestones.run(twitchUsername.toLowerCase());
  return _getChannelMilestones.get(twitchUsername.toLowerCase());
}

function updateChannelMilestones(twitchUsername, updates) {
  _updateChannelMilestones.run(
    updates.last_follower_count ?? null,
    updates.last_subscriber_count ?? null,
    updates.last_follower_milestone ?? null,
    updates.last_subscriber_milestone ?? null,
    twitchUsername.toLowerCase()
  );
}

// --- Weekly Digest State ---

const _getWeeklyDigestState = db.prepare('SELECT * FROM weekly_digest_state WHERE guild_id = ?');
const _upsertWeeklyDigestDate = db.prepare(`
  INSERT INTO weekly_digest_state (guild_id, last_digest_date) VALUES (?, ?)
  ON CONFLICT(guild_id) DO UPDATE SET last_digest_date = excluded.last_digest_date
`);

function getWeeklyDigestState(guildId) {
  return _getWeeklyDigestState.get(guildId);
}

function updateWeeklyDigestDate(guildId, dateStr) {
  _upsertWeeklyDigestDate.run(guildId, dateStr);
}

// --- Weekly Highlights Guilds ---

const _getGuildsWithWeeklyHighlights = db.prepare(`
  SELECT g.guild_id, MIN(g.streamer_id) AS streamer_id
  FROM guilds g
  JOIN streamers s ON g.streamer_id = s.id
  WHERE g.weekly_highlights_enabled = 1 AND s.enabled = 1
  GROUP BY g.guild_id
`);

function getGuildsWithWeeklyHighlights() {
  return _getGuildsWithWeeklyHighlights.all();
}

// --- Digest Channel ---

const _getDigestChannelForGuild = db.prepare(`
  SELECT wc.live_channel_id FROM watched_channels wc
  WHERE wc.guild_id = ? AND wc.live_channel_id IS NOT NULL
  ORDER BY wc.id ASC LIMIT 1
`);

function getDigestChannelForGuild(guildId) {
  const row = _getDigestChannelForGuild.get(guildId);
  return row?.live_channel_id || null;
}

// --- Clear Stream Session ---

const _clearStreamSession = db.prepare(`
  UPDATE channel_state SET
    stream_title = NULL,
    stream_category = NULL,
    stream_thumbnail_url = NULL,
    stream_started_at = NULL
  WHERE twitch_username = ?
`);

function clearStreamSession(twitchUsername) {
  _clearStreamSession.run(twitchUsername.toLowerCase());
}

// --- Watched YouTube Channels ---

const _addWatchedYoutubeChannel = db.prepare(`
  INSERT OR IGNORE INTO watched_youtube_channels (guild_id, streamer_id, youtube_channel_id, youtube_channel_name, videos_channel_id, live_channel_id, notify_videos, notify_live)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const _removeWatchedYoutubeChannel = db.prepare('DELETE FROM watched_youtube_channels WHERE id = ? AND streamer_id = ?');
const _getWatchedYoutubeChannelsForGuild = db.prepare('SELECT * FROM watched_youtube_channels WHERE guild_id = ? AND streamer_id = ?');
const _getAllUniqueWatchedYoutubeChannels = db.prepare('SELECT DISTINCT youtube_channel_id FROM watched_youtube_channels WHERE enabled = 1');
const _getYoutubeWatchersForChannel = db.prepare(`
  SELECT wyc.*, s.id AS owner_id, s.enabled AS streamer_enabled, s.youtube_api_key
  FROM watched_youtube_channels wyc
  JOIN streamers s ON wyc.streamer_id = s.id
  WHERE wyc.youtube_channel_id = ? AND wyc.enabled = 1 AND s.enabled = 1
`);
const _getYoutubeChannelState = db.prepare('SELECT * FROM youtube_channel_state WHERE youtube_channel_id = ?');
const _upsertYoutubeChannelState = db.prepare(`
  INSERT INTO youtube_channel_state (youtube_channel_id) VALUES (?)
  ON CONFLICT(youtube_channel_id) DO NOTHING
`);
const _upsertYoutubeChannelStateWithVideos = db.prepare(`
  INSERT INTO youtube_channel_state (youtube_channel_id, known_video_ids) VALUES (?, ?)
  ON CONFLICT(youtube_channel_id) DO NOTHING
`);
const _updateYoutubeChannelState = db.prepare(`
  UPDATE youtube_channel_state SET
    known_video_ids = COALESCE(?, known_video_ids),
    is_live = COALESCE(?, is_live),
    live_video_id = COALESCE(?, live_video_id)
  WHERE youtube_channel_id = ?
`);

function addWatchedYoutubeChannel(guildId, streamerId, ytChannelId, ytChannelName, videosChannelId, liveChannelId, knownVideoIds) {
  _addWatchedYoutubeChannel.run(guildId, streamerId, ytChannelId, ytChannelName || null, videosChannelId || null, liveChannelId || null, videosChannelId ? 1 : 0, liveChannelId ? 1 : 0);
  if (knownVideoIds) {
    _upsertYoutubeChannelStateWithVideos.run(ytChannelId, knownVideoIds);
  } else {
    _upsertYoutubeChannelState.run(ytChannelId);
  }
}

function removeWatchedYoutubeChannel(id, streamerId) {
  _removeWatchedYoutubeChannel.run(id, streamerId);
}

function getWatchedYoutubeChannelsForGuild(guildId, streamerId) {
  return _getWatchedYoutubeChannelsForGuild.all(guildId, streamerId);
}

function getAllUniqueWatchedYoutubeChannels() {
  return _getAllUniqueWatchedYoutubeChannels.all();
}

function getYoutubeWatchersForChannel(ytChannelId) {
  return _getYoutubeWatchersForChannel.all(ytChannelId);
}

function getYoutubeChannelState(ytChannelId) {
  _upsertYoutubeChannelState.run(ytChannelId);
  return _getYoutubeChannelState.get(ytChannelId);
}

function updateYoutubeChannelState(ytChannelId, updates) {
  _updateYoutubeChannelState.run(
    updates.known_video_ids ?? null,
    updates.is_live ?? null,
    updates.live_video_id ?? null,
    ytChannelId
  );
}

// --- Subscriptions ---

const _getSubscription = db.prepare("SELECT * FROM subscriptions WHERE streamer_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1");
const _createSubscription = db.prepare('INSERT INTO subscriptions (streamer_id, tier, status, paypal_subscription_id, expires_at) VALUES (?, ?, ?, ?, ?)');
const _cancelSubscription = db.prepare("UPDATE subscriptions SET status = 'cancelled', cancelled_at = datetime('now') WHERE streamer_id = ? AND status = 'active'");
const _expireSubscriptions = db.prepare("UPDATE subscriptions SET status = 'expired' WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < datetime('now')");
const _ensureFreeSubscription = db.prepare(`
  INSERT INTO subscriptions (streamer_id, tier, status)
  SELECT id, 'free', 'active' FROM streamers
  WHERE id NOT IN (SELECT streamer_id FROM subscriptions WHERE status = 'active')
`);

function getSubscription(streamerId) {
  return _getSubscription.get(streamerId);
}

function getStreamerTier(streamerId) {
  const sub = getSubscription(streamerId);
  return sub?.tier || 'free';
}

function createSubscription(streamerId, tier, paypalSubId, expiresAt) {
  // Cancel any existing active subscription first
  _cancelSubscription.run(streamerId);
  return _createSubscription.run(streamerId, tier, 'active', paypalSubId || null, expiresAt || null);
}

function cancelSubscription(streamerId) {
  _cancelSubscription.run(streamerId);
  // Create a free subscription
  _createSubscription.run(streamerId, 'free', 'active', null, null);
}

function expireSubscriptions() {
  const result = _expireSubscriptions.run();
  if (result.changes > 0) {
    console.log(`[Subscriptions] Expired ${result.changes} subscriptions`);
  }
}

function ensureFreeSubscriptions() {
  _ensureFreeSubscription.run();
}

// --- Transactions ---

const _createTransaction = db.prepare('INSERT INTO transactions (streamer_id, subscription_id, paypal_payment_id, amount, discount_code, discount_percent) VALUES (?, ?, ?, ?, ?, ?)');
const _getRevenueStats = db.prepare(`
  SELECT
    (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE status = 'completed') AS total_revenue,
    (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE status = 'completed' AND created_at > datetime('now', '-1 day')) AS revenue_today,
    (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE status = 'completed' AND created_at > datetime('now', '-30 days')) AS revenue_month,
    (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE status = 'completed' AND created_at > datetime('now', '-365 days')) AS revenue_year,
    (SELECT COUNT(*) FROM transactions WHERE status = 'completed') AS total_transactions
`);
const _getRecentTransactions = db.prepare(`
  SELECT t.*, s.discord_username FROM transactions t
  JOIN streamers s ON t.streamer_id = s.id
  ORDER BY t.created_at DESC LIMIT 50
`);
const _getMonthlyRevenue = db.prepare(`
  SELECT strftime('%Y-%m', created_at) AS month, SUM(amount) AS total
  FROM transactions WHERE status = 'completed'
  GROUP BY month ORDER BY month DESC LIMIT 12
`);
const _getSubscriptionsByTier = db.prepare(`
  SELECT tier, COUNT(*) AS count FROM subscriptions WHERE status = 'active' GROUP BY tier
`);

function createTransaction(streamerId, subscriptionId, amount, paypalPaymentId, discountCode, discountPercent) {
  _createTransaction.run(streamerId, subscriptionId, paypalPaymentId || null, amount, discountCode || null, discountPercent || 0);
}

function getRevenueStats() {
  return _getRevenueStats.get();
}

function getRecentTransactions() {
  return _getRecentTransactions.all();
}

function getMonthlyRevenue() {
  return _getMonthlyRevenue.all();
}

function getSubscriptionsByTier() {
  return _getSubscriptionsByTier.all();
}

// --- Discount Codes ---

const _createDiscountCode = db.prepare('INSERT INTO discount_codes (code, discount_percent, max_uses) VALUES (?, ?, ?)');
const _getDiscountCode = db.prepare("SELECT * FROM discount_codes WHERE code = ? AND active = 1 AND (max_uses IS NULL OR current_uses < max_uses)");
const _useDiscountCode = db.prepare('UPDATE discount_codes SET current_uses = current_uses + 1 WHERE code = ?');
const _getAllDiscountCodes = db.prepare('SELECT * FROM discount_codes ORDER BY created_at DESC');
const _toggleDiscountCode = db.prepare('UPDATE discount_codes SET active = ? WHERE id = ?');

function createDiscountCode(code, discountPercent, maxUses) {
  _createDiscountCode.run(code.toUpperCase(), discountPercent, maxUses || null);
}

function getDiscountCode(code) {
  return _getDiscountCode.get(code.toUpperCase());
}

function useDiscountCode(code) {
  _useDiscountCode.run(code.toUpperCase());
}

function getAllDiscountCodes() {
  return _getAllDiscountCodes.all();
}

function toggleDiscountCode(id, active) {
  _toggleDiscountCode.run(active ? 1 : 0, id);
}

// --- Analytics ---

const _getUsersOverTime = db.prepare(`
  SELECT strftime(?, created_at) AS period, COUNT(*) AS count
  FROM streamers GROUP BY period ORDER BY period DESC LIMIT ?
`);
const _getNotificationsOverTime = db.prepare(`
  SELECT strftime(?, created_at) AS period, COUNT(*) AS count
  FROM notification_log GROUP BY period ORDER BY period DESC LIMIT ?
`);
const _getServersOverTime = db.prepare(`
  SELECT strftime(?, created_at) AS period, COUNT(*) AS count
  FROM guilds GROUP BY period ORDER BY period DESC LIMIT ?
`);

function getUsersOverTime(format, limit) {
  return _getUsersOverTime.all(format, limit).reverse();
}

function getNotificationsOverTime(format, limit) {
  return _getNotificationsOverTime.all(format, limit).reverse();
}

function getServersOverTime(format, limit) {
  return _getServersOverTime.all(format, limit).reverse();
}

// --- Issues ---

const _createIssue = db.prepare('INSERT INTO issues (streamer_id, discord_username, subject, description) VALUES (?, ?, ?, ?)');
const _getAllIssues = db.prepare('SELECT * FROM issues ORDER BY created_at DESC');
const _getIssueById = db.prepare('SELECT * FROM issues WHERE id = ?');
const _updateIssueStatus = db.prepare('UPDATE issues SET status = ?, admin_reply = ?, updated_at = datetime(\'now\') WHERE id = ?');

function createIssue(streamerId, discordUsername, subject, description) {
  return _createIssue.run(streamerId, discordUsername, subject, description);
}

function getAllIssues() {
  return _getAllIssues.all();
}

function getIssueById(id) {
  return _getIssueById.get(id);
}

function updateIssueStatus(id, status, adminReply) {
  _updateIssueStatus.run(status, adminReply || null, id);
}

module.exports = {
  db,
  getStreamerByDiscordId,
  getStreamerByTwitchId,
  getStreamerById,
  getAllStreamers,
  upsertStreamerDiscord,
  linkTwitch,
  updateStreamerBroadcasterTokens,
  updateStreamerYoutube,
  getAllClaimedGuildIds,
  getGuildsForStreamer,
  getGuildConfig,
  getGuildConfigsByGuildId,
  upsertGuild,
  updateGuildConfig,
  deleteGuild,
  getPollerState,
  updatePollerState,
  getLinkedUsers,
  linkUser,
  createSession,
  getSession,
  deleteSession,
  cleanExpiredSessions,
  logNotification,
  disableStreamer,
  enableStreamer,
  deleteStreamer,
  getAllStreamersAdmin,
  getGlobalStats,
  getRecentNotifications,
  addWatchedChannel,
  removeWatchedChannel,
  getWatchedChannelsForGuild,
  getAllUniqueWatchedChannels,
  getWatchersForChannel,
  getChannelState,
  updateChannelState,
  addWatchedYoutubeChannel,
  removeWatchedYoutubeChannel,
  getWatchedYoutubeChannelsForGuild,
  getAllUniqueWatchedYoutubeChannels,
  getYoutubeWatchersForChannel,
  getYoutubeChannelState,
  updateYoutubeChannelState,
  createIssue,
  getAllIssues,
  getIssueById,
  updateIssueStatus,
  getSubscription,
  getStreamerTier,
  createSubscription,
  cancelSubscription,
  expireSubscriptions,
  ensureFreeSubscriptions,
  createTransaction,
  getRevenueStats,
  getRecentTransactions,
  getMonthlyRevenue,
  getSubscriptionsByTier,
  createDiscountCode,
  getDiscountCode,
  useDiscountCode,
  getAllDiscountCodes,
  toggleDiscountCode,
  getUsersOverTime,
  getNotificationsOverTime,
  getServersOverTime,
  getWatchersForChannelWithFeatures,
  getChannelMilestones,
  updateChannelMilestones,
  getWeeklyDigestState,
  updateWeeklyDigestDate,
  getGuildsWithWeeklyHighlights,
  getDigestChannelForGuild,
  clearStreamSession,
  getStreamerStats,
  getStreamerNotificationsOverTime,
  getStreamerNotificationsByType,
  getGuildNotificationStats,
  getGuildStatsByPeriod,
  getGuildNotificationsOverTime,
  getGuildNotificationsByTypeOverTime,
  updateWatchedChannelProfileImage,
  updateWatchedChannel,
  updateWatchedYoutubeChannel,
};
