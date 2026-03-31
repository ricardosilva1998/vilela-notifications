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

// Migration 9: add peak_viewers to channel_state
try {
  const cols = db.prepare("PRAGMA table_info(channel_state)").all();
  if (cols.length > 0 && !cols.find((c) => c.name === 'peak_viewers')) {
    db.exec('ALTER TABLE channel_state ADD COLUMN peak_viewers INTEGER DEFAULT 0');
    console.log('[DB] Added peak_viewers column to channel_state');
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

// Migration 7: add profile_image_url to watched_youtube_channels
try {
  const cols = db.prepare("PRAGMA table_info(watched_youtube_channels)").all();
  if (cols.length > 0 && !cols.find((c) => c.name === 'profile_image_url')) {
    db.exec('ALTER TABLE watched_youtube_channels ADD COLUMN profile_image_url TEXT');
    console.log('[DB] Added profile_image_url column to watched_youtube_channels');
  }
} catch {}

// Migration 8: add social media toggle columns to guilds
try {
  const cols = db.prepare("PRAGMA table_info(guilds)").all();
  if (cols.length > 0 && !cols.find((c) => c.name === 'instagram_enabled')) {
    db.exec('ALTER TABLE guilds ADD COLUMN instagram_enabled INTEGER DEFAULT 0');
    db.exec('ALTER TABLE guilds ADD COLUMN tiktok_enabled INTEGER DEFAULT 0');
    db.exec('ALTER TABLE guilds ADD COLUMN twitter_enabled INTEGER DEFAULT 0');
    console.log('[DB] Added social media toggle columns to guilds');
  }
} catch {}

// Migration 10: add iracing_enabled to guilds
try {
  const cols = db.prepare("PRAGMA table_info(guilds)").all();
  if (cols.length > 0 && !cols.find((c) => c.name === 'iracing_enabled')) {
    db.exec('ALTER TABLE guilds ADD COLUMN iracing_enabled INTEGER DEFAULT 0');
    console.log('[DB] Added iracing_enabled column to guilds');
  }
} catch {}

// Migration: Add overlay notification columns to streamers
{
  const cols = db.pragma('table_info(streamers)').map(c => c.name);
  if (!cols.includes('overlay_token')) {
    db.exec(`
      ALTER TABLE streamers ADD COLUMN overlay_token TEXT;
      ALTER TABLE streamers ADD COLUMN overlay_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN streamelements_jwt TEXT;
      ALTER TABLE streamers ADD COLUMN overlay_follow_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN overlay_sub_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN overlay_bits_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN overlay_donation_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN overlay_follow_duration INTEGER DEFAULT 5;
      ALTER TABLE streamers ADD COLUMN overlay_sub_duration INTEGER DEFAULT 7;
      ALTER TABLE streamers ADD COLUMN overlay_bits_duration INTEGER DEFAULT 6;
      ALTER TABLE streamers ADD COLUMN overlay_donation_duration INTEGER DEFAULT 6;
      ALTER TABLE streamers ADD COLUMN overlay_volume REAL DEFAULT 0.8;
      ALTER TABLE streamers ADD COLUMN broadcaster_scopes TEXT;
    `);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_streamers_overlay_token ON streamers(overlay_token) WHERE overlay_token IS NOT NULL');
    console.log('[DB] Added overlay notification columns to streamers');
  }
}

// Migration: Add chatbot columns to streamers
{
  const cols = db.pragma('table_info(streamers)').map(c => c.name);
  if (!cols.includes('bot_access_token')) {
    db.exec(`
      ALTER TABLE streamers ADD COLUMN bot_access_token TEXT;
      ALTER TABLE streamers ADD COLUMN bot_refresh_token TEXT;
      ALTER TABLE streamers ADD COLUMN bot_token_expires_at INTEGER;
      ALTER TABLE streamers ADD COLUMN bot_username TEXT;
      ALTER TABLE streamers ADD COLUMN chatbot_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN chat_follow_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN chat_sub_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN chat_giftsub_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN chat_bits_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN chat_donation_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN chat_raid_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN chat_follow_template TEXT DEFAULT 'Welcome to the pit crew, {username}! 🏎️';
      ALTER TABLE streamers ADD COLUMN chat_sub_template TEXT DEFAULT '{username} just joined the podium! Tier {tier} for {months} months! 🏆';
      ALTER TABLE streamers ADD COLUMN chat_giftsub_template TEXT DEFAULT '{username} gifted {amount} subs! What a sponsor! 🎁';
      ALTER TABLE streamers ADD COLUMN chat_bits_template TEXT DEFAULT '{username} fueled up {amount} bits! 🔥';
      ALTER TABLE streamers ADD COLUMN chat_donation_template TEXT DEFAULT '{username} sponsored the team with {amount}! 💰';
      ALTER TABLE streamers ADD COLUMN chat_raid_template TEXT DEFAULT '{username} is raiding with {viewers} viewers! Welcome racers! 🏁';
    `);
    console.log('[DB] Added chatbot columns to streamers');
  }
}

// Migration: Create chat_commands table
{
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      streamer_id INTEGER NOT NULL,
      command TEXT NOT NULL,
      response TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      cooldown INTEGER DEFAULT 5,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (streamer_id) REFERENCES streamers(id),
      UNIQUE(streamer_id, command)
    )
  `);
}

// Migration: Add overlay raid columns
{
  const cols = db.pragma('table_info(streamers)').map(c => c.name);
  if (!cols.includes('overlay_raid_enabled')) {
    db.exec(`
      ALTER TABLE streamers ADD COLUMN overlay_raid_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN overlay_raid_duration INTEGER DEFAULT 7;
    `);
    console.log('[DB] Added overlay raid columns');
  }
}

// Migration: Add YouTube chatbot/overlay columns to streamers
{
  const cols = db.pragma('table_info(streamers)').map(c => c.name);
  if (!cols.includes('yt_chatbot_enabled')) {
    db.exec(`
      ALTER TABLE streamers ADD COLUMN yt_chatbot_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN yt_chat_superchat_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN yt_chat_member_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN yt_chat_giftmember_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN yt_chat_superchat_template TEXT DEFAULT '{username} sent a Super Chat of {amount}! {message}';
      ALTER TABLE streamers ADD COLUMN yt_chat_member_template TEXT DEFAULT 'Welcome to the team, {username}! Thanks for becoming a member!';
      ALTER TABLE streamers ADD COLUMN yt_chat_giftmember_template TEXT DEFAULT '{username} gifted {amount} memberships! What a legend!';
      ALTER TABLE streamers ADD COLUMN yt_overlay_superchat_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN yt_overlay_member_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN yt_overlay_giftmember_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN yt_overlay_superchat_duration INTEGER DEFAULT 6;
      ALTER TABLE streamers ADD COLUMN yt_overlay_member_duration INTEGER DEFAULT 5;
      ALTER TABLE streamers ADD COLUMN yt_overlay_giftmember_duration INTEGER DEFAULT 6;
    `);
    console.log('[DB] Added YouTube chatbot/overlay columns to streamers');
  }
}

// Migration: Add YouTube OAuth columns to streamers
{
  const cols = db.pragma('table_info(streamers)').map(c => c.name);
  if (!cols.includes('yt_access_token')) {
    db.exec(`
      ALTER TABLE streamers ADD COLUMN yt_access_token TEXT;
      ALTER TABLE streamers ADD COLUMN yt_refresh_token TEXT;
      ALTER TABLE streamers ADD COLUMN yt_token_expires_at INTEGER;
      ALTER TABLE streamers ADD COLUMN yt_channel_name TEXT;
    `);
    console.log('[DB] Added YouTube OAuth columns to streamers');
  }
}

// Migration: Add Spotify OAuth columns to streamers
{
  const cols = db.pragma('table_info(streamers)').map(c => c.name);
  if (!cols.includes('spotify_access_token')) {
    db.exec(`
      ALTER TABLE streamers ADD COLUMN spotify_access_token TEXT;
      ALTER TABLE streamers ADD COLUMN spotify_refresh_token TEXT;
      ALTER TABLE streamers ADD COLUMN spotify_token_expires_at INTEGER;
    `);
    console.log('[DB] Added Spotify columns to streamers');
  }
}

// Migration: Add donation page columns to streamers
{
  const cols = db.pragma('table_info(streamers)').map(c => c.name);
  if (!cols.includes('paypal_email')) {
    db.exec(`
      ALTER TABLE streamers ADD COLUMN paypal_email TEXT;
      ALTER TABLE streamers ADD COLUMN donation_page_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN donation_min_amount REAL DEFAULT 1.00;
      ALTER TABLE streamers ADD COLUMN donation_currency TEXT DEFAULT 'EUR';
    `);
    console.log('[DB] Added donation page columns to streamers');
  }
}

// Migration: Create overlay_designs table
db.exec(`
  CREATE TABLE IF NOT EXISTS overlay_designs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    streamer_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    bg_color TEXT DEFAULT '#1a1a3e',
    accent_color TEXT DEFAULT '#8888cc',
    border_color TEXT DEFAULT '#8888cc',
    text_color TEXT DEFAULT '#ffffff',
    font_family TEXT DEFAULT 'System Default',
    username_size INTEGER DEFAULT 24,
    event_label TEXT,
    detail_text TEXT,
    entrance_animation TEXT DEFAULT 'slideDown',
    car_animation TEXT DEFAULT 'zoomLR',
    screen_effect TEXT DEFAULT 'default',
    animation_speed REAL DEFAULT 1.0,
    card_width INTEGER DEFAULT 420,
    card_position TEXT DEFAULT 'top-center',
    card_custom_x REAL,
    card_custom_y REAL,
    border_radius INTEGER DEFAULT 16,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (streamer_id) REFERENCES streamers(id),
    UNIQUE(streamer_id, event_type)
  )
`);

// Migration: Add custom x/y position to overlay_designs
{
  const cols = db.pragma('table_info(overlay_designs)').map(c => c.name);
  if (!cols.includes('card_custom_x')) {
    db.exec(`
      ALTER TABLE overlay_designs ADD COLUMN card_custom_x REAL;
      ALTER TABLE overlay_designs ADD COLUMN card_custom_y REAL;
    `);
    console.log('[DB] Added custom x/y position to overlay_designs');
  }
}

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

  CREATE TABLE IF NOT EXISTS watched_instagram_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    streamer_id INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    instagram_username TEXT NOT NULL,
    display_name TEXT,
    profile_image_url TEXT,
    notify_channel_id TEXT,
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(guild_id, streamer_id, instagram_username)
  );

  CREATE TABLE IF NOT EXISTS watched_tiktok_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    streamer_id INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    tiktok_username TEXT NOT NULL,
    display_name TEXT,
    profile_image_url TEXT,
    notify_channel_id TEXT,
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(guild_id, streamer_id, tiktok_username)
  );

  CREATE TABLE IF NOT EXISTS watched_twitter_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    streamer_id INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    twitter_username TEXT NOT NULL,
    display_name TEXT,
    profile_image_url TEXT,
    notify_channel_id TEXT,
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(guild_id, streamer_id, twitter_username)
  );

  CREATE TABLE IF NOT EXISTS instagram_account_state (
    instagram_username TEXT PRIMARY KEY,
    known_post_ids TEXT DEFAULT '[]',
    last_checked TEXT,
    available INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS tiktok_account_state (
    tiktok_username TEXT PRIMARY KEY,
    known_video_ids TEXT DEFAULT '[]',
    last_checked TEXT,
    available INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS twitter_account_state (
    twitter_username TEXT PRIMARY KEY,
    known_tweet_ids TEXT DEFAULT '[]',
    last_checked TEXT,
    available INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    streamer_id INTEGER REFERENCES streamers(id) ON DELETE SET NULL,
    discord_username TEXT,
    rating INTEGER NOT NULL,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'new',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS watched_iracing_drivers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    streamer_id INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL,
    driver_name TEXT,
    notify_channel_id TEXT,
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(guild_id, streamer_id, customer_id)
  );

  CREATE TABLE IF NOT EXISTS iracing_driver_state (
    customer_id TEXT PRIMARY KEY,
    last_checked TEXT,
    irating_road INTEGER DEFAULT 0,
    irating_oval INTEGER DEFAULT 0,
    irating_dirt_road INTEGER DEFAULT 0,
    irating_dirt_oval INTEGER DEFAULT 0,
    safety_rating_road REAL DEFAULT 0,
    safety_rating_oval REAL DEFAULT 0,
    safety_rating_dirt_road REAL DEFAULT 0,
    safety_rating_dirt_oval REAL DEFAULT 0,
    license_class TEXT
  );

  CREATE TABLE IF NOT EXISTS iracing_race_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subsession_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    driver_name TEXT,
    series_name TEXT,
    track_name TEXT,
    car_name TEXT,
    category TEXT,
    finish_position INTEGER,
    starting_position INTEGER,
    incidents INTEGER,
    irating_change INTEGER,
    new_irating INTEGER,
    laps_completed INTEGER,
    fastest_lap_time REAL,
    qualifying_time REAL,
    field_size INTEGER,
    strength_of_field INTEGER,
    race_date TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(subsession_id, customer_id)
  );

  CREATE INDEX IF NOT EXISTS idx_iracing_cache_qualifying ON iracing_race_cache(category, qualifying_time);
  CREATE INDEX IF NOT EXISTS idx_iracing_cache_customer ON iracing_race_cache(customer_id, race_date DESC);

  CREATE TABLE IF NOT EXISTS custom_overlays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    streamer_id INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('scene','bar','custom-alert')),
    name TEXT NOT NULL,
    template TEXT NOT NULL,
    chat_command TEXT,
    config TEXT NOT NULL DEFAULT '{}',
    is_active INTEGER NOT NULL DEFAULT 0,
    always_on INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (streamer_id) REFERENCES streamers(id),
    UNIQUE(streamer_id, chat_command)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS moderation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    streamer_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    user_id TEXT,
    action TEXT NOT NULL,
    reason TEXT,
    message_text TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (streamer_id) REFERENCES streamers(id) ON DELETE CASCADE
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_modlog_streamer_date ON moderation_log(streamer_id, created_at)`);

