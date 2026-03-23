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
`);

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
    sub_sync_enabled = ?
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
  INSERT OR IGNORE INTO watched_channels (guild_id, streamer_id, twitch_username, live_channel_id, clips_channel_id, notify_live, notify_clips)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
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
    last_clip_created_at = COALESCE(?, last_clip_created_at)
  WHERE twitch_username = ?
`);

function addWatchedChannel(guildId, streamerId, twitchUsername, liveChannelId, clipsChannelId, notifyLive, notifyClips) {
  _addWatchedChannel.run(guildId, streamerId, twitchUsername.toLowerCase(), liveChannelId || null, clipsChannelId || null, notifyLive ? 1 : 0, notifyClips ? 1 : 0);
  // Ensure channel_state row exists
  _upsertChannelState.run(twitchUsername.toLowerCase());
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
    twitchUsername.toLowerCase()
  );
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
const _updateYoutubeChannelState = db.prepare(`
  UPDATE youtube_channel_state SET
    known_video_ids = COALESCE(?, known_video_ids),
    is_live = COALESCE(?, is_live),
    live_video_id = COALESCE(?, live_video_id)
  WHERE youtube_channel_id = ?
`);

function addWatchedYoutubeChannel(guildId, streamerId, ytChannelId, ytChannelName, videosChannelId, liveChannelId) {
  _addWatchedYoutubeChannel.run(guildId, streamerId, ytChannelId, ytChannelName || null, videosChannelId || null, liveChannelId || null, videosChannelId ? 1 : 0, liveChannelId ? 1 : 0);
  _upsertYoutubeChannelState.run(ytChannelId);
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
};
