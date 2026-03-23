# Stream Activity Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three automated features (Stream Recaps, Weekly Highlights, Milestone Celebrations) that keep Discord servers active around streaming activity, making paid tiers more compelling.

**Architecture:** Each feature hooks into the existing polling system. Stream Recaps and Milestones piggyback on the `twitchLive` poller's existing per-channel loop; Weekly Highlights gets a new poller. All features use the existing `sendNotification` + `buildEmbed` pattern and follow the watcher fan-out model in `manager.js`. New guild-level toggles gate each feature, combined with tier checks via `config.tiers`.

**Tech Stack:** Node.js, Express, better-sqlite3 (SQLite), discord.js v14, Twitch Helix API

**Spec:** `docs/superpowers/specs/2026-03-23-stream-activity-feed-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/config.js` | Modify | Add `recaps`, `milestones`, `weeklyHighlights` tier flags + `weeklyDigest` interval |
| `src/db.js` | Modify | New tables, migrations, queries for all three features |
| `src/services/twitch.js` | Modify | Add `getVideos()`, `getFollowerCount()`, update `getClips()` with `ended_at` |
| `src/discord.js` | Modify | Add embed builders for recaps, digests, milestones |
| `src/pollers/twitchLive.js` | Modify | Return stream metadata on go-live, return recap data on offline |
| `src/pollers/manager.js` | Modify | Store stream metadata on go-live, handle recap fan-out on offline, run milestones during live polls, register weekly digest |
| `src/pollers/weeklyDigest.js` | Create | Weekly digest poller with Monday 09:00 UTC trigger |
| `src/routes/dashboard.js` | Modify | Pass new toggle data to guild-config, handle new toggle POSTs |
| `src/views/guild-config.ejs` | Modify | Activity Feed toggles UI |

---

## Task 1: Config — Add Tier Flags and Interval

**Files:**
- Modify: `src/config.js:41-121`

- [ ] **Step 1: Add `weeklyDigest` to `config.intervals`**

In `src/config.js`, after `subSync` (line 46), add:

```js
weeklyDigest: parseInt(process.env.WEEKLY_DIGEST_INTERVAL) || 3_600_000,
```

- [ ] **Step 2: Add feature flags to each tier**

Add these three properties to each tier object in `src/config.js`:

**free** (after `whiteLabel: false, delayMinutes: 5`):
```js
recaps: false,
milestones: false,
weeklyHighlights: false,
```

**starter** (after `whiteLabel: false, delayMinutes: 0`):
```js
recaps: true,
milestones: true,
weeklyHighlights: false,
```

**pro** (after `whiteLabel: false, delayMinutes: 0`):
```js
recaps: true,
milestones: true,
weeklyHighlights: true,
```

**enterprise** (after `whiteLabel: true, delayMinutes: 0`):
```js
recaps: true,
milestones: true,
weeklyHighlights: true,
```

- [ ] **Step 3: Verify the app starts**

Run: `node -e "const c = require('./src/config'); console.log(c.tiers.starter.recaps, c.intervals.weeklyDigest)"`

Expected: `true 3600000`

- [ ] **Step 4: Commit**

```bash
git add src/config.js
git commit -m "feat: add activity feed tier flags and weekly digest interval"
```

---

## Task 2: Database — Schema, Migrations, and Queries

**Files:**
- Modify: `src/db.js:15-222` (schema/migrations section)
- Modify: `src/db.js:507-569` (watched channels section)
- Modify: `src/db.js:801-870` (exports)

This is the largest task. It adds migrations, extends `channel_state`, creates two new tables, adds new queries, and extends `updateGuildConfig`.

- [ ] **Step 1: Add migration for `guilds` table — new toggle columns**

After the existing Migration 3 block (around line 51), add:

```js
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
```

- [ ] **Step 2: Add migration for `channel_state` — stream session columns**

```js
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
```

- [ ] **Step 3: Add new tables to schema**

After the `youtube_channel_state` CREATE TABLE (line 221), add:

```js
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
```

- [ ] **Step 4: Extend `_updateChannelState` to include new columns**

Replace the existing `_updateChannelState` prepared statement (lines 527-533) with:

```js
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
```

And update the `updateChannelState` function (lines 562-569):

```js
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
```

- [ ] **Step 5: Extend `_updateGuildConfig` to include new toggles**

Replace the existing `_updateGuildConfig` prepared statement (lines 302-316) with:

```js
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
```

