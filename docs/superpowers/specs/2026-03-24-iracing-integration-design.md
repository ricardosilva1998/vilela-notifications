# iRacing Integration — Design Spec

## Problem

Atleta currently only supports Twitch and YouTube. Many streamers and content creators are also sim racers on iRacing. There's no way to automatically post race results, track qualifying times, or view driver stats through the bot.

## Solution

Add iRacing race result notifications and a web dashboard for qualifying leaderboards, race history, and driver stats. Uses the official iRacing Data API with a single global account. Users add drivers by Customer ID, and the bot polls for new race results every 30 minutes.

---

## iRacing API Service

### `src/services/iracing.js`

**Authentication:**
- Uses `IRACING_EMAIL` + `IRACING_PASSWORD` env vars
- Login via `POST https://members-ng.iracing.com/auth` with email/password
- Returns session cookie, cached in memory
- Re-authenticates on 401 responses
- All API calls go through `apiCall(endpoint)` wrapper

**Exported functions:**
- `login()` — authenticate and cache session cookie
- `getRecentRaces(customerId)` — GET `/data/results/search_hosted` + `/data/results/search_series` for last 10 races
- `getRaceResult(subsessionId)` — GET `/data/results/get` with full result details
- `getDriverProfile(customerId)` — GET `/data/member/get` for iRating, SR, license, display name
- `getQualifyingBests(customerId, categoryId)` — GET `/data/stats/member_bests` for fastest laps
- `getSeasonStandings(seasonId)` — GET `/data/results/season_results`
- `searchResults(filters)` — search by series, car, track, date range
- `getLapData(subsessionId, customerId)` — GET `/data/results/lap_data` for lap-by-lap times

**Rate limiting:** 2-second delay between sequential API calls to avoid hitting iRacing rate limits.

**Note:** The iRacing Data API returns link objects with a `link` field containing a pre-signed S3 URL. The service must follow these links to get the actual JSON data.

---

## Database

### New tables

```sql
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
  last_race_subsession_id TEXT,
  last_checked TEXT,
  irating_road INTEGER DEFAULT 0,
  irating_oval INTEGER DEFAULT 0,
  safety_rating REAL DEFAULT 0,
  license_class TEXT
);

CREATE TABLE IF NOT EXISTS iracing_race_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subsession_id TEXT UNIQUE NOT NULL,
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
  created_at TEXT DEFAULT (datetime('now'))
);
```

### Migration 10

```js
// Migration 10: add iracing_enabled to guilds
try {
  const cols = db.prepare("PRAGMA table_info(guilds)").all();
  if (cols.length > 0 && !cols.find((c) => c.name === 'iracing_enabled')) {
    db.exec('ALTER TABLE guilds ADD COLUMN iracing_enabled INTEGER DEFAULT 0');
    console.log('[DB] Added iracing_enabled column to guilds');
  }
} catch {}
```

### CRUD queries

Follow the existing `watched_youtube_channels` pattern:
- `addWatchedIracingDriver(guildId, streamerId, customerId, driverName, notifyChannelId)`
- `removeWatchedIracingDriver(id, streamerId)`
- `getWatchedIracingDriversForGuild(guildId, streamerId)`
- `getAllUniqueWatchedIracingDrivers()` — SELECT DISTINCT customer_id
- `getIracingWatchersForDriver(customerId)` — joins with streamers for enabled check
- `getIracingDriverState(customerId)` / `updateIracingDriverState(customerId, updates)`
- `upsertIracingRaceCache(raceData)` — INSERT OR REPLACE into cache
- `getIracingRaceHistory(customerId, limit)` — recent races from cache
- `searchIracingQualifying(filters)` — search cache by category/car/track, ORDER BY qualifying_time ASC
- `getIracingDriverStats(customerId)` — aggregated stats from cache (win rate, avg finish, etc.)
- `updateWatchedIracingDriverChannel(id, streamerId, notifyChannelId)` — edit notification channel

### updateGuildConfig extension

Add `iracing_enabled = ?` to the prepared statement, same pattern as other toggles.

### Stats queries

Add `iracing_result_count` CASE WHEN clause to:
- `_getGuildNotificationStats`
- `_getGuildStatsByPeriod`
- `_getGuildStatsLifetime`

---

## Poller

### `src/pollers/iracingResults.js`

**`check(customerId, driverState)`:**
1. Call `getRecentRaces(customerId)` — returns array of recent subsession IDs
2. Filter out any already in `last_race_subsession_id` or in `iracing_race_cache`
3. For each new race:
   - Call `getRaceResult(subsessionId)` to get full details
   - Extract: position, iRating change, incidents, laps, fastest lap, qualifying time, series, track, car, SOF, field size
   - Return as notification data
4. Return `{ notify, races: [...], stateUpdate }` or null

**Registration in `manager.js`:**
- New `pollAllIracingResults()` function following YouTube pattern
- 2-second delay between drivers
- Registered in `startAll()` with `config.intervals.iracingResults`
- Does NOT poll immediately on startup
- Logs: `[iRacing] Polling X drivers`

### Pre-population on add

When a driver is added, fetch their recent races and store subsession IDs as known to avoid notifying about old races (same pattern as YouTube video pre-population).

---

## Discord Notification Embed

### `buildIracingResultEmbed(raceData)` in `src/discord.js`

**Color:** `0x1a1a2e` (dark racing theme)

