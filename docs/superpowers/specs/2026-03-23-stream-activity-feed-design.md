# Stream Activity Feed — Design Spec

## Problem

Paid features (clips, YouTube, sub sync) don't feel compelling enough to justify upgrading from the free tier. Users care most about keeping their Discord community engaged, but servers go quiet between streams. We need features that fill the dead air automatically with zero effort.

## Solution

Three new automated features that keep Discord servers active around stream activity:

1. **Stream Recaps** — post-stream summary embeds
2. **Weekly Highlights** — weekly digest of streaming activity
3. **Milestone Celebrations** — automatic announcements when follower/sub thresholds are crossed

All features are set-and-forget: toggle on in the dashboard, no further configuration needed. Targets non-technical users (small and mid-tier streamers).

---

## Feature 1: Stream Recaps

### Behavior

When a monitored Twitch channel goes offline, the bot posts a recap embed. Recaps follow the existing watcher fan-out pattern in `manager.js`: for each watcher of that channel, if the guild has `recap_enabled` and the streamer's tier includes `recaps`, post to the watcher's `watched_channels.live_channel_id` (the per-channel notification channel, not the guild-level `twitch_live_channel_id`).

### Embed Content

- Stream title and category
- Duration (time from live detection to offline detection)
- Top 3 clips created during the stream session (by view count)
- Stream thumbnail (last captured)

### Implementation

- Hook into the existing `twitchLive` poller's offline transition (state change: live → offline).
- On offline detection:
  1. Calculate stream duration from the stored `started_at` timestamp to now.
  2. Fetch clips from the Twitch Helix API filtered to the stream's time window (`started_at` to offline time, using both `started_at` and `ended_at` params). Select top 3 by `view_count`.
  3. Compose a Discord embed with the recap data.
  4. Fan out to all watchers: for each watcher row returned by a new `getWatchersForChannelWithFeatures` query (joins `watched_channels` → `guilds` → `streamers`), check `guilds.recap_enabled` and the streamer's tier. Post to `watched_channels.live_channel_id`. The per-watcher tier lookup is acceptable — popular channels rarely have more than a handful of watchers.
- Store stream session data (start time, title, category, thumbnail URL) in `channel_state` when the channel goes live, so it's available at offline time. The Twitch API `started_at` is authoritative; the stored value serves as a fallback for bot-restart scenarios.

### Data Changes

- Extend `channel_state` to add `stream_title`, `stream_category`, `stream_thumbnail_url`, and `stream_started_at` columns.

### Edge Cases

- If no clips were created during the stream, omit the clips section from the embed.
- If the stream was very short (under 5 minutes), skip the recap to avoid noise from test/accidental streams.
- If the bot was restarted mid-stream, the start time may be missing. In that case, use the Twitch API's `started_at` field from the most recent archived video.

### Tier Gating

Starter and above.

---

## Feature 2: Weekly Highlights

### Behavior

Every Monday at 09:00 UTC, the bot posts a weekly digest embed to each configured guild summarizing the past 7 days of streaming activity.

### Embed Content

- Number of streams and total hours streamed
- Most popular clip of the week (highest view count), with link
- Categories/games played (deduplicated list)

### Implementation

- New poller: `src/pollers/weeklyDigest.js`
- Runs on a 1-hour interval, but only triggers the digest when the current time crosses Monday 09:00 UTC and the digest hasn't been posted for the current week yet.
- On trigger:
  1. Build a channel data cache (`Map<twitch_username, {videos, topClip}>`) to avoid duplicate API calls when multiple guilds watch the same channel.
  2. For each guild with weekly highlights enabled, look up all watched Twitch channels.
  3. For each unique channel, query Twitch API for videos (type: archive) from the past 7 days and clips from the past 7 days.
  4. Cache results per channel. Reuse cached data when the same channel appears in multiple guilds.
  5. Per guild: aggregate across all its watched channels — count streams, sum durations, collect unique categories, pick the top clip.
  6. Compose and post the digest embed. For the posting channel: query for any watcher row in that guild with a non-null `live_channel_id` (`ORDER BY wc.id ASC LIMIT 1`). If no watcher has a `live_channel_id` set, skip the digest for that guild.