And update the `updateGuildConfig` function (lines 341-357):

```js
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
```

- [ ] **Step 6: Add `getWatchersForChannelWithFeatures` query**

After the existing `_getWatchersForChannel` block (around line 521), add:

```js
const _getWatchersForChannelWithFeatures = db.prepare(`
  SELECT wc.*, g.recap_enabled, g.milestones_enabled, g.weekly_highlights_enabled,
         s.id AS owner_id, s.enabled AS streamer_enabled
  FROM watched_channels wc
  JOIN guilds g ON wc.guild_id = g.guild_id AND wc.streamer_id = g.streamer_id
  JOIN streamers s ON wc.streamer_id = s.id
  WHERE wc.twitch_username = ? AND wc.enabled = 1 AND s.enabled = 1
`);
```

And add the function:

```js
function getWatchersForChannelWithFeatures(twitchUsername) {
  return _getWatchersForChannelWithFeatures.all(twitchUsername.toLowerCase());
}
```

- [ ] **Step 7: Add milestone queries**

After the new watcher query, add:

```js
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
```

- [ ] **Step 8: Add weekly digest state queries**

```js
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
```

- [ ] **Step 9: Add query to get guilds with weekly highlights enabled**

```js
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
```

- [ ] **Step 10: Add query to get posting channel for a guild (for weekly digest)**

```js
const _getDigestChannelForGuild = db.prepare(`
  SELECT wc.live_channel_id FROM watched_channels wc
  WHERE wc.guild_id = ? AND wc.live_channel_id IS NOT NULL
  ORDER BY wc.id ASC LIMIT 1
`);

function getDigestChannelForGuild(guildId) {
  const row = _getDigestChannelForGuild.get(guildId);
  return row?.live_channel_id || null;
}
```

- [ ] **Step 11: Export all new functions**

Add to the `module.exports` object:

```js
getWatchersForChannelWithFeatures,
getChannelMilestones,
updateChannelMilestones,
getWeeklyDigestState,
updateWeeklyDigestDate,
getGuildsWithWeeklyHighlights,
getDigestChannelForGuild,
```

- [ ] **Step 12: Verify the app starts with schema changes**

Run: `node -e "const db = require('./src/db'); console.log('DB OK')"`

Expected: `DB OK` (with possible migration log lines)

- [ ] **Step 13: Commit**

```bash
git add src/db.js
git commit -m "feat: add database schema and queries for activity feed features"
```

---

## Task 3: Twitch Service — New API Functions

**Files:**
- Modify: `src/services/twitch.js:62-102`

- [ ] **Step 1: Update `getClips` to accept `endedAt` parameter**

Replace the existing `getClips` function (lines 62-70):

```js
async function getClips(broadcasterId, startedAt, endedAt) {
  const params = new URLSearchParams({
    broadcaster_id: broadcasterId,
    started_at: startedAt,
    first: '10',
  });
  if (endedAt) params.set('ended_at', endedAt);
  const data = await apiCall(`/clips?${params}`);
  return data.data || [];
}
```

- [ ] **Step 2: Add `getVideos` function**

After `getClips`, add:

```js
async function getVideos(broadcasterId, startedAfter) {
  const params = new URLSearchParams({
    user_id: broadcasterId,
    type: 'archive',
    first: '20',
  });
  const data = await apiCall(`/videos?${params}`);
  const videos = data.data || [];
  if (startedAfter) {
    return videos.filter(v => v.created_at >= startedAfter);
  }
  return videos;
}
```

- [ ] **Step 3: Add `getFollowerCount` function**

This requires a broadcaster token, so it makes a direct fetch instead of using `apiCall`:

