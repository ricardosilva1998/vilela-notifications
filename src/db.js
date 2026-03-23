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

// --- Schema ---

db.exec(`
  CREATE TABLE IF NOT EXISTS streamers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    twitch_user_id TEXT UNIQUE NOT NULL,
    twitch_username TEXT NOT NULL,
    twitch_display_name TEXT,
    broadcaster_access_token TEXT,
    broadcaster_refresh_token TEXT,
    broadcaster_token_expires_at INTEGER DEFAULT 0,
    youtube_channel_id TEXT,
    youtube_api_key TEXT,
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
`);

// --- Streamers ---

const _getStreamerByTwitchId = db.prepare('SELECT * FROM streamers WHERE twitch_user_id = ?');
const _getStreamerById = db.prepare('SELECT * FROM streamers WHERE id = ?');
const _getAllStreamers = db.prepare('SELECT * FROM streamers');
const _upsertStreamer = db.prepare(`
  INSERT INTO streamers (twitch_user_id, twitch_username, twitch_display_name)
  VALUES (?, ?, ?)
  ON CONFLICT(twitch_user_id) DO UPDATE SET
    twitch_username = excluded.twitch_username,
    twitch_display_name = excluded.twitch_display_name
  RETURNING *
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

function getStreamerByTwitchId(twitchUserId) {
  return _getStreamerByTwitchId.get(twitchUserId);
}

function getStreamerById(id) {
  return _getStreamerById.get(id);
}

function getAllStreamers() {
  return _getAllStreamers.all();
}

function upsertStreamer(twitchUserId, twitchUsername, twitchDisplayName) {
  return _upsertStreamer.get(twitchUserId, twitchUsername, twitchDisplayName || twitchUsername);
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
  _upsertPollerState.run(streamerId); // ensure row exists
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

// --- Migration from old env/JSON files ---

function migrateFromLegacy() {
  const oldStatePath = path.join(__dirname, '..', 'data', 'state.json');
  const oldAuthPath = path.join(__dirname, '..', 'data', 'auth.json');
  const oldLinksPath = path.join(__dirname, '..', 'data', 'links.json');

  // Only migrate if TWITCH_USERNAME env var exists and no streamers in DB yet
  const twitchUsername = process.env.TWITCH_USERNAME;
  if (!twitchUsername) return;
  if (getAllStreamers().length > 0) return;

  console.log('[DB] Migrating from legacy env vars...');

  const broadcasterId = process.env.TWITCH_BROADCASTER_ID || null;
  const streamer = upsertStreamer(broadcasterId || 'legacy', twitchUsername, twitchUsername);

  // Import YouTube config
  if (process.env.YOUTUBE_CHANNEL_ID) {
    updateStreamerYoutube(streamer.id, process.env.YOUTUBE_CHANNEL_ID, process.env.YOUTUBE_API_KEY);
  }

  // Import broadcaster tokens from auth.json
  try {
    const auth = JSON.parse(fs.readFileSync(oldAuthPath, 'utf-8'));
    if (auth.broadcasterAccessToken) {
      updateStreamerBroadcasterTokens(
        streamer.id,
        auth.broadcasterAccessToken,
        auth.broadcasterRefreshToken,
        auth.broadcasterTokenExpiresAt
      );
    }
  } catch {}

  // Import poller state
  try {
    const state = JSON.parse(fs.readFileSync(oldStatePath, 'utf-8'));
    _upsertPollerState.run(streamer.id);
    updatePollerState(streamer.id, {
      twitch_is_live: state.twitchIsLive ? 1 : 0,
      twitch_broadcaster_id: state.twitchBroadcasterId || broadcasterId,
      last_clip_created_at: state.lastClipCreatedAt,
      known_video_ids: JSON.stringify(state.knownVideoIds || []),
      youtube_is_live: state.youtubeIsLive ? 1 : 0,
      youtube_live_video_id: state.youtubeLiveVideoId,
    });
  } catch {}

  // Create guild records from env var channel IDs
  const twitchLiveChannel = process.env.DISCORD_TWITCH_LIVE_CHANNEL_ID;
  const twitchClipsChannel = process.env.DISCORD_TWITCH_CLIPS_CHANNEL_ID;
  const welcomeChannel = process.env.DISCORD_WELCOME_CHANNEL_ID;
  const subRoleId = process.env.DISCORD_SUB_ROLE_ID;

  // We don't know the guild ID from env vars alone, so we'll skip guild migration
  // The streamer will need to re-add the bot via the dashboard
  console.log('[DB] Legacy migration complete. Streamer record created.');
  console.log('[DB] Guild configuration must be done via the dashboard.');

  // Import user links
  try {
    const links = JSON.parse(fs.readFileSync(oldLinksPath, 'utf-8'));
    for (const [discordId, data] of Object.entries(links)) {
      linkUser(streamer.id, discordId, data.twitchUserId, data.twitchUsername);
    }
  } catch {}
}

// Run migration on module load
migrateFromLegacy();

module.exports = {
  db,
  // Streamers
  getStreamerByTwitchId,
  getStreamerById,
  getAllStreamers,
  upsertStreamer,
  updateStreamerBroadcasterTokens,
  updateStreamerYoutube,
  // Guilds
  getGuildsForStreamer,
  getGuildConfig,
  getGuildConfigsByGuildId,
  upsertGuild,
  updateGuildConfig,
  deleteGuild,
  // Poller State
  getPollerState,
  updatePollerState,
  // User Links
  getLinkedUsers,
  linkUser,
  // Sessions
  createSession,
  getSession,
  deleteSession,
  cleanExpiredSessions,
};