**Layout:**
```
Author: "🏁 DriverName finished a race"
Title: "SeriesName — TrackName"
URL: link to iRacing results page

Fields (inline where noted):
  Position:     P3 / 24 (started P7 — gained 4)    [inline]
  iRating:      2,145 (+45 ▲)                        [inline]
  Incidents:    2x                                    [inline]
  Laps:         28 / 28                               [inline]
  Car:          BMW M4 GT4                            [inline]
  SOF:          2,340                                 [inline]
  Fastest Lap:  2:18.456
  Qualifying:   2:17.892 (P5)

Footer: "iRacing" + timestamp
```

**iRating formatting:**
- Positive change: green arrow `(+45 ▲)`
- Negative change: red arrow `(-23 ▼)`
- No change: `(±0)`

**Position change:**
- Gained places: `(started P7 — gained 4 places)`
- Lost places: `(started P2 — lost 1 place)`
- Same: `(started P3)`

**Notification type:** `'iracing_result'`

---

## Dashboard — Guild Config Tab

New tab in guild config: **iRacing** (color: `#1a1a2e`, racing flag icon)

Same UX as Twitch tab:
- Input: "iRacing Customer ID" (number)
- Dropdown: notification Discord channel
- Add button
- List of watched drivers: name, iRating badge (from driver state), edit/remove buttons
- Driver name auto-resolved from iRacing API on add

### Add flow:
1. User enters Customer ID
2. Route calls `getDriverProfile(customerId)` to resolve name
3. Pre-fetches recent races to populate known IDs
4. Saves to `watched_iracing_drivers` + initializes state

---

## Dashboard — iRacing Hub Pages

### `GET /dashboard/iracing` — Hub page

Accessible from sidebar (shown only if user has any iRacing drivers across their guilds).

**Three sub-tabs on the page:**

**Race History:**
- Table of all cached races for the user's watched drivers
- Columns: Driver, Series, Track, Car, Position, iRating Change, Date
- Sortable, filterable by driver name and category (Road/Oval/Dirt)
- Pagination (20 per page)

**Qualifying Leaderboard:**
- Filter by: category dropdown (Road/Oval/Dirt Road/Dirt Oval), car dropdown, track dropdown
- Table: Driver, Car, Track, Qualifying Time, Date
- Sorted by fastest time
- Data from `iracing_race_cache.qualifying_time`

**Driver Stats:**
- Dropdown to select a watched driver
- Cards: iRating (Road), iRating (Oval), Safety Rating, License Class
- Stats computed from cache: total races, wins, top 5s, avg finish, avg incidents, best finish
- Recent 10 races mini-table

### `GET /dashboard/iracing/race/:subsessionId` — Race detail page

- Full result for one race
- All the embed fields plus lap-by-lap data if available
- Link back to iRacing's official results page

---

## Config Changes

### `src/config.js`

Intervals:
```js
iracingResults: parseInt(process.env.IRACING_POLL_INTERVAL) || 1_800_000,
```

Tier flags (per tier):
```js
iracing: false,        // free
iracing: true,         // starter, pro, enterprise
maxIracingDrivers: 0,  // free
maxIracingDrivers: 10, // starter
maxIracingDrivers: 50, // pro
maxIracingDrivers: -1, // enterprise
```

---

## Admin Testing Tab

Add "iRacing Race Result" test tool:
- Input: iRacing Customer ID
- Fetches most recent race, sends notification to all guilds watching that driver

---

## Route Changes

### `src/routes/dashboard.js`

Guild config:
- Pass `watchedIracingDrivers` to guild-config template
- `POST /guild/:guildId/iracing` — add driver (resolve name, pre-populate)
- `POST /guild/:guildId/iracing/:id/edit` — edit notification channel
- `POST /guild/:guildId/iracing/:id/remove` — remove
- `POST /guild/:guildId` — add `iracing_enabled` to config save

Hub pages:
- `GET /dashboard/iracing` — hub with race history, qualifying, stats
- `GET /dashboard/iracing/race/:subsessionId` — race detail

---

## Files Created

- `src/services/iracing.js` — iRacing Data API client
- `src/pollers/iracingResults.js` — race result poller
- `src/views/iracing-hub.ejs` — hub page with sub-tabs
- `src/views/iracing-race.ejs` — race detail page

## Files Modified

- `src/config.js` — iracing interval, tier flags
- `src/db.js` — 3 new tables, Migration 10, CRUD queries, stats queries update
- `src/discord.js` — `buildIracingResultEmbed()`
- `src/pollers/manager.js` — register iRacing poller
- `src/routes/dashboard.js` — CRUD routes, hub routes, guild config data
- `src/routes/admin.js` — test tool for iRacing
- `src/views/guild-config.ejs` — new iRacing tab
- `src/views/header.ejs` — tab color, sidebar iRacing hub link
- `src/views/dashboard.ejs` — chart type arrays update

## Edge Cases

- **Invalid Customer ID:** `getDriverProfile()` returns null → show error "Driver not found"
- **Private profile:** Some iRacing members hide their stats → handle gracefully, show what's available
- **No recent races:** Driver has no races → skip notification, show "No races found" on dashboard
- **API rate limiting:** 2-second delay between drivers, re-auth on 401
- **Session expiry:** iRacing sessions expire → re-authenticate automatically
- **Old race spam:** Pre-populate known race IDs on driver add (same as YouTube)
- **Multiple categories:** A driver may race Road, Oval, Dirt — store iRating per category

## Future Enhancements (Out of Scope)

- Live race tracking (detect when a driver is currently in a session)
- League management and results
- Head-to-head comparisons between drivers
- Lap time graphs and telemetry
- Integration with iRacing's league system