```js
async function getFollowerCount(broadcasterId, broadcasterAccessToken) {
  const params = new URLSearchParams({
    broadcaster_id: broadcasterId,
    first: '1',
  });
  const res = await fetch(`https://api.twitch.tv/helix/channels/followers?${params}`, {
    headers: {
      Authorization: `Bearer ${broadcasterAccessToken}`,
      'Client-Id': config.twitch.clientId,
    },
  });
  if (!res.ok) {
    throw new Error(`Followers API error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.total || 0;
}
```

- [ ] **Step 4: Add `getGameNames` function**

After `getFollowerCount`, add:

```js
async function getGameNames(gameIds) {
  if (gameIds.length === 0) return [];
  const params = gameIds.map(id => `id=${id}`).join('&');
  const data = await apiCall(`/games?${params}`);
  return (data.data || []).map(g => g.name);
}
```

- [ ] **Step 5: Export new functions**

Update the `module.exports` (line 102):

```js
module.exports = { getStream, getUserId, getClips, getSubscribers, getVideos, getFollowerCount, getGameNames };
```

- [ ] **Step 6: Commit**

```bash
git add src/services/twitch.js
git commit -m "feat: add getVideos, getFollowerCount, getGameNames, and endedAt support to Twitch service"
```

---

## Task 4: Discord Embeds — Recap, Digest, Milestone

**Files:**
- Modify: `src/discord.js:29-43`

- [ ] **Step 1: Add `buildRecapEmbed` function**

After the existing `buildEmbed` function, add:

```js
function buildRecapEmbed({ twitchUsername, title, category, duration, thumbnailUrl, clips }) {
  const hours = Math.floor(duration / 3600);
  const mins = Math.floor((duration % 3600) / 60);
  const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  const fields = [
    { name: 'Category', value: category || 'Unknown', inline: true },
    { name: 'Duration', value: durationStr, inline: true },
  ];

  if (clips && clips.length > 0) {
    const clipsText = clips
      .map((c, i) => `${i + 1}. [${c.title}](${c.url}) — ${c.view_count} views`)
      .join('\n');
    fields.push({ name: 'Top Clips', value: clipsText });
  }

  return buildEmbed({
    color: 0x9146ff,
    author: { name: `${twitchUsername} stream recap` },
    title: title || 'Untitled Stream',
    url: `https://twitch.tv/${twitchUsername}`,
    fields,
    image: thumbnailUrl || undefined,
    footer: { text: 'Stream Recap' },
    timestamp: new Date(),
  });
}
```

- [ ] **Step 2: Add `buildWeeklyDigestEmbed` function**

```js
function buildWeeklyDigestEmbed({ streamCount, totalHours, categories, topClip }) {
  const fields = [
    { name: 'Streams', value: `${streamCount}`, inline: true },
    { name: 'Total Hours', value: `${totalHours.toFixed(1)}h`, inline: true },
  ];

  if (categories.length > 0) {
    fields.push({ name: 'Categories', value: categories.join(', ') });
  }

  if (topClip) {
    fields.push({
      name: 'Top Clip of the Week',
      value: `[${topClip.title}](${topClip.url}) — ${topClip.view_count} views`,
    });
  }

  return buildEmbed({
    color: 0x3498db,
    author: { name: 'Weekly Highlights' },
    title: 'Your week in streaming',
    fields,
    footer: { text: 'Weekly Digest' },
    timestamp: new Date(),
  });
}
```

- [ ] **Step 3: Add `buildMilestoneEmbed` function**

```js
function buildMilestoneEmbed({ twitchUsername, milestoneType, count }) {
  const typeLabel = milestoneType === 'follower' ? 'followers' : 'subscribers';
  const emoji = milestoneType === 'follower' ? '\u{1F389}' : '\u{1F389}';

  return buildEmbed({
    color: 0xf1c40f,
    title: `${emoji} ${twitchUsername} just hit ${count.toLocaleString()} ${typeLabel}!`,
    url: `https://twitch.tv/${twitchUsername}`,
    description: `Congratulations! A new milestone has been reached.`,
    footer: { text: 'Milestone Celebration' },
    timestamp: new Date(),
  });
}
```

- [ ] **Step 4: Export new functions**

Update `module.exports`:

```js
module.exports = { client, sendNotification, buildEmbed, buildRecapEmbed, buildWeeklyDigestEmbed, buildMilestoneEmbed };
```

- [ ] **Step 5: Commit**

```bash
git add src/discord.js
git commit -m "feat: add embed builders for recaps, weekly digest, and milestones"
```

---

## Task 5: TwitchLive Poller — Recap and Milestone Logic

**Files:**
- Modify: `src/pollers/twitchLive.js`

The poller currently returns `{ notify, embed, stateUpdate }`. We'll extend it to also return stream metadata on go-live and recap data on offline.

- [ ] **Step 1: Rewrite the `twitchLive.js` check function**

Replace the entire content of `src/pollers/twitchLive.js`:

```js
const { getStream, getClips } = require('../services/twitch');
const { buildEmbed } = require('../discord');

function formatThumbnail(url) {
  return url.replace('{width}', '1280').replace('{height}', '720');
}