- Track last digest date in a new `weekly_digest_state` table to prevent duplicate posts.

### Data Changes

- New table: `weekly_digest_state`
  - `guild_id` TEXT PRIMARY KEY
  - `last_digest_date` TEXT (ISO date of last Monday digest was posted)

### Edge Cases

- If no streams happened that week, skip the digest for that guild (less noisy than posting "nothing happened").
- If a guild was just added mid-week, wait until the next Monday.
- Rate limits: the per-channel cache ensures each Twitch channel is queried at most once per digest run, regardless of how many guilds watch it.
- If the bot is down during the Monday 09:00 UTC window, it will trigger the digest when it next polls (later that Monday, or missed entirely if down all day Monday — acceptable for v1). The `last_digest_date` is only written after a successful post, so a failed post allows retry on the next poll.

### Tier Gating

Pro and above.

---

## Feature 3: Milestone Celebrations

### Behavior

When a monitored Twitch channel crosses a follower or subscriber milestone, the bot posts a celebratory embed to all watchers of that channel (where the guild has `milestones_enabled` and the streamer's tier includes `milestones`), posting to `watched_channels.live_channel_id`.

### API Requirement

Both follower and subscriber counts require a **broadcaster OAuth token** (the Twitch `Get Channel Followers` endpoint requires broadcaster/moderator auth since 2023). If the streamer has not linked their Twitch broadcaster token, milestone celebrations are disabled entirely for their channels. The dashboard should show a prompt to link their Twitch account to enable this feature.

### Milestones

**Follower milestones** (adaptive):
- Under 1,000 followers: every 100
- 1,000–10,000: every 500
- 10,000+: every 1,000

**Subscriber milestones** (fixed thresholds):
- 10, 25, 50, 100, 250, 500, 1,000, 2,500, 5,000, 10,000

### Implementation

- New table: `channel_milestones`
  - `twitch_username` TEXT PRIMARY KEY (matches `channel_state` key convention)
  - `last_follower_count` INTEGER
  - `last_subscriber_count` INTEGER
  - `last_follower_milestone` INTEGER (last milestone that was announced)
  - `last_subscriber_milestone` INTEGER
- Check milestones during the `twitchLive` poller cycle, but only when the channel is currently live (to avoid unnecessary API calls every 60s for offline channels). No new poller needed.
- On each poll, if a broadcaster token is available, fetch the channel's current follower count via `Get Channel Followers` (total only) and subscriber count via existing `getSubscribers`.
- Compare against `last_follower_milestone` / `last_subscriber_milestone`. If a new milestone was crossed, fan out to all guilds watching that channel with milestones enabled and appropriate tier.
- If no broadcaster token is linked, skip milestone checks for that channel entirely.

### Embed Content

- Celebration message (e.g., "Channel X just hit 500 followers!")
- Current count
- Colored embed with party-themed description

### Edge Cases

- If a channel jumps over multiple milestones between polls (e.g., a raid), only announce the highest one reached.
- If follower count drops below a milestone and comes back, don't re-announce (tracked via `last_follower_milestone`).
- If broadcaster token is revoked after being linked, gracefully skip milestones and log a warning.

### Tier Gating

Starter and above.

---

## Config Changes

Add the following feature flags to each tier in `src/config.js`:

| Property | Free | Starter | Pro | Enterprise |
|---|---|---|---|---|
| `recaps` | `false` | `true` | `true` | `true` |
| `milestones` | `false` | `true` | `true` | `true` |
| `weeklyHighlights` | `false` | `false` | `true` | `true` |

These are new properties, separate from the existing `streamSummaries` flag (which remains unchanged).

Add `weeklyDigest` to `config.intervals` with a default of `3_600_000` (1 hour).

## Tier Distribution

| Feature | Free | Starter (5 EUR/yr) | Pro (10 EUR/yr) | Enterprise (25 EUR/yr) |
|---|---|---|---|---|
| Stream Recaps | No | Yes | Yes | Yes |
| Milestone Celebrations | No | Yes | Yes | Yes |
| Weekly Highlights | No | No | Yes | Yes |

## Dashboard Changes

Add a new "Activity Feed" section to the guild configuration page with three toggles:
- Stream Recaps (on/off)
- Milestone Celebrations (on/off) — if no broadcaster token is linked, show a prompt to link Twitch account
- Weekly Highlights (on/off, shown only for Pro+ tiers)

Each toggle shows a brief description of what it does. Disabled toggles for insufficient tiers show an "Upgrade" link.

## Database Changes Summary

1. Extend `channel_state`: add `stream_title` TEXT, `stream_category` TEXT, `stream_thumbnail_url` TEXT, `stream_started_at` TEXT columns.
2. New table: `weekly_digest_state` (`guild_id` TEXT PK, `last_digest_date` TEXT).
3. New table: `channel_milestones` (`twitch_username` TEXT PK, `last_follower_count` INTEGER, `last_subscriber_count` INTEGER, `last_follower_milestone` INTEGER, `last_subscriber_milestone` INTEGER).
4. Add columns to `guilds` table: `recap_enabled` INTEGER DEFAULT 0, `milestones_enabled` INTEGER DEFAULT 0, `weekly_highlights_enabled` INTEGER DEFAULT 0. Note: since `guilds` is keyed on `(guild_id, streamer_id)`, these toggles are per-streamer-per-guild. For recaps and milestones this is correct (each streamer controls their own channels). For weekly highlights, the digest is posted once per guild — use the toggle from the first streamer row found for that guild (`ORDER BY g.id ASC LIMIT 1`). Update `updateGuildConfig` in `db.js` and the dashboard POST handler in `routes/dashboard.js` to include these new columns.

## Files Changed / Created

- **Modified:** `src/pollers/twitchLive.js` — add recap posting on offline transition, milestone checking on each poll
- **Modified:** `src/db.js` — new tables, migrations, query functions for all three features; extend `updateGuildConfig`; add `getWatchersForChannelWithFeatures` query joining `watched_channels wc` → `guilds g` (on `wc.guild_id = g.guild_id AND wc.streamer_id = g.streamer_id`) → `streamers s` (on `wc.streamer_id = s.id`) to include feature toggles and tier info. The `guilds` table has a composite key `(guild_id, streamer_id)`, so both columns must be in the join predicate.
- **Modified:** `src/config.js` — add `recaps`, `milestones`, `weeklyHighlights` flags to each tier
- **Modified:** `src/discord.js` — new embed builder functions for recaps, digests, milestones
- **Modified:** `src/services/twitch.js` — add `getVideos(broadcasterId, period)` and `getFollowerCount(broadcasterId, accessToken)` functions
- **Modified:** `src/routes/dashboard.js` — activity feed toggle endpoints; extend POST handler for new guild columns
- **Modified:** `src/views/guild-config.ejs` — activity feed toggle UI with tier gating and broadcaster token prompt
- **Modified:** `src/pollers/manager.js` — register weekly digest poller
- **Created:** `src/pollers/weeklyDigest.js` — weekly digest poller

## Notification Log Types

New `type` values for the `notification_log` table:
- `'twitch_recap'` — stream recap embeds
- `'weekly_digest'` — weekly highlight digests
- `'twitch_milestone'` — follower/subscriber milestone celebrations

## Future Enhancements (Out of Scope)

- Configurable digest day/time (currently hardcoded to Monday 09:00 UTC)
- Dedicated milestone notification channel (currently uses `live_channel_id`)