db.exec(`
  CREATE TABLE IF NOT EXISTS overlay_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    streamer_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    username TEXT,
    data TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (streamer_id) REFERENCES streamers(id) ON DELETE CASCADE
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_overlay_events_streamer_date ON overlay_events(streamer_id, created_at)`);

// --- Seed: ensure enterprise subscriptions for specific users ---
const _enterpriseUsers = ['Ricardo Apple', 'andre_vilela'];
for (const name of _enterpriseUsers) {
  try {
    const streamer = db.prepare("SELECT id FROM streamers WHERE discord_display_name = ? OR discord_username = ?").get(name, name);
    if (streamer) {
      const hasSub = db.prepare("SELECT id FROM subscriptions WHERE streamer_id = ? AND tier = 'enterprise' AND status = 'active'").get(streamer.id);
      if (!hasSub) {
        db.prepare("UPDATE subscriptions SET status = 'cancelled', cancelled_at = datetime('now') WHERE streamer_id = ? AND status = 'active'").run(streamer.id);
        db.prepare("INSERT INTO subscriptions (streamer_id, tier, status) VALUES (?, 'enterprise', 'active')").run(streamer.id);
        console.log(`[DB] Granted enterprise subscription to ${name}`);
      }
    }
  } catch {}
}

// --- Admin access control ---
const ADMIN_USERS = ['Ricardo Apple', 'r1c4rd098'];