async function check(twitchUsername, channelState) {
  const stream = await getStream(twitchUsername);

  // Channel just went LIVE
  if (stream && !channelState.is_live) {
    const embed = buildEmbed({
      color: 0x9146ff,
      author: { name: `${stream.user_name || twitchUsername} is live on Twitch!` },
      title: stream.title,
      url: `https://twitch.tv/${twitchUsername}`,
      description: `Playing **${stream.game_name || 'Unknown'}**`,
      image: formatThumbnail(stream.thumbnail_url),
      footer: { text: 'Twitch' },
      timestamp: new Date(),
    });

    return {
      notify: true,
      embed,
      stateUpdate: {
        is_live: 1,
        stream_title: stream.title,
        stream_category: stream.game_name || 'Unknown',
        stream_thumbnail_url: formatThumbnail(stream.thumbnail_url),
        stream_started_at: stream.started_at,
      },
    };
  }

  // Channel just went OFFLINE — build recap data
  if (!stream && channelState.is_live) {
    let recapData = null;

    if (channelState.stream_started_at) {
      const startedAt = new Date(channelState.stream_started_at);
      const now = new Date();
      const durationSec = Math.floor((now - startedAt) / 1000);

      // Skip recap for very short streams (under 5 minutes)
      if (durationSec >= 300) {
        let clips = [];
        const broadcasterId = channelState.twitch_broadcaster_id;
        if (broadcasterId) {
          try {
            const allClips = await getClips(broadcasterId, channelState.stream_started_at, now.toISOString());
            clips = allClips
              .sort((a, b) => b.view_count - a.view_count)
              .slice(0, 3);
          } catch (e) {
            console.error(`[TwitchLive] Failed to fetch recap clips for ${twitchUsername}: ${e.message}`);
          }
        }

        recapData = {
          twitchUsername,
          title: channelState.stream_title,
          category: channelState.stream_category,
          thumbnailUrl: channelState.stream_thumbnail_url,
          duration: durationSec,
          clips,
        };
      }
    }

    return {
      notify: false,
      recapData,
      stateUpdate: {
        is_live: 0,
        stream_title: null,
        stream_category: null,
        stream_thumbnail_url: null,
        stream_started_at: null,
      },
    };
  }

  return null;
}

module.exports = { check };
```

Note: We set the stream session fields to `null` on offline. However, `updateChannelState` uses `COALESCE(?, existing)` — so `null` won't clear the value. We need to handle this. The simplest approach is to add a `clearStreamSession` function in `db.js`.

- [ ] **Step 2: Add `clearStreamSession` to `db.js`**

In `src/db.js`, after the `updateChannelState` function, add:

```js
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
```

Export it in `module.exports`:

```js
clearStreamSession,
```

- [ ] **Step 3: Update twitchLive.js stateUpdate for offline**

In the offline branch of `twitchLive.js`, change `stateUpdate` to only set `is_live`:

```js
    return {
      notify: false,
      recapData,
      stateUpdate: { is_live: 0 },
      clearSession: true,
    };
```

The `clearSession` flag will be handled by `manager.js` (next task).

- [ ] **Step 4: Commit**

```bash
git add src/pollers/twitchLive.js src/db.js
git commit -m "feat: extend twitchLive poller with stream session tracking and recap data"
```

---

## Task 6: Manager — Recap Fan-Out and Milestone Checks

**Files:**
- Modify: `src/pollers/manager.js:12-44`

- [ ] **Step 1: Add imports**

At the top of `manager.js`, update imports:

```js
const db = require('../db');
const config = require('../config');
const { sendNotification, buildRecapEmbed, buildMilestoneEmbed } = require('../discord');
const twitchLive = require('./twitchLive');
const twitchClips = require('./twitchClips');
const youtubeFeed = require('./youtubeFeed');
const youtubeLive = require('./youtubeLive');
const subSync = require('./subSync');
const { getFollowerCount, getSubscribers } = require('../services/twitch');
```

- [ ] **Step 2: Replace `pollAllTwitchLive` to handle recaps and milestones**

Replace the entire `pollAllTwitchLive` function (lines 12-44):

```js
async function pollAllTwitchLive() {
  const channels = db.getAllUniqueWatchedChannels();
  if (channels.length > 0 && !pollAllTwitchLive._logged) {
    console.log(`[TwitchLive] Polling ${channels.length} channels: ${channels.map(c => c.twitch_username).join(', ')}`);
    pollAllTwitchLive._logged = true;
  }
  for (const { twitch_username } of channels) {
    try {
      const state = db.getChannelState(twitch_username);
      const result = await twitchLive.check(twitch_username, state);
      if (!result) {
        // Channel is still in same state — check milestones if live
        if (state.is_live) {
          await checkMilestones(twitch_username, state);
        }
        continue;
      }

      if (result.stateUpdate) db.updateChannelState(twitch_username, result.stateUpdate);
      if (result.clearSession) db.clearStreamSession(twitch_username);

      // Go-live notification (existing behavior)
      if (result.notify) {
        const watchers = db.getWatchersForChannel(twitch_username).filter((w) => w.notify_live && w.live_channel_id);
        for (const w of watchers) {
          try {
            await sendNotification(w.live_channel_id, result.embed, {
              streamerId: w.streamer_id,
              guildId: w.guild_id,
              type: 'twitch_live',
            });
          } catch (e) {
            console.error(`[TwitchLive] Send failed for ${twitch_username} to ${w.guild_id}: ${e.message}`);
          }
        }
      }

      // Stream recap on offline
      if (result.recapData) {
        await sendRecaps(twitch_username, result.recapData);
      }

      // Check milestones when channel is live
      if (result.stateUpdate?.is_live === 1) {
        await checkMilestones(twitch_username, db.getChannelState(twitch_username));
      }
    } catch (error) {
      console.error(`[TwitchLive] Error for ${twitch_username}: ${error.message}`);
    }
  }
}
```

- [ ] **Step 3: Add `sendRecaps` function**

After `pollAllTwitchLive`, add:

```js
async function sendRecaps(twitchUsername, recapData) {
  const watchers = db.getWatchersForChannelWithFeatures(twitchUsername)
    .filter((w) => w.recap_enabled && w.live_channel_id);

  for (const w of watchers) {
    const tier = db.getStreamerTier(w.streamer_id);
    const tierConfig = config.tiers[tier] || config.tiers.free;
    if (!tierConfig.recaps) continue;

    try {
      const embed = buildRecapEmbed(recapData);
      await sendNotification(w.live_channel_id, embed, {
        streamerId: w.streamer_id,
        guildId: w.guild_id,
        type: 'twitch_recap',
      });
    } catch (e) {
      console.error(`[Recap] Send failed for ${twitchUsername} to ${w.guild_id}: ${e.message}`);
    }
  }
}
```

- [ ] **Step 4: Add `checkMilestones` function**

```js
function getFollowerMilestone(count) {
  if (count < 1000) return Math.floor(count / 100) * 100;
  if (count < 10000) return Math.floor(count / 500) * 500;
  return Math.floor(count / 1000) * 1000;
}

const SUB_MILESTONES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

function getSubMilestone(count) {
  let milestone = 0;
  for (const m of SUB_MILESTONES) {
    if (count >= m) milestone = m;
    else break;
  }
  return milestone;
}