function isAdmin(streamerId) {
  const streamer = _getStreamerById.get(streamerId);
  if (!streamer) return false;
  return ADMIN_USERS.some(name =>
    streamer.discord_display_name === name || streamer.discord_username === name
  );
}

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
    weekly_highlights_enabled = ?,
    instagram_enabled = ?,
    tiktok_enabled = ?,
    twitter_enabled = ?,
    iracing_enabled = ?
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
    config.instagram_enabled ? 1 : 0,
    config.tiktok_enabled ? 1 : 0,
    config.twitter_enabled ? 1 : 0,
    config.iracing_enabled ? 1 : 0,
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
    COALESCE(SUM(CASE WHEN type = 'instagram_post' THEN 1 ELSE 0 END), 0) AS instagram_post_count,
    COALESCE(SUM(CASE WHEN type = 'tiktok_video' THEN 1 ELSE 0 END), 0) AS tiktok_video_count,
    COALESCE(SUM(CASE WHEN type = 'twitter_tweet' THEN 1 ELSE 0 END), 0) AS twitter_tweet_count,
    COALESCE(SUM(CASE WHEN type = 'iracing_result' THEN 1 ELSE 0 END), 0) AS iracing_result_count,
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
    COALESCE(SUM(CASE WHEN type = 'instagram_post' THEN 1 ELSE 0 END), 0) AS instagram_post_count,
    COALESCE(SUM(CASE WHEN type = 'tiktok_video' THEN 1 ELSE 0 END), 0) AS tiktok_video_count,
    COALESCE(SUM(CASE WHEN type = 'twitter_tweet' THEN 1 ELSE 0 END), 0) AS twitter_tweet_count,
    COALESCE(SUM(CASE WHEN type = 'iracing_result' THEN 1 ELSE 0 END), 0) AS iracing_result_count,
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
    COALESCE(SUM(CASE WHEN type = 'instagram_post' THEN 1 ELSE 0 END), 0) AS instagram_post_count,
    COALESCE(SUM(CASE WHEN type = 'tiktok_video' THEN 1 ELSE 0 END), 0) AS tiktok_video_count,
    COALESCE(SUM(CASE WHEN type = 'twitter_tweet' THEN 1 ELSE 0 END), 0) AS twitter_tweet_count,
    COALESCE(SUM(CASE WHEN type = 'iracing_result' THEN 1 ELSE 0 END), 0) AS iracing_result_count,
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
    stream_started_at = COALESCE(?, stream_started_at),
    peak_viewers = CASE WHEN ? > COALESCE(peak_viewers, 0) THEN ? ELSE peak_viewers END
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
  const peakViewers = updates.peak_viewers ?? 0;
  _updateChannelState.run(
    updates.twitch_broadcaster_id ?? null,
    updates.is_live ?? null,
    updates.last_clip_created_at ?? null,
    updates.stream_title ?? null,
    updates.stream_category ?? null,
    updates.stream_thumbnail_url ?? null,
    updates.stream_started_at ?? null,
    peakViewers, peakViewers, // twice for the CASE WHEN comparison
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
    stream_started_at = NULL,
    peak_viewers = 0
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

const _updateWatchedYoutubeChannelInfo = db.prepare(`
  UPDATE watched_youtube_channels SET profile_image_url = ?, youtube_channel_name = COALESCE(?, youtube_channel_name)
  WHERE id = ?
`);

function updateWatchedYoutubeChannelInfo(id, profileImageUrl, channelName) {
  _updateWatchedYoutubeChannelInfo.run(profileImageUrl || null, channelName || null, id);
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

// --- Watched Instagram Accounts ---

const _addWatchedInstagram = db.prepare(`
  INSERT OR IGNORE INTO watched_instagram_accounts (guild_id, streamer_id, instagram_username, display_name, profile_image_url, notify_channel_id)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const _removeWatchedInstagram = db.prepare('DELETE FROM watched_instagram_accounts WHERE id = ? AND streamer_id = ?');
const _getWatchedInstagramForGuild = db.prepare('SELECT * FROM watched_instagram_accounts WHERE guild_id = ? AND streamer_id = ?');
const _getAllUniqueWatchedInstagram = db.prepare('SELECT DISTINCT instagram_username FROM watched_instagram_accounts WHERE enabled = 1');
const _getInstagramWatchersForAccount = db.prepare(`
  SELECT wia.*, s.id AS owner_id, s.enabled AS streamer_enabled
  FROM watched_instagram_accounts wia
  JOIN streamers s ON wia.streamer_id = s.id
  WHERE wia.instagram_username = ? AND wia.enabled = 1 AND s.enabled = 1
`);
const _getInstagramState = db.prepare('SELECT * FROM instagram_account_state WHERE instagram_username = ?');
const _upsertInstagramState = db.prepare(`
  INSERT INTO instagram_account_state (instagram_username) VALUES (?)
  ON CONFLICT(instagram_username) DO NOTHING
`);
const _upsertInstagramStateWithPosts = db.prepare(`
  INSERT INTO instagram_account_state (instagram_username, known_post_ids) VALUES (?, ?)
  ON CONFLICT(instagram_username) DO NOTHING
`);
const _updateInstagramState = db.prepare(`
  UPDATE instagram_account_state SET
    known_post_ids = COALESCE(?, known_post_ids),
    last_checked = COALESCE(?, last_checked),
    available = COALESCE(?, available)
  WHERE instagram_username = ?
`);
const _updateWatchedInstagramInfo = db.prepare(`
  UPDATE watched_instagram_accounts SET profile_image_url = ?, display_name = COALESCE(?, display_name)
  WHERE id = ?
`);
const _updateWatchedInstagramChannel = db.prepare(`
  UPDATE watched_instagram_accounts SET notify_channel_id = ?
  WHERE id = ? AND streamer_id = ?
`);

function addWatchedInstagram(guildId, streamerId, instagramUsername, displayName, profileImageUrl, notifyChannelId, knownPostIds) {
  _addWatchedInstagram.run(guildId, streamerId, instagramUsername.toLowerCase(), displayName || null, profileImageUrl || null, notifyChannelId || null);
  if (knownPostIds) {
    _upsertInstagramStateWithPosts.run(instagramUsername.toLowerCase(), knownPostIds);
  } else {
    _upsertInstagramState.run(instagramUsername.toLowerCase());
  }
}

function removeWatchedInstagram(id, streamerId) {
  _removeWatchedInstagram.run(id, streamerId);
}

function getWatchedInstagramForGuild(guildId, streamerId) {
  return _getWatchedInstagramForGuild.all(guildId, streamerId);
}

function getAllUniqueWatchedInstagram() {
  return _getAllUniqueWatchedInstagram.all();
}

function getInstagramWatchersForAccount(instagramUsername) {
  return _getInstagramWatchersForAccount.all(instagramUsername.toLowerCase());
}

function getInstagramState(instagramUsername) {
  _upsertInstagramState.run(instagramUsername.toLowerCase());
  return _getInstagramState.get(instagramUsername.toLowerCase());
}

function updateInstagramState(instagramUsername, updates) {
  _updateInstagramState.run(
    updates.known_post_ids ?? null,
    updates.last_checked ?? null,
    updates.available ?? null,
    instagramUsername.toLowerCase()
  );
}

function updateWatchedInstagramInfo(id, profileImageUrl, displayName) {
  _updateWatchedInstagramInfo.run(profileImageUrl || null, displayName || null, id);
}

function updateWatchedInstagramChannel(id, streamerId, notifyChannelId) {
  _updateWatchedInstagramChannel.run(notifyChannelId || null, id, streamerId);
}

// --- Watched TikTok Accounts ---

const _addWatchedTikTok = db.prepare(`
  INSERT OR IGNORE INTO watched_tiktok_accounts (guild_id, streamer_id, tiktok_username, display_name, profile_image_url, notify_channel_id)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const _removeWatchedTikTok = db.prepare('DELETE FROM watched_tiktok_accounts WHERE id = ? AND streamer_id = ?');
const _getWatchedTikTokForGuild = db.prepare('SELECT * FROM watched_tiktok_accounts WHERE guild_id = ? AND streamer_id = ?');
const _getAllUniqueWatchedTikTok = db.prepare('SELECT DISTINCT tiktok_username FROM watched_tiktok_accounts WHERE enabled = 1');
const _getTikTokWatchersForAccount = db.prepare(`
  SELECT wta.*, s.id AS owner_id, s.enabled AS streamer_enabled
  FROM watched_tiktok_accounts wta
  JOIN streamers s ON wta.streamer_id = s.id
  WHERE wta.tiktok_username = ? AND wta.enabled = 1 AND s.enabled = 1
`);
const _getTikTokState = db.prepare('SELECT * FROM tiktok_account_state WHERE tiktok_username = ?');
const _upsertTikTokState = db.prepare(`
  INSERT INTO tiktok_account_state (tiktok_username) VALUES (?)
  ON CONFLICT(tiktok_username) DO NOTHING
`);
const _upsertTikTokStateWithVideos = db.prepare(`
  INSERT INTO tiktok_account_state (tiktok_username, known_video_ids) VALUES (?, ?)
  ON CONFLICT(tiktok_username) DO NOTHING
`);
const _updateTikTokState = db.prepare(`
  UPDATE tiktok_account_state SET
    known_video_ids = COALESCE(?, known_video_ids),
    last_checked = COALESCE(?, last_checked),
    available = COALESCE(?, available)
  WHERE tiktok_username = ?
`);
const _updateWatchedTikTokInfo = db.prepare(`
  UPDATE watched_tiktok_accounts SET profile_image_url = ?, display_name = COALESCE(?, display_name)
  WHERE id = ?
`);
const _updateWatchedTikTokChannel = db.prepare(`
  UPDATE watched_tiktok_accounts SET notify_channel_id = ?
  WHERE id = ? AND streamer_id = ?
`);

function addWatchedTikTok(guildId, streamerId, tiktokUsername, displayName, profileImageUrl, notifyChannelId, knownVideoIds) {
  _addWatchedTikTok.run(guildId, streamerId, tiktokUsername.toLowerCase(), displayName || null, profileImageUrl || null, notifyChannelId || null);
  if (knownVideoIds) {
    _upsertTikTokStateWithVideos.run(tiktokUsername.toLowerCase(), knownVideoIds);
  } else {
    _upsertTikTokState.run(tiktokUsername.toLowerCase());
  }
}

function removeWatchedTikTok(id, streamerId) {
  _removeWatchedTikTok.run(id, streamerId);
}

function getWatchedTikTokForGuild(guildId, streamerId) {
  return _getWatchedTikTokForGuild.all(guildId, streamerId);
}

function getAllUniqueWatchedTikTok() {
  return _getAllUniqueWatchedTikTok.all();
}

function getTikTokWatchersForAccount(tiktokUsername) {
  return _getTikTokWatchersForAccount.all(tiktokUsername.toLowerCase());
}

function getTikTokState(tiktokUsername) {
  _upsertTikTokState.run(tiktokUsername.toLowerCase());
  return _getTikTokState.get(tiktokUsername.toLowerCase());
}

function updateTikTokState(tiktokUsername, updates) {
  _updateTikTokState.run(
    updates.known_video_ids ?? null,
    updates.last_checked ?? null,
    updates.available ?? null,
    tiktokUsername.toLowerCase()
  );
}

function updateWatchedTikTokInfo(id, profileImageUrl, displayName) {
  _updateWatchedTikTokInfo.run(profileImageUrl || null, displayName || null, id);
}

function updateWatchedTikTokChannel(id, streamerId, notifyChannelId) {
  _updateWatchedTikTokChannel.run(notifyChannelId || null, id, streamerId);
}

// --- Watched Twitter Accounts ---

const _addWatchedTwitter = db.prepare(`
  INSERT OR IGNORE INTO watched_twitter_accounts (guild_id, streamer_id, twitter_username, display_name, profile_image_url, notify_channel_id)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const _removeWatchedTwitter = db.prepare('DELETE FROM watched_twitter_accounts WHERE id = ? AND streamer_id = ?');
const _getWatchedTwitterForGuild = db.prepare('SELECT * FROM watched_twitter_accounts WHERE guild_id = ? AND streamer_id = ?');
const _getAllUniqueWatchedTwitter = db.prepare('SELECT DISTINCT twitter_username FROM watched_twitter_accounts WHERE enabled = 1');
const _getTwitterWatchersForAccount = db.prepare(`
  SELECT wta.*, s.id AS owner_id, s.enabled AS streamer_enabled
  FROM watched_twitter_accounts wta
  JOIN streamers s ON wta.streamer_id = s.id
  WHERE wta.twitter_username = ? AND wta.enabled = 1 AND s.enabled = 1
`);
const _getTwitterState = db.prepare('SELECT * FROM twitter_account_state WHERE twitter_username = ?');
const _upsertTwitterState = db.prepare(`
  INSERT INTO twitter_account_state (twitter_username) VALUES (?)
  ON CONFLICT(twitter_username) DO NOTHING
`);
const _upsertTwitterStateWithTweets = db.prepare(`
  INSERT INTO twitter_account_state (twitter_username, known_tweet_ids) VALUES (?, ?)
  ON CONFLICT(twitter_username) DO NOTHING
`);
const _updateTwitterState = db.prepare(`
  UPDATE twitter_account_state SET
    known_tweet_ids = COALESCE(?, known_tweet_ids),
    last_checked = COALESCE(?, last_checked),
    available = COALESCE(?, available)
  WHERE twitter_username = ?
`);
const _updateWatchedTwitterInfo = db.prepare(`
  UPDATE watched_twitter_accounts SET profile_image_url = ?, display_name = COALESCE(?, display_name)
  WHERE id = ?
`);
const _updateWatchedTwitterChannel = db.prepare(`
  UPDATE watched_twitter_accounts SET notify_channel_id = ?
  WHERE id = ? AND streamer_id = ?
`);

function addWatchedTwitter(guildId, streamerId, twitterUsername, displayName, profileImageUrl, notifyChannelId, knownTweetIds) {
  _addWatchedTwitter.run(guildId, streamerId, twitterUsername.toLowerCase(), displayName || null, profileImageUrl || null, notifyChannelId || null);
  if (knownTweetIds) {
    _upsertTwitterStateWithTweets.run(twitterUsername.toLowerCase(), knownTweetIds);
  } else {
    _upsertTwitterState.run(twitterUsername.toLowerCase());
  }
}

function removeWatchedTwitter(id, streamerId) {
  _removeWatchedTwitter.run(id, streamerId);
}

function getWatchedTwitterForGuild(guildId, streamerId) {
  return _getWatchedTwitterForGuild.all(guildId, streamerId);
}

function getAllUniqueWatchedTwitter() {
  return _getAllUniqueWatchedTwitter.all();
}

function getTwitterWatchersForAccount(twitterUsername) {
  return _getTwitterWatchersForAccount.all(twitterUsername.toLowerCase());
}

function getTwitterState(twitterUsername) {
  _upsertTwitterState.run(twitterUsername.toLowerCase());
  return _getTwitterState.get(twitterUsername.toLowerCase());
}

function updateTwitterState(twitterUsername, updates) {
  _updateTwitterState.run(
    updates.known_tweet_ids ?? null,
    updates.last_checked ?? null,
    updates.available ?? null,
    twitterUsername.toLowerCase()
  );
}

function updateWatchedTwitterInfo(id, profileImageUrl, displayName) {
  _updateWatchedTwitterInfo.run(profileImageUrl || null, displayName || null, id);
}

function updateWatchedTwitterChannel(id, streamerId, notifyChannelId) {
  _updateWatchedTwitterChannel.run(notifyChannelId || null, id, streamerId);
}

// --- Watched iRacing Drivers ---

const _addWatchedIracingDriver = db.prepare(`
  INSERT OR IGNORE INTO watched_iracing_drivers (guild_id, streamer_id, customer_id, driver_name, notify_channel_id)
  VALUES (?, ?, ?, ?, ?)
`);
const _removeWatchedIracingDriver = db.prepare('DELETE FROM watched_iracing_drivers WHERE id = ? AND streamer_id = ?');
const _getWatchedIracingDriversForGuild = db.prepare('SELECT * FROM watched_iracing_drivers WHERE guild_id = ? AND streamer_id = ?');
const _getAllUniqueWatchedIracingDrivers = db.prepare('SELECT DISTINCT customer_id FROM watched_iracing_drivers WHERE enabled = 1');
const _getIracingWatchersForDriver = db.prepare(`
  SELECT wid.*, s.id AS owner_id, s.enabled AS streamer_enabled
  FROM watched_iracing_drivers wid
  JOIN streamers s ON wid.streamer_id = s.id
  WHERE wid.customer_id = ? AND wid.enabled = 1 AND s.enabled = 1
`);
const _getIracingDriverState = db.prepare('SELECT * FROM iracing_driver_state WHERE customer_id = ?');
const _upsertIracingDriverState = db.prepare(`
  INSERT INTO iracing_driver_state (customer_id) VALUES (?)
  ON CONFLICT(customer_id) DO NOTHING
`);
const _updateIracingDriverState = db.prepare(`
  UPDATE iracing_driver_state SET
    last_checked = COALESCE(?, last_checked),
    irating_road = COALESCE(?, irating_road),
    irating_oval = COALESCE(?, irating_oval),
    irating_dirt_road = COALESCE(?, irating_dirt_road),
    irating_dirt_oval = COALESCE(?, irating_dirt_oval),
    safety_rating_road = COALESCE(?, safety_rating_road),
    safety_rating_oval = COALESCE(?, safety_rating_oval),
    safety_rating_dirt_road = COALESCE(?, safety_rating_dirt_road),
    safety_rating_dirt_oval = COALESCE(?, safety_rating_dirt_oval),
    license_class = COALESCE(?, license_class)
  WHERE customer_id = ?
`);
const _upsertIracingRaceCache = db.prepare(`
  INSERT OR IGNORE INTO iracing_race_cache (subsession_id, customer_id, driver_name, series_name, track_name, car_name, category, finish_position, starting_position, incidents, irating_change, new_irating, laps_completed, fastest_lap_time, qualifying_time, field_size, strength_of_field, race_date)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const _isRaceCached = db.prepare('SELECT 1 FROM iracing_race_cache WHERE subsession_id = ? AND customer_id = ?');
const _getIracingRaceHistory = db.prepare('SELECT * FROM iracing_race_cache WHERE customer_id = ? ORDER BY race_date DESC LIMIT ?');
const _searchIracingQualifying = db.prepare('SELECT * FROM iracing_race_cache WHERE qualifying_time IS NOT NULL AND qualifying_time > 0 ORDER BY qualifying_time ASC');
const _searchIracingQualifyingByCategory = db.prepare('SELECT * FROM iracing_race_cache WHERE qualifying_time IS NOT NULL AND qualifying_time > 0 AND category = ? ORDER BY qualifying_time ASC');
const _getIracingDriverStats = db.prepare(`
  SELECT
    COUNT(*) AS race_count,
    COALESCE(SUM(CASE WHEN finish_position = 1 THEN 1 ELSE 0 END), 0) AS wins,
    ROUND(AVG(finish_position), 1) AS avg_finish,
    ROUND(AVG(incidents), 1) AS avg_incidents,
    MIN(finish_position) AS best_finish
  FROM iracing_race_cache WHERE customer_id = ?
`);
const _updateWatchedIracingDriverChannel = db.prepare(`
  UPDATE watched_iracing_drivers SET notify_channel_id = ?
  WHERE id = ? AND streamer_id = ?
`);

function addWatchedIracingDriver(guildId, streamerId, customerId, driverName, notifyChannelId) {
  _addWatchedIracingDriver.run(guildId, streamerId, customerId, driverName || null, notifyChannelId || null);
}

function removeWatchedIracingDriver(id, streamerId) {
  _removeWatchedIracingDriver.run(id, streamerId);
}

function getWatchedIracingDriversForGuild(guildId, streamerId) {
  return _getWatchedIracingDriversForGuild.all(guildId, streamerId);
}

function getAllUniqueWatchedIracingDrivers() {
  return _getAllUniqueWatchedIracingDrivers.all();
}

function getIracingWatchersForDriver(customerId) {
  return _getIracingWatchersForDriver.all(customerId);
}

function getIracingDriverState(customerId) {
  _upsertIracingDriverState.run(customerId);
  return _getIracingDriverState.get(customerId);
}

function updateIracingDriverState(customerId, updates) {
  _updateIracingDriverState.run(
    updates.last_checked ?? null,
    updates.irating_road ?? null,
    updates.irating_oval ?? null,
    updates.irating_dirt_road ?? null,
    updates.irating_dirt_oval ?? null,
    updates.safety_rating_road ?? null,
    updates.safety_rating_oval ?? null,
    updates.safety_rating_dirt_road ?? null,
    updates.safety_rating_dirt_oval ?? null,
    updates.license_class ?? null,
    customerId
  );
}

function upsertIracingRaceCache(raceData) {
  _upsertIracingRaceCache.run(
    raceData.subsession_id,
    raceData.customer_id,
    raceData.driver_name || null,
    raceData.series_name || null,
    raceData.track_name || null,
    raceData.car_name || null,
    raceData.category || null,
    raceData.finish_position ?? null,
    raceData.starting_position ?? null,
    raceData.incidents ?? null,
    raceData.irating_change ?? null,
    raceData.new_irating ?? null,
    raceData.laps_completed ?? null,
    raceData.fastest_lap_time ?? null,
    raceData.qualifying_time ?? null,
    raceData.field_size ?? null,
    raceData.strength_of_field ?? null,
    raceData.race_date || null
  );
}

function isRaceCached(subsessionId, customerId) {
  return !!_isRaceCached.get(subsessionId, customerId);
}

function getIracingRaceHistory(customerId, limit = 50) {
  return _getIracingRaceHistory.all(customerId, limit);
}

function searchIracingQualifying(category) {
  if (category) {
    return _searchIracingQualifyingByCategory.all(category);
  }
  return _searchIracingQualifying.all();
}

function getIracingDriverStats(customerId) {
  return _getIracingDriverStats.get(customerId);
}

function updateWatchedIracingDriverChannel(id, streamerId, notifyChannelId) {
  _updateWatchedIracingDriverChannel.run(notifyChannelId || null, id, streamerId);
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

// --- Feedback ---
const _createFeedback = db.prepare('INSERT INTO feedback (streamer_id, discord_username, rating, message) VALUES (?, ?, ?, ?)');
const _getAllFeedback = db.prepare('SELECT * FROM feedback ORDER BY created_at DESC');

function createFeedback(streamerId, discordUsername, rating, message) {
  return _createFeedback.run(streamerId, discordUsername, rating, message);
}

function getAllFeedback() {
  return _getAllFeedback.all();
}

// --- Overlay ---

function getStreamerByOverlayToken(token) {
  return db.prepare('SELECT * FROM streamers WHERE overlay_token = ?').get(token);
}

function getOverlayEnabledStreamers() {
  return db.prepare(`
    SELECT * FROM streamers
    WHERE overlay_enabled = 1
    AND broadcaster_access_token IS NOT NULL
    AND broadcaster_access_token != ''
  `).all();
}

const OVERLAY_COLUMNS = new Set([
  'overlay_enabled', 'overlay_follow_enabled', 'overlay_sub_enabled',
  'overlay_bits_enabled', 'overlay_donation_enabled',
  'overlay_follow_duration', 'overlay_sub_duration',
  'overlay_bits_duration', 'overlay_donation_duration',
  'overlay_volume', 'streamelements_jwt',
  'overlay_raid_enabled', 'overlay_raid_duration',
]);

function updateOverlayConfig(streamerId, config) {
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(config)) {
    if (!OVERLAY_COLUMNS.has(key)) continue; // Whitelist columns
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (fields.length === 0) return;
  values.push(streamerId);
  db.prepare(`UPDATE streamers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

function generateOverlayToken(streamerId) {
  const token = require('crypto').randomUUID();
  db.prepare('UPDATE streamers SET overlay_token = ? WHERE id = ?').run(token, streamerId);
  return token;
}

function updateBroadcasterScopes(streamerId, scopes) {
  db.prepare('UPDATE streamers SET broadcaster_scopes = ? WHERE id = ?').run(scopes, streamerId);
}

function updateBotTokens(streamerId, accessToken, refreshToken, expiresAt, username) {
  db.prepare(`
    UPDATE streamers SET bot_access_token = ?, bot_refresh_token = ?, bot_token_expires_at = ?, bot_username = ?
    WHERE id = ?
  `).run(accessToken, refreshToken, expiresAt, username, streamerId);
}

function getChatbotEnabledStreamers() {
  return db.prepare(`
    SELECT * FROM streamers
    WHERE chatbot_enabled = 1
    AND twitch_username IS NOT NULL
  `).all();
}

function getChatCommands(streamerId) {
  return db.prepare('SELECT * FROM chat_commands WHERE streamer_id = ? ORDER BY command').all(streamerId);
}

function getChatCommand(streamerId, command) {
  return db.prepare('SELECT * FROM chat_commands WHERE streamer_id = ? AND command = ? AND enabled = 1').get(streamerId, command);
}

function addChatCommand(streamerId, command, response, cooldown) {
  return db.prepare('INSERT INTO chat_commands (streamer_id, command, response, cooldown) VALUES (?, ?, ?, ?)').run(streamerId, command, response, cooldown || 5);
}

function updateChatCommand(id, streamerId, command, response, enabled, cooldown) {
  db.prepare('UPDATE chat_commands SET command = ?, response = ?, enabled = ?, cooldown = ? WHERE id = ? AND streamer_id = ?')
    .run(command, response, enabled, cooldown, id, streamerId);
}

function deleteChatCommand(id, streamerId) {
  db.prepare('DELETE FROM chat_commands WHERE id = ? AND streamer_id = ?').run(id, streamerId);
}

const CHATBOT_COLUMNS = new Set([
  'chatbot_enabled',
  'chat_follow_enabled', 'chat_sub_enabled', 'chat_giftsub_enabled',
  'chat_bits_enabled', 'chat_donation_enabled', 'chat_raid_enabled',
  'chat_follow_template', 'chat_sub_template', 'chat_giftsub_template',
  'chat_bits_template', 'chat_donation_template', 'chat_raid_template',
]);

function updateChatbotConfig(streamerId, config) {
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(config)) {
    if (!CHATBOT_COLUMNS.has(key)) continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (fields.length === 0) return;
  values.push(streamerId);
  db.prepare(`UPDATE streamers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

const YT_CHATBOT_COLUMNS = new Set([
  'yt_chatbot_enabled',
  'yt_chat_superchat_enabled', 'yt_chat_member_enabled', 'yt_chat_giftmember_enabled',
  'yt_chat_superchat_template', 'yt_chat_member_template', 'yt_chat_giftmember_template',
  'yt_overlay_superchat_enabled', 'yt_overlay_member_enabled', 'yt_overlay_giftmember_enabled',
  'yt_overlay_superchat_duration', 'yt_overlay_member_duration', 'yt_overlay_giftmember_duration',
]);

function updateYoutubeChatbotConfig(streamerId, config) {
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(config)) {
    if (!YT_CHATBOT_COLUMNS.has(key)) continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (fields.length === 0) return;
  values.push(streamerId);
  db.prepare(`UPDATE streamers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

const BUILTIN_CMD_COLUMNS = new Set([
  'cmd_followage_enabled', 'cmd_subage_enabled', 'cmd_uptime_enabled',
  'cmd_accountage_enabled', 'cmd_8ball_enabled', 'cmd_roll_enabled',
  'cmd_hug_enabled', 'cmd_slap_enabled', 'cmd_love_enabled',
  'cmd_rps_enabled', 'cmd_coinflip_enabled', 'cmd_quote_enabled', 'cmd_roast_enabled',
]);

function updateBuiltinCommands(streamerId, config) {
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(config)) {
    if (!BUILTIN_CMD_COLUMNS.has(key)) continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (fields.length === 0) return;
  values.push(streamerId);
  db.prepare(`UPDATE streamers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

const MODERATION_COLUMNS = new Set([
  'mod_banned_words_enabled', 'mod_link_protection_enabled', 'mod_link_permit_seconds',
  'mod_caps_enabled', 'mod_caps_min_length', 'mod_caps_max_percent',
  'mod_emote_spam_enabled', 'mod_emote_max_count',
  'mod_repetition_enabled', 'mod_repetition_window',
  'mod_symbol_spam_enabled', 'mod_symbol_max_percent',
  'mod_slow_mode_cmd_enabled',
  'mod_raid_protection_enabled', 'mod_raid_protection_duration',
  'mod_first_chatter_enabled',
  'mod_follow_age_enabled', 'mod_follow_age_minutes',
  'mod_action_response', 'mod_escalation_enabled',
  'mod_log_discord_enabled', 'mod_log_discord_channel_id',
  'mod_exempt_subs', 'mod_exempt_vips',
]);

function updateModerationConfig(streamerId, config) {
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(config)) {
    if (!MODERATION_COLUMNS.has(key)) continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (fields.length === 0) return;
  values.push(streamerId);
  db.prepare(`UPDATE streamers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

function getBannedWords(streamerId) {
  return db.prepare('SELECT * FROM banned_words WHERE streamer_id = ? ORDER BY created_at DESC').all(streamerId);
}

function addBannedWord(streamerId, word, isRegex) {
  return db.prepare('INSERT INTO banned_words (streamer_id, word, is_regex) VALUES (?, ?, ?)').run(streamerId, word, isRegex ? 1 : 0);
}

function deleteBannedWord(streamerId, id) {
  return db.prepare('DELETE FROM banned_words WHERE id = ? AND streamer_id = ?').run(id, streamerId);
}

function updateStreamerYoutubeTokens(streamerId, accessToken, refreshToken, expiresAt, channelName) {
  db.prepare(`
    UPDATE streamers SET yt_access_token = ?, yt_refresh_token = ?, yt_token_expires_at = ?, yt_channel_name = ?
    WHERE id = ?
  `).run(accessToken, refreshToken, expiresAt, channelName, streamerId);
}

function getYoutubeChatbotEnabledStreamers() {
  return db.prepare(`
    SELECT * FROM streamers
    WHERE yt_chatbot_enabled = 1
    AND youtube_channel_id IS NOT NULL
    AND youtube_channel_id != ''
  `).all();
}

function updateSpotifyTokens(streamerId, accessToken, refreshToken, expiresAt) {
  db.prepare('UPDATE streamers SET spotify_access_token = ?, spotify_refresh_token = ?, spotify_token_expires_at = ? WHERE id = ?')
    .run(accessToken, refreshToken, expiresAt, streamerId);
}

// ─── Overlay Designs ────────────────────────────────────────────

const DEFAULT_OVERLAY_LABELS = {
  follow:        { event_label: 'New Pit Crew Member', detail_text: 'just joined the race 🏁' },
  subscription:  { event_label: 'Podium Finish',       detail_text: '' },
  bits:          { event_label: 'Nitro Boost',         detail_text: '' },
  donation:      { event_label: 'Sponsor Alert',       detail_text: '' },
  raid:          { event_label: 'Incoming Raid',       detail_text: '' },
  yt_superchat:  { event_label: 'Super Chat',          detail_text: '' },
  yt_member:     { event_label: 'New Member',          detail_text: '' },
  yt_giftmember: { event_label: 'Gift Alert',          detail_text: '' },
};

function getOverlayDesign(streamerId, eventType) {
  return db.prepare('SELECT * FROM overlay_designs WHERE streamer_id = ? AND event_type = ?')
    .get(streamerId, eventType) || null;
}

function getAllOverlayDesigns(streamerId) {
  return db.prepare('SELECT * FROM overlay_designs WHERE streamer_id = ?')
    .all(streamerId);
}

const OVERLAY_DESIGN_COLUMNS = new Set([
  'bg_color', 'accent_color', 'border_color', 'text_color', 'font_family',
  'username_size', 'event_label', 'detail_text', 'entrance_animation',
  'car_animation', 'screen_effect', 'animation_speed', 'card_width',
  'card_position', 'border_radius',
  'bg_opacity', 'gradient_direction', 'border_thickness', 'border_opacity',
  'glow_enabled', 'glow_intensity', 'glow_color',
  'shadow_color', 'shadow_blur', 'shadow_spread', 'shadow_opacity',
]);

function saveOverlayDesign(streamerId, eventType, design) {
  const defaults = DEFAULT_OVERLAY_LABELS[eventType] || {};
  const row = {
    bg_color: design.bg_color || '#1a1a3e',
    accent_color: design.accent_color || '#8888cc',
    border_color: design.border_color || '#8888cc',
    text_color: design.text_color || '#ffffff',
    font_family: design.font_family || 'System Default',
    username_size: design.username_size != null ? design.username_size : 24,
    event_label: design.event_label != null ? design.event_label : (defaults.event_label || ''),
    detail_text: design.detail_text != null ? design.detail_text : (defaults.detail_text || ''),
    entrance_animation: design.entrance_animation || 'slideDown',
    car_animation: design.car_animation || 'zoomLR',
    screen_effect: design.screen_effect || 'default',
    animation_speed: design.animation_speed != null ? design.animation_speed : 1.0,
    card_width: design.card_width != null ? design.card_width : 420,
    card_position: design.card_position || 'top-center',
    card_custom_x: design.card_custom_x != null ? design.card_custom_x : null,
    card_custom_y: design.card_custom_y != null ? design.card_custom_y : null,
    border_radius: design.border_radius != null ? design.border_radius : 16,
    card_image_scale: design.card_image_scale != null ? design.card_image_scale : 1.0,
    sponsor_animation: design.sponsor_animation || 'fade',
    // Per-text styling (null = inherit from legacy fields)
    label_font_family: design.label_font_family || null,
    label_font_size: design.label_font_size != null ? design.label_font_size : null,
    label_font_weight: design.label_font_weight != null ? design.label_font_weight : null,
    label_color: design.label_color || null,
    username_font_family: design.username_font_family || null,
    username_font_weight: design.username_font_weight != null ? design.username_font_weight : null,
    username_color: design.username_color || null,
    detail_font_family: design.detail_font_family || null,
    detail_font_size: design.detail_font_size != null ? design.detail_font_size : null,
    detail_font_weight: design.detail_font_weight != null ? design.detail_font_weight : null,
    detail_color: design.detail_color || null,
    text_align: design.text_align || 'center',
    card_side_icon: design.card_side_icon || null,
    effect_amount: design.effect_amount != null ? design.effect_amount : 1.0,
    effect_size: design.effect_size != null ? design.effect_size : 1.0,
    effect_direction: design.effect_direction || 'down',
    bg_opacity: design.bg_opacity != null ? design.bg_opacity : 1.0,
    gradient_direction: design.gradient_direction || '160deg',
    border_thickness: design.border_thickness != null ? design.border_thickness : 2,
    border_opacity: design.border_opacity != null ? design.border_opacity : 0.5,
    glow_enabled: design.glow_enabled != null ? design.glow_enabled : 1,
    glow_intensity: design.glow_intensity != null ? design.glow_intensity : 0.25,
    glow_color: design.glow_color || null,
    shadow_color: design.shadow_color || null,
    shadow_blur: design.shadow_blur != null ? design.shadow_blur : 32,
    shadow_spread: design.shadow_spread != null ? design.shadow_spread : 0,
    shadow_opacity: design.shadow_opacity != null ? design.shadow_opacity : 0.6,
  };
  db.prepare(`
    INSERT OR REPLACE INTO overlay_designs
      (streamer_id, event_type, bg_color, accent_color, border_color, text_color,
       font_family, username_size, event_label, detail_text, entrance_animation,
       car_animation, screen_effect, animation_speed, card_width, card_position,
       card_custom_x, card_custom_y, border_radius, card_image_scale, sponsor_animation,
       label_font_family, label_font_size, label_font_weight, label_color,
       username_font_family, username_font_weight, username_color,
       detail_font_family, detail_font_size, detail_font_weight, detail_color,
       text_align, card_side_icon, effect_amount, effect_size, effect_direction,
       bg_opacity, gradient_direction, border_thickness, border_opacity,
       glow_enabled, glow_intensity, glow_color,
       shadow_color, shadow_blur, shadow_spread, shadow_opacity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    streamerId, eventType,
    row.bg_color, row.accent_color, row.border_color, row.text_color,
    row.font_family, row.username_size, row.event_label, row.detail_text,
    row.entrance_animation, row.car_animation, row.screen_effect,
    row.animation_speed, row.card_width, row.card_position,
    row.card_custom_x, row.card_custom_y, row.border_radius,
    row.card_image_scale, row.sponsor_animation,
    row.label_font_family, row.label_font_size, row.label_font_weight, row.label_color,
    row.username_font_family, row.username_font_weight, row.username_color,
    row.detail_font_family, row.detail_font_size, row.detail_font_weight, row.detail_color,
    row.text_align, row.card_side_icon,
    row.effect_amount, row.effect_size, row.effect_direction,
    row.bg_opacity, row.gradient_direction, row.border_thickness, row.border_opacity,
    row.glow_enabled, row.glow_intensity, row.glow_color,
    row.shadow_color, row.shadow_blur, row.shadow_spread, row.shadow_opacity,
  );
}

function deleteOverlayDesign(streamerId, eventType) {
  db.prepare('DELETE FROM overlay_designs WHERE streamer_id = ? AND event_type = ?')
    .run(streamerId, eventType);
}

// Migration: Add card_image_scale to overlay_designs
{
  const cols = db.pragma('table_info(overlay_designs)').map(c => c.name);
  if (!cols.includes('card_image_scale')) {
    db.exec(`ALTER TABLE overlay_designs ADD COLUMN card_image_scale REAL DEFAULT 1.0`);
    console.log('[DB] Added card_image_scale to overlay_designs');
  }
}

// Migration: Add sponsor_animation to overlay_designs
{
  const cols = db.pragma('table_info(overlay_designs)').map(c => c.name);
  if (!cols.includes('sponsor_animation')) {
    db.exec(`ALTER TABLE overlay_designs ADD COLUMN sponsor_animation TEXT DEFAULT 'fade'`);
    console.log('[DB] Added sponsor_animation to overlay_designs');
  }
}

// Migration: Add per-text styling columns to overlay_designs
{
  const cols = db.pragma('table_info(overlay_designs)').map(c => c.name);
  if (!cols.includes('label_font_family')) {
    db.exec(`
      ALTER TABLE overlay_designs ADD COLUMN label_font_family TEXT;
      ALTER TABLE overlay_designs ADD COLUMN label_font_size INTEGER;
      ALTER TABLE overlay_designs ADD COLUMN label_font_weight INTEGER;
      ALTER TABLE overlay_designs ADD COLUMN label_color TEXT;
      ALTER TABLE overlay_designs ADD COLUMN username_font_family TEXT;
      ALTER TABLE overlay_designs ADD COLUMN username_font_weight INTEGER;
      ALTER TABLE overlay_designs ADD COLUMN username_color TEXT;
      ALTER TABLE overlay_designs ADD COLUMN detail_font_family TEXT;
      ALTER TABLE overlay_designs ADD COLUMN detail_font_size INTEGER;
      ALTER TABLE overlay_designs ADD COLUMN detail_font_weight INTEGER;
      ALTER TABLE overlay_designs ADD COLUMN detail_color TEXT;
      ALTER TABLE overlay_designs ADD COLUMN text_align TEXT DEFAULT 'center';
    `);
    console.log('[DB] Added per-text styling columns to overlay_designs');
  }
}

// Migration: Add card_side_icon to overlay_designs
{
  const cols = db.pragma('table_info(overlay_designs)').map(c => c.name);
  if (!cols.includes('card_side_icon')) {
    db.exec(`ALTER TABLE overlay_designs ADD COLUMN card_side_icon TEXT`);
    console.log('[DB] Added card_side_icon to overlay_designs');
  }
}

// Migration: Add effect_amount and effect_size to overlay_designs
{
  const cols = db.pragma('table_info(overlay_designs)').map(c => c.name);
  if (!cols.includes('effect_amount')) {
    db.exec(`
      ALTER TABLE overlay_designs ADD COLUMN effect_amount REAL DEFAULT 1.0;
      ALTER TABLE overlay_designs ADD COLUMN effect_size REAL DEFAULT 1.0;
    `);
    console.log('[DB] Added effect_amount and effect_size to overlay_designs');
  }
}

// Migration: Add effect_direction to overlay_designs
{
  const cols = db.pragma('table_info(overlay_designs)').map(c => c.name);
  if (!cols.includes('effect_direction')) {
    db.exec(`ALTER TABLE overlay_designs ADD COLUMN effect_direction TEXT DEFAULT 'down'`);
    console.log('[DB] Added effect_direction to overlay_designs');
  }
}

// Migration: Add advanced theme columns to overlay_designs
{
  const cols = db.pragma('table_info(overlay_designs)').map(c => c.name);
  if (!cols.includes('bg_opacity')) {
    db.exec(`
      ALTER TABLE overlay_designs ADD COLUMN bg_opacity REAL DEFAULT 1.0;
      ALTER TABLE overlay_designs ADD COLUMN gradient_direction TEXT DEFAULT '160deg';
      ALTER TABLE overlay_designs ADD COLUMN border_thickness INTEGER DEFAULT 2;
      ALTER TABLE overlay_designs ADD COLUMN border_opacity REAL DEFAULT 0.5;
      ALTER TABLE overlay_designs ADD COLUMN glow_enabled INTEGER DEFAULT 1;
      ALTER TABLE overlay_designs ADD COLUMN glow_intensity REAL DEFAULT 0.25;
      ALTER TABLE overlay_designs ADD COLUMN glow_color TEXT;
      ALTER TABLE overlay_designs ADD COLUMN shadow_color TEXT;
      ALTER TABLE overlay_designs ADD COLUMN shadow_blur INTEGER DEFAULT 32;
      ALTER TABLE overlay_designs ADD COLUMN shadow_spread INTEGER DEFAULT 0;
      ALTER TABLE overlay_designs ADD COLUMN shadow_opacity REAL DEFAULT 0.6;
    `);
    console.log('[DB] Added advanced theme columns to overlay_designs');
  }
}

// Migration: Create sponsor_images table
{
  db.exec(`
    CREATE TABLE IF NOT EXISTS sponsor_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      streamer_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      display_name TEXT,
      chat_message TEXT,
      sort_order INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (streamer_id) REFERENCES streamers(id)
    )
  `);
}

// Migration: Add sponsor rotation columns to streamers
{
  const cols = db.pragma('table_info(streamers)').map(c => c.name);
  if (!cols.includes('sponsor_rotation_enabled')) {
    db.exec(`
      ALTER TABLE streamers ADD COLUMN sponsor_rotation_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN sponsor_interval_seconds INTEGER DEFAULT 30;
      ALTER TABLE streamers ADD COLUMN sponsor_send_chat INTEGER DEFAULT 0;
    `);
    console.log('[DB] Added sponsor rotation columns to streamers');
  }
}

// Migration: Add display_duration to sponsor_images
{
  const cols = db.pragma('table_info(sponsor_images)').map(c => c.name);
  if (!cols.includes('display_duration')) {
    db.exec(`ALTER TABLE sponsor_images ADD COLUMN display_duration INTEGER DEFAULT 30`);
    console.log('[DB] Added display_duration to sponsor_images');
  }
}

// Migration: Add image_scale to sponsor_images
{
  const cols = db.pragma('table_info(sponsor_images)').map(c => c.name);
  if (!cols.includes('image_scale')) {
    db.exec(`ALTER TABLE sponsor_images ADD COLUMN image_scale REAL DEFAULT 1.0`);
    console.log('[DB] Added image_scale to sponsor_images');
  }
}

// Migration: Create sponsor_messages table
{
  db.exec(`
    CREATE TABLE IF NOT EXISTS sponsor_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      streamer_id INTEGER NOT NULL,
      message_text TEXT NOT NULL,
      url TEXT,
      sort_order INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (streamer_id) REFERENCES streamers(id)
    )
  `);
}

// Migration: Add sponsor_chat_interval_minutes to streamers
{
  const cols = db.pragma('table_info(streamers)').map(c => c.name);
  if (!cols.includes('sponsor_chat_interval_minutes')) {
    db.exec(`ALTER TABLE streamers ADD COLUMN sponsor_chat_interval_minutes INTEGER DEFAULT 10`);
    console.log('[DB] Added sponsor_chat_interval_minutes to streamers');
  }

  if (!cols.includes('mod_banned_words_enabled')) {
    db.exec(`
      ALTER TABLE streamers ADD COLUMN mod_banned_words_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN mod_link_protection_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN mod_link_permit_seconds INTEGER DEFAULT 60;
      ALTER TABLE streamers ADD COLUMN mod_caps_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN mod_caps_min_length INTEGER DEFAULT 10;
      ALTER TABLE streamers ADD COLUMN mod_caps_max_percent INTEGER DEFAULT 70;
      ALTER TABLE streamers ADD COLUMN mod_emote_spam_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN mod_emote_max_count INTEGER DEFAULT 15;
      ALTER TABLE streamers ADD COLUMN mod_repetition_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN mod_repetition_window INTEGER DEFAULT 30;
      ALTER TABLE streamers ADD COLUMN mod_symbol_spam_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN mod_symbol_max_percent INTEGER DEFAULT 50;
      ALTER TABLE streamers ADD COLUMN mod_slow_mode_cmd_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN mod_raid_protection_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN mod_raid_protection_duration INTEGER DEFAULT 120;
      ALTER TABLE streamers ADD COLUMN mod_first_chatter_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN mod_follow_age_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN mod_follow_age_minutes INTEGER DEFAULT 10;
      ALTER TABLE streamers ADD COLUMN mod_action_response TEXT DEFAULT 'delete';
      ALTER TABLE streamers ADD COLUMN mod_escalation_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN mod_log_discord_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN mod_log_discord_channel_id TEXT;
      ALTER TABLE streamers ADD COLUMN mod_exempt_subs INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN mod_exempt_vips INTEGER DEFAULT 1;
    `);
    console.log('[DB] Added moderation columns to streamers');
  }

  if (!cols.includes('cmd_followage_enabled')) {
    db.exec(`
      ALTER TABLE streamers ADD COLUMN cmd_followage_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN cmd_subage_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN cmd_uptime_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN cmd_accountage_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN cmd_8ball_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN cmd_roll_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN cmd_hug_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN cmd_slap_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN cmd_love_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN cmd_rps_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN cmd_coinflip_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN cmd_quote_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN cmd_roast_enabled INTEGER DEFAULT 0;
    `);
    console.log('[DB] Added built-in command columns to streamers');
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS banned_words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    streamer_id INTEGER NOT NULL,
    word TEXT NOT NULL,
    is_regex INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (streamer_id) REFERENCES streamers(id) ON DELETE CASCADE
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_banned_words_streamer ON banned_words(streamer_id)`);

// Migration: Create timed_notifications table
{
  db.exec(`
    CREATE TABLE IF NOT EXISTS timed_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      streamer_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      message TEXT NOT NULL,
      overlay_text TEXT,
      interval_minutes INTEGER DEFAULT 15,
      send_to_twitch INTEGER DEFAULT 1,
      send_to_youtube INTEGER DEFAULT 0,
      show_overlay INTEGER DEFAULT 0,
      overlay_position TEXT DEFAULT 'bot-center',
      overlay_duration INTEGER DEFAULT 8,
      overlay_bg_color TEXT DEFAULT '#1a1a2e',
      overlay_text_color TEXT DEFAULT '#ffffff',
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (streamer_id) REFERENCES streamers(id)
    )
  `);
}

function getSponsorImages(streamerId) {
  return db.prepare('SELECT * FROM sponsor_images WHERE streamer_id = ? ORDER BY sort_order, id').all(streamerId);
}
function getEnabledSponsorImages(streamerId) {
  return db.prepare('SELECT * FROM sponsor_images WHERE streamer_id = ? AND enabled = 1 ORDER BY sort_order, id').all(streamerId);
}
function addSponsorImage(streamerId, filename, displayName, chatMessage, displayDuration) {
  return db.prepare('INSERT INTO sponsor_images (streamer_id, filename, display_name, chat_message, display_duration) VALUES (?, ?, ?, ?, ?)').run(streamerId, filename, displayName, chatMessage || null, displayDuration || 30);
}
function updateSponsorImage(id, streamerId, displayName, chatMessage, enabled, displayDuration, imageScale) {
  db.prepare('UPDATE sponsor_images SET display_name = ?, chat_message = ?, enabled = ?, display_duration = ?, image_scale = ? WHERE id = ? AND streamer_id = ?')
    .run(displayName, chatMessage || null, enabled ? 1 : 0, displayDuration || 30, imageScale != null ? imageScale : 1.0, id, streamerId);
}
function deleteSponsorImage(id, streamerId) {
  return db.prepare('DELETE FROM sponsor_images WHERE id = ? AND streamer_id = ?').run(id, streamerId);
}
function updateSponsorImageOrder(streamerId, orderedIds) {
  const stmt = db.prepare('UPDATE sponsor_images SET sort_order = ? WHERE id = ? AND streamer_id = ?');
  const update = db.transaction((ids) => {
    ids.forEach((id, index) => stmt.run(index, id, streamerId));
  });
  update(orderedIds);
}
function updateSponsorSettings(streamerId, enabled, intervalSeconds, sendChat) {
  db.prepare('UPDATE streamers SET sponsor_rotation_enabled = ?, sponsor_interval_seconds = ?, sponsor_send_chat = ? WHERE id = ?').run(enabled ? 1 : 0, intervalSeconds, sendChat ? 1 : 0, streamerId);
}

function toggleSponsorRotation(streamerId, enabled) {
  db.prepare('UPDATE streamers SET sponsor_rotation_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, streamerId);
}

// Sponsor chat messages
function getSponsorMessages(streamerId) {
  return db.prepare('SELECT * FROM sponsor_messages WHERE streamer_id = ? ORDER BY sort_order, id').all(streamerId);
}
function getEnabledSponsorMessages(streamerId) {
  return db.prepare('SELECT * FROM sponsor_messages WHERE streamer_id = ? AND enabled = 1 ORDER BY sort_order, id').all(streamerId);
}
function addSponsorMessage(streamerId, messageText, url) {
  return db.prepare('INSERT INTO sponsor_messages (streamer_id, message_text, url) VALUES (?, ?, ?)').run(streamerId, messageText, url || null);
}
function updateSponsorMessage(id, streamerId, messageText, url, enabled) {
  db.prepare('UPDATE sponsor_messages SET message_text = ?, url = ?, enabled = ? WHERE id = ? AND streamer_id = ?')
    .run(messageText, url || null, enabled ? 1 : 0, id, streamerId);
}
function deleteSponsorMessage(id, streamerId) {
  return db.prepare('DELETE FROM sponsor_messages WHERE id = ? AND streamer_id = ?').run(id, streamerId);
}
function updateSponsorChatSettings(streamerId, intervalMinutes, enabled) {
  db.prepare('UPDATE streamers SET sponsor_chat_interval_minutes = ?, sponsor_send_chat = ? WHERE id = ?')
    .run(intervalMinutes, enabled ? 1 : 0, streamerId);
}

function getTimedNotifications(streamerId) {
  return db.prepare('SELECT * FROM timed_notifications WHERE streamer_id = ? ORDER BY created_at').all(streamerId);
}

function getEnabledTimedNotifications() {
  return db.prepare('SELECT * FROM timed_notifications WHERE enabled = 1').all();
}

function addTimedNotification(streamerId, data) {
  return db.prepare(`INSERT INTO timed_notifications (streamer_id, name, message, overlay_text, interval_minutes, send_to_twitch, send_to_youtube, show_overlay, overlay_position, overlay_duration, overlay_bg_color, overlay_text_color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    streamerId, data.name, data.message, data.overlay_text || null, data.interval_minutes,
    data.send_to_twitch ? 1 : 0, data.send_to_youtube ? 1 : 0, data.show_overlay ? 1 : 0,
    data.overlay_position || 'bot-center', data.overlay_duration || 8,
    data.overlay_bg_color || '#1a1a2e', data.overlay_text_color || '#ffffff'
  );
}

function updateTimedNotification(id, streamerId, data) {
  db.prepare(`UPDATE timed_notifications SET name=?, message=?, overlay_text=?, interval_minutes=?, send_to_twitch=?, send_to_youtube=?, show_overlay=?, overlay_position=?, overlay_duration=?, overlay_bg_color=?, overlay_text_color=?, enabled=? WHERE id=? AND streamer_id=?`).run(
    data.name, data.message, data.overlay_text || null, data.interval_minutes,
    data.send_to_twitch ? 1 : 0, data.send_to_youtube ? 1 : 0, data.show_overlay ? 1 : 0,
    data.overlay_position || 'bot-center', data.overlay_duration || 8,
    data.overlay_bg_color || '#1a1a2e', data.overlay_text_color || '#ffffff',
    data.enabled ? 1 : 0, id, streamerId
  );
}

function deleteTimedNotification(id, streamerId) {
  db.prepare('DELETE FROM timed_notifications WHERE id = ? AND streamer_id = ?').run(id, streamerId);
}

function toggleTimedNotification(id, streamerId, enabled) {
  db.prepare('UPDATE timed_notifications SET enabled = ? WHERE id = ? AND streamer_id = ?').run(enabled ? 1 : 0, id, streamerId);
}

// Custom Overlays
const _getCustomOverlays = db.prepare(
  'SELECT * FROM custom_overlays WHERE streamer_id = ? ORDER BY sort_order, id'
);
const _getCustomOverlaysByType = db.prepare(
  'SELECT * FROM custom_overlays WHERE streamer_id = ? AND type = ? ORDER BY sort_order, id'
);
const _getCustomOverlayById = db.prepare(
  'SELECT * FROM custom_overlays WHERE id = ? AND streamer_id = ?'
);
const _getCustomOverlayByCommand = db.prepare(
  'SELECT * FROM custom_overlays WHERE streamer_id = ? AND chat_command = ?'
);
const _getAllCustomOverlayCommands = db.prepare(
  'SELECT id, streamer_id, type, chat_command FROM custom_overlays WHERE chat_command IS NOT NULL'
);
const _addCustomOverlay = db.prepare(`
  INSERT INTO custom_overlays (streamer_id, type, name, template, chat_command, config, is_active, always_on, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const _updateCustomOverlay = db.prepare(`
  UPDATE custom_overlays SET name = ?, template = ?, chat_command = ?, config = ?, always_on = ?
  WHERE id = ? AND streamer_id = ?
`);
const _toggleCustomOverlay = db.prepare(
  'UPDATE custom_overlays SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ? AND streamer_id = ? RETURNING *'
);
const _setCustomOverlayActive = db.prepare(
  'UPDATE custom_overlays SET is_active = ? WHERE id = ? AND streamer_id = ?'
);
const _deleteCustomOverlay = db.prepare(
  'DELETE FROM custom_overlays WHERE id = ? AND streamer_id = ?'
);
const _deactivateAllScenes = db.prepare(
  "UPDATE custom_overlays SET is_active = 0 WHERE streamer_id = ? AND type = 'scene' AND id != ?"
);

function getCustomOverlays(streamerId) {
  return _getCustomOverlays.all(streamerId);
}

function getCustomOverlaysByType(streamerId, type) {
  return _getCustomOverlaysByType.all(streamerId, type);
}

function getCustomOverlayById(id, streamerId) {
  return _getCustomOverlayById.get(id, streamerId);
}

function getCustomOverlayByCommand(streamerId, command) {
  return _getCustomOverlayByCommand.get(streamerId, command);
}

function getAllCustomOverlayCommands() {
  return _getAllCustomOverlayCommands.all();
}

function addCustomOverlay(streamerId, type, name, template, chatCommand, config, alwaysOn) {
  const sortOrder = getCustomOverlays(streamerId).length;
  const isActive = alwaysOn ? 1 : 0;
  const result = _addCustomOverlay.run(
    streamerId, type, name, template, chatCommand || null,
    JSON.stringify(config), isActive, alwaysOn ? 1 : 0, sortOrder
  );
  return result.lastInsertRowid;
}

function updateCustomOverlay(id, streamerId, name, template, chatCommand, config, alwaysOn) {
  _updateCustomOverlay.run(
    name, template, chatCommand || null, JSON.stringify(config),
    alwaysOn ? 1 : 0, id, streamerId
  );
}

function toggleCustomOverlay(id, streamerId) {
  const row = _toggleCustomOverlay.get(id, streamerId);
  if (row && row.type === 'scene' && row.is_active) {
    _deactivateAllScenes.run(streamerId, id);
  }
  return row;
}

function setCustomOverlayActive(id, streamerId, active) {
  _setCustomOverlayActive.run(active ? 1 : 0, id, streamerId);
}

function deleteCustomOverlay(id, streamerId) {
  _deleteCustomOverlay.run(id, streamerId);
}

// Moderation Log
function addModLogEntry(streamerId, username, userId, action, reason, messageText) {
  db.prepare('INSERT INTO moderation_log (streamer_id, username, user_id, action, reason, message_text) VALUES (?, ?, ?, ?, ?, ?)').run(streamerId, username, userId, action, reason, messageText);
}

function getModLog(streamerId, limit = 100) {
  return db.prepare('SELECT * FROM moderation_log WHERE streamer_id = ? ORDER BY created_at DESC LIMIT ?').all(streamerId, limit);
}

function cleanupOldModLogs() {
  const result = db.prepare("DELETE FROM moderation_log WHERE created_at < datetime('now', '-7 days')").run();
  if (result.changes > 0) console.log(`[DB] Cleaned up ${result.changes} old moderation log entries`);
}

function updateDonationSettings(streamerId, settings) {
  const allowed = new Set(['paypal_email', 'donation_page_enabled', 'donation_min_amount', 'donation_currency']);
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(settings)) {
    if (!allowed.has(key)) continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (fields.length === 0) return;
  values.push(streamerId);
  db.prepare(`UPDATE streamers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

function getStreamerByUsername(username) {
  return db.prepare('SELECT * FROM streamers WHERE twitch_username = ? COLLATE NOCASE').get(username);
}

// --- Overlay Events ---

function logOverlayEvent(streamerId, eventType, username, data) {
  db.prepare('INSERT INTO overlay_events (streamer_id, event_type, username, data) VALUES (?, ?, ?, ?)').run(streamerId, eventType, username, data ? JSON.stringify(data) : null);
}

function getOverlayStats7d(streamerId) {
  return db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN event_type = 'follow' THEN 1 ELSE 0 END), 0) AS follows,
      COALESCE(SUM(CASE WHEN event_type = 'subscription' THEN 1 ELSE 0 END), 0) AS subs,
      COALESCE(SUM(CASE WHEN event_type = 'bits' THEN 1 ELSE 0 END), 0) AS bits_events,
      COALESCE(SUM(CASE WHEN event_type = 'donation' THEN 1 ELSE 0 END), 0) AS donations,
      COALESCE(SUM(CASE WHEN event_type = 'raid' THEN 1 ELSE 0 END), 0) AS raids,
      COALESCE(SUM(CASE WHEN event_type = 'giftsub' THEN 1 ELSE 0 END), 0) AS giftsubs,
      COUNT(*) AS total
    FROM overlay_events
    WHERE streamer_id = ? AND created_at >= datetime('now', '-7 days')
  `).get(streamerId);
}

function getOverlayEventsRecent(streamerId, limit) {
  return db.prepare('SELECT * FROM overlay_events WHERE streamer_id = ? ORDER BY created_at DESC LIMIT ?').all(streamerId, limit || 20);
}

function cleanupOldOverlayEvents() {
  const result = db.prepare("DELETE FROM overlay_events WHERE created_at < datetime('now', '-30 days')").run();
  if (result.changes > 0) console.log(`[DB] Cleaned up ${result.changes} old overlay events`);
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
  updateWatchedYoutubeChannelInfo,
  addWatchedInstagram,
  removeWatchedInstagram,
  getWatchedInstagramForGuild,
  getAllUniqueWatchedInstagram,
  getInstagramWatchersForAccount,
  getInstagramState,
  updateInstagramState,
  updateWatchedInstagramInfo,
  updateWatchedInstagramChannel,
  addWatchedTikTok,
  removeWatchedTikTok,
  getWatchedTikTokForGuild,
  getAllUniqueWatchedTikTok,
  getTikTokWatchersForAccount,
  getTikTokState,
  updateTikTokState,
  updateWatchedTikTokInfo,
  updateWatchedTikTokChannel,
  addWatchedTwitter,
  removeWatchedTwitter,
  getWatchedTwitterForGuild,
  getAllUniqueWatchedTwitter,
  getTwitterWatchersForAccount,
  getTwitterState,
  updateTwitterState,
  updateWatchedTwitterInfo,
  updateWatchedTwitterChannel,
  isAdmin,
  createFeedback,
  getAllFeedback,
  addWatchedIracingDriver,
  removeWatchedIracingDriver,
  getWatchedIracingDriversForGuild,
  getAllUniqueWatchedIracingDrivers,
  getIracingWatchersForDriver,
  getIracingDriverState,
  updateIracingDriverState,
  upsertIracingRaceCache,
  isRaceCached,
  getIracingRaceHistory,
  searchIracingQualifying,
  getIracingDriverStats,
  updateWatchedIracingDriverChannel,
  getStreamerByOverlayToken,
  getOverlayEnabledStreamers,
  updateOverlayConfig,
  generateOverlayToken,
  updateBroadcasterScopes,
  updateBotTokens,
  getChatbotEnabledStreamers,
  getChatCommands,
  getChatCommand,
  addChatCommand,
  updateChatCommand,
  deleteChatCommand,
  updateChatbotConfig,
  updateBuiltinCommands,
  updateModerationConfig,
  getBannedWords,
  addBannedWord,
  deleteBannedWord,
  updateYoutubeChatbotConfig,
  getYoutubeChatbotEnabledStreamers,
  updateStreamerYoutubeTokens,
  updateSpotifyTokens,
  getOverlayDesign,
  getAllOverlayDesigns,
  saveOverlayDesign,
  deleteOverlayDesign,
  getSponsorImages,
  getEnabledSponsorImages,
  addSponsorImage,
  updateSponsorImage,
  deleteSponsorImage,
  updateSponsorImageOrder,
  updateSponsorSettings,
  toggleSponsorRotation,
  getSponsorMessages,
  getEnabledSponsorMessages,
  addSponsorMessage,
  updateSponsorMessage,
  deleteSponsorMessage,
  updateSponsorChatSettings,
  getTimedNotifications,
  getEnabledTimedNotifications,
  addTimedNotification,
  updateTimedNotification,
  deleteTimedNotification,
  toggleTimedNotification,
  getCustomOverlays,
  getCustomOverlaysByType,
  getCustomOverlayById,
  getCustomOverlayByCommand,
  getAllCustomOverlayCommands,
  addCustomOverlay,
  updateCustomOverlay,
  toggleCustomOverlay,
  setCustomOverlayActive,
  deleteCustomOverlay,
  addModLogEntry,
  getModLog,
  cleanupOldModLogs,
  updateDonationSettings,
  getStreamerByUsername,
  logOverlayEvent,
  getOverlayStats7d,
  getOverlayEventsRecent,
  cleanupOldOverlayEvents,
};