async function checkMilestones(twitchUsername, channelState) {
  const broadcasterId = channelState.twitch_broadcaster_id;
  if (!broadcasterId) return;

  // Find a streamer with a broadcaster token who watches this channel
  const watchers = db.getWatchersForChannelWithFeatures(twitchUsername)
    .filter((w) => w.milestones_enabled);
  if (watchers.length === 0) return;

  // Check if any watcher's streamer has a broadcaster token
  const streamersWithToken = new Map();
  for (const w of watchers) {
    if (!streamersWithToken.has(w.streamer_id)) {
      const streamer = db.getStreamerById(w.streamer_id);
      if (streamer?.broadcaster_access_token) {
        streamersWithToken.set(w.streamer_id, streamer);
      }
    }
  }
  if (streamersWithToken.size === 0) return;

  const streamer = streamersWithToken.values().next().value;
  const milestones = db.getChannelMilestones(twitchUsername);

  try {
    const followerCount = await getFollowerCount(broadcasterId, streamer.broadcaster_access_token);
    const currentFollowerMilestone = getFollowerMilestone(followerCount);

    if (currentFollowerMilestone > milestones.last_follower_milestone && currentFollowerMilestone > 0) {
      console.log(`[Milestones] ${twitchUsername} hit ${currentFollowerMilestone} followers!`);
      const embed = buildMilestoneEmbed({
        twitchUsername,
        milestoneType: 'follower',
        count: currentFollowerMilestone,
      });
      await sendMilestoneNotifications(twitchUsername, watchers, embed);
      db.updateChannelMilestones(twitchUsername, {
        last_follower_count: followerCount,
        last_follower_milestone: currentFollowerMilestone,
      });
    } else {
      db.updateChannelMilestones(twitchUsername, { last_follower_count: followerCount });
    }

    // Subscriber milestones
    try {
      const subs = await getSubscribers(broadcasterId, streamer.broadcaster_access_token);
      const subCount = subs.length;
      const currentSubMilestone = getSubMilestone(subCount);

      if (currentSubMilestone > milestones.last_subscriber_milestone && currentSubMilestone > 0) {
        console.log(`[Milestones] ${twitchUsername} hit ${currentSubMilestone} subscribers!`);
        const embed = buildMilestoneEmbed({
          twitchUsername,
          milestoneType: 'subscriber',
          count: currentSubMilestone,
        });
        await sendMilestoneNotifications(twitchUsername, watchers, embed);
        db.updateChannelMilestones(twitchUsername, {
          last_subscriber_count: subCount,
          last_subscriber_milestone: currentSubMilestone,
        });
      } else {
        db.updateChannelMilestones(twitchUsername, { last_subscriber_count: subCount });
      }
    } catch (e) {
      // Sub count may fail if token doesn't have the right scope — that's ok
      console.warn(`[Milestones] Sub count failed for ${twitchUsername}: ${e.message}`);
    }
  } catch (e) {
    console.warn(`[Milestones] Follower count failed for ${twitchUsername}: ${e.message}`);
  }
}

async function sendMilestoneNotifications(twitchUsername, watchers, embed) {
  for (const w of watchers) {
    if (!w.milestones_enabled || !w.live_channel_id) continue;
    const tier = db.getStreamerTier(w.streamer_id);
    const tierConfig = config.tiers[tier] || config.tiers.free;
    if (!tierConfig.milestones) continue;

    try {
      await sendNotification(w.live_channel_id, embed, {
        streamerId: w.streamer_id,
        guildId: w.guild_id,
        type: 'twitch_milestone',
      });
    } catch (e) {
      console.error(`[Milestones] Send failed for ${twitchUsername} to ${w.guild_id}: ${e.message}`);
    }
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add src/pollers/manager.js
git commit -m "feat: add recap fan-out and milestone checks to polling manager"
```

---

## Task 7: Weekly Digest Poller

**Files:**
- Create: `src/pollers/weeklyDigest.js`
- Modify: `src/pollers/manager.js` (register the new poller)

- [ ] **Step 1: Create `src/pollers/weeklyDigest.js`**

```js
const db = require('../db');
const config = require('../config');
const { sendNotification, buildWeeklyDigestEmbed } = require('../discord');
const { getVideos, getClips, getUserId, getGameNames } = require('../services/twitch');

async function pollWeeklyDigest() {
  const now = new Date();

  // Only trigger on Mondays between 09:00 and 09:59 UTC
  if (now.getUTCDay() !== 1 || now.getUTCHours() !== 9) return;

  const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const guildsToDigest = db.getGuildsWithWeeklyHighlights();

  // Per-channel data cache to avoid duplicate API calls
  const channelCache = new Map();
  const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  for (const { guild_id, streamer_id } of guildsToDigest) {
    try {
      // Check tier
      const tier = db.getStreamerTier(streamer_id);
      const tierConfig = config.tiers[tier] || config.tiers.free;
      if (!tierConfig.weeklyHighlights) continue;

      // Check if already posted this week
      const digestState = db.getWeeklyDigestState(guild_id);
      if (digestState?.last_digest_date === todayStr) continue;

      // Get posting channel
      const channelId = db.getDigestChannelForGuild(guild_id);
      if (!channelId) continue;

      // Gather data for all watched Twitch channels in this guild
      const watchedChannels = db.getWatchedChannelsForGuild(guild_id, streamer_id);
      let totalStreams = 0;
      let totalSeconds = 0;
      const allCategories = new Set();
      let topClip = null;

      for (const wc of watchedChannels) {
        const username = wc.twitch_username;

        if (!channelCache.has(username)) {
          // Resolve broadcaster ID
          const state = db.getChannelState(username);
          let broadcasterId = state?.twitch_broadcaster_id;
          if (!broadcasterId) {
            broadcasterId = await getUserId(username);
            if (broadcasterId) {
              db.updateChannelState(username, { twitch_broadcaster_id: broadcasterId });
            }
          }

          if (!broadcasterId) {
            channelCache.set(username, { videos: [], clips: [] });
            continue;
          }

          try {
            const videos = await getVideos(broadcasterId, oneWeekAgo);
            const clips = await getClips(broadcasterId, oneWeekAgo);
            channelCache.set(username, { videos, clips });
          } catch (e) {
            console.error(`[WeeklyDigest] API error for ${username}: ${e.message}`);
            channelCache.set(username, { videos: [], clips: [] });
          }
        }

        const cached = channelCache.get(username);

        // Aggregate videos (streams)
        for (const v of cached.videos) {
          totalStreams++;
          // Twitch duration format: "1h2m3s" or "2m3s" etc.
          totalSeconds += parseTwitchDuration(v.duration);
          // Videos don't have game_name, but we can try
        }

        // Find top clip
        for (const c of cached.clips) {
          if (!topClip || c.view_count > topClip.view_count) {
            topClip = c;
          }
        }

        // Resolve game names from clip game_ids
        const gameIds = [...new Set(cached.clips.map(c => c.game_id).filter(Boolean))];
        if (gameIds.length > 0) {
          const names = await getGameNames(gameIds);
          for (const name of names) allCategories.add(name);
        }
      }

      // Skip if no activity
      if (totalStreams === 0 && !topClip) continue;

      const embed = buildWeeklyDigestEmbed({
        streamCount: totalStreams,
        totalHours: totalSeconds / 3600,
        categories: [...allCategories],
        topClip: topClip ? { title: topClip.title, url: topClip.url, view_count: topClip.view_count } : null,
      });

      await sendNotification(channelId, embed, {
        streamerId: streamer_id,
        guildId: guild_id,
        type: 'weekly_digest',
      });

      // Only record after successful post
      db.updateWeeklyDigestDate(guild_id, todayStr);
      console.log(`[WeeklyDigest] Posted digest for guild ${guild_id}`);
    } catch (e) {
      console.error(`[WeeklyDigest] Error for guild ${guild_id}: ${e.message}`);
    }
  }
}

function parseTwitchDuration(duration) {
  // Twitch format: "1h2m3s", "45m12s", "30s"
  const hours = duration.match(/(\d+)h/)?.[1] || 0;
  const mins = duration.match(/(\d+)m/)?.[1] || 0;
  const secs = duration.match(/(\d+)s/)?.[1] || 0;
  return Number(hours) * 3600 + Number(mins) * 60 + Number(secs);
}

module.exports = { pollWeeklyDigest };
```

- [ ] **Step 2: Register the weekly digest poller in `manager.js`**

At the top of `manager.js`, add the import:

```js
const { pollWeeklyDigest } = require('./weeklyDigest');
```

In the `startAll` function, after the existing `setInterval` calls (around line 179), add:

```js
setInterval(pollWeeklyDigest, config.intervals.weeklyDigest);
```

- [ ] **Step 3: Commit**

```bash
git add src/pollers/weeklyDigest.js src/pollers/manager.js
git commit -m "feat: add weekly digest poller with Monday 09:00 UTC trigger"
```

---

## Task 8: Dashboard — Toggle Endpoints and UI

**Files:**
- Modify: `src/routes/dashboard.js:90-143`
- Modify: `src/views/guild-config.ejs`

- [ ] **Step 1: Pass tier limits to guild-config view**

In `src/routes/dashboard.js`, update the `GET /guild/:guildId` handler. Add tier data to the render call. Replace the `res.render('guild-config', ...)` call (lines 108-118):

```js
  const { tier, limits } = getTierLimits(req.streamer.id);

  res.render('guild-config', {
    streamer: req.streamer,
    guild: guildConfig,
    guildName: discordGuild?.name || guildConfig.guild_name || 'Unknown',
    channels,
    roles,
    watchedTwitchCount,
    watchedYoutubeCount,
    hasBroadcasterToken: !!req.streamer.broadcaster_access_token,
    broadcasterAuthUrl: `${config.app.url}/auth/broadcaster`,
    tier,
    limits,
  });
```

- [ ] **Step 2: Update POST handler to include new toggles**

In the `POST /guild/:guildId` handler (lines 127-139), add the three new fields to the config object:

```js
  db.updateGuildConfig(guildId, req.streamer.id, {
    twitch_live_channel_id: req.body.twitch_live_channel_id || null,
    twitch_clips_channel_id: req.body.twitch_clips_channel_id || null,
    youtube_channel_id: req.body.youtube_channel_id || null,
    welcome_channel_id: req.body.welcome_channel_id || null,
    sub_role_id: req.body.sub_role_id || null,
    welcome_message: req.body.welcome_message || null,
    twitch_live_enabled: req.body.twitch_live_enabled === 'on',
    twitch_clips_enabled: req.body.twitch_clips_enabled === 'on',
    youtube_enabled: req.body.youtube_enabled === 'on',
    welcome_enabled: req.body.welcome_enabled === 'on',
    sub_sync_enabled: req.body.sub_sync_enabled === 'on',
    recap_enabled: req.body.recap_enabled === 'on',
    milestones_enabled: req.body.milestones_enabled === 'on',
    weekly_highlights_enabled: req.body.weekly_highlights_enabled === 'on',
  });
```

- [ ] **Step 3: Add Activity Feed section to `guild-config.ejs`**

Before the Danger Zone card (line 74), add the new Activity Feed section:

```html
  <div class="card">
    <h3>Activity Feed</h3>
    <p style="color: #adadb8; font-size: 13px; margin-bottom: 16px;">Automatic posts that keep your server active around stream activity.</p>

    <div class="toggle">
      <input type="checkbox" name="recap_enabled" id="recap_enabled" <%= guild.recap_enabled ? 'checked' : '' %> <% if (!limits.recaps) { %>disabled<% } %>>
      <label for="recap_enabled">Stream Recaps</label>
      <p style="color: #adadb8; font-size: 12px; margin: 2px 0 12px 0;">Post a summary when a stream ends — duration, category, and top clips.</p>
      <% if (!limits.recaps) { %>
        <p style="font-size: 12px;"><a href="/dashboard/subscription">Upgrade</a> to enable this feature.</p>
      <% } %>
    </div>

    <div class="toggle">
      <input type="checkbox" name="milestones_enabled" id="milestones_enabled" <%= guild.milestones_enabled ? 'checked' : '' %> <% if (!limits.milestones) { %>disabled<% } %>>
      <label for="milestones_enabled">Milestone Celebrations</label>
      <p style="color: #adadb8; font-size: 12px; margin: 2px 0 12px 0;">Announce when a channel hits follower or subscriber milestones.</p>
      <% if (!limits.milestones) { %>
        <p style="font-size: 12px;"><a href="/dashboard/subscription">Upgrade</a> to enable this feature.</p>
      <% } else if (!hasBroadcasterToken) { %>
        <p style="color: #e67e22; font-size: 12px;">Requires <a href="<%= broadcasterAuthUrl %>">broadcaster authorization</a> to access follower/sub counts.</p>
      <% } %>
    </div>

    <div class="toggle">
      <input type="checkbox" name="weekly_highlights_enabled" id="weekly_highlights_enabled" <%= guild.weekly_highlights_enabled ? 'checked' : '' %> <% if (!limits.weeklyHighlights) { %>disabled<% } %>>
      <label for="weekly_highlights_enabled">Weekly Highlights</label>
      <p style="color: #adadb8; font-size: 12px; margin: 2px 0 12px 0;">Post a weekly digest every Monday with stream stats and top clips.</p>
      <% if (!limits.weeklyHighlights) { %>
        <p style="font-size: 12px;"><a href="/dashboard/subscription">Upgrade</a> to enable this feature.</p>
      <% } %>
    </div>
  </div>
```

- [ ] **Step 4: Commit**

```bash
git add src/routes/dashboard.js src/views/guild-config.ejs
git commit -m "feat: add activity feed toggles to dashboard UI"
```

---

## Task 9: Manual Smoke Test

This project has no automated tests. Verify the implementation by starting the app and checking the dashboard.

- [ ] **Step 1: Start the app**

Run: `npm run dev`

Verify: No errors on startup. Look for migration log lines like:
```
[DB] Added activity feed toggle columns to guilds
[DB] Added stream session columns to channel_state
```

- [ ] **Step 2: Check the dashboard**

Navigate to a guild config page. Verify:
- Activity Feed section appears with three toggles
- Free tier users see "Upgrade" links on all three toggles
- Toggles save correctly when the form is submitted

- [ ] **Step 3: Verify config loads**

Check the console output for any errors related to the new tier flags or interval.

- [ ] **Step 4: Commit any fixes if needed**

If any issues were found, fix and commit.
