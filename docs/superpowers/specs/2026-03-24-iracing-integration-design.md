# iRacing Integration — Design Spec

## Problem

Atleta currently only supports Twitch and YouTube. Many streamers and content creators are also sim racers on iRacing. There's no way to automatically post race results, track qualifying times, or view driver stats through the bot.

## Solution

Add iRacing race result notifications and a web dashboard for qualifying leaderboards, race history, and driver stats. Uses the official iRacing Data API with a single global account. Users add drivers by Customer ID, and the bot polls for new race results every 30 minutes.

---

## iRacing API Service

### `src/services/iracing.js`

**Authentication:**
- Uses `IRACING_EMAIL` + `IRACING_PASSWORD` env vars (optional — bot works without them, iRacing features silently disabled)
- Password encoding: SHA-256 hash of `password + email.toLowerCase()`, then Base64 encode
- Login via `POST https://members-ng.iracing.com/auth` with `Content-Type: application/json` body: `{"email":"...","password":"<encoded>"}`
- Response sets multiple `Set-Cookie` headers — all cookies must be stored and sent back on subsequent requests
- Use manual cookie jar: store raw `Set-Cookie` values, replay as `Cookie` header on all API calls
- Re-authenticate on 401 responses, backoff and retry on 429/503

**Two-step API call pattern:**
The iRacing API returns a link object `{"link": "https://s3-..."}` for every endpoint. The `apiCall(endpoint)` wrapper must:
1. `fetch(iRacingBaseUrl + endpoint)` with cookies → get JSON with `link` field
2. `fetch(data.link)` → get actual JSON data from S3
3. Return the S3 response data

This is fundamentally different from the Twitch `apiCall` pattern and must be implemented as a two-step fetch.

**Exported functions (MVP):**
- `login()` — authenticate and cache cookies
- `getRecentRaces(customerId)` — search hosted + series results, merge by subsession_id, sort by end_time desc
- `getRaceResult(subsessionId)` — detailed result for one race
- `getDriverProfile(customerId)` — iRating per category, SR, license, display name
- `getQualifyingBests(customerId, categoryId)` — fastest qualifying laps

**Phase 2 (out of initial scope):**
- `getSeasonStandings(seasonId)` — full season leaderboard
- `getLapData(subsessionId, customerId)` — lap-by-lap times
- `searchResults(filters)` — search by series, car, track, date range

**Rate limiting:** 2-second delay between sequential API calls. Retry with exponential backoff on 429/503.

**Graceful degradation:** If `IRACING_EMAIL` or `IRACING_PASSWORD` are not set, the service exports no-op functions. The poller checks `isConfigured()` before polling.

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
```

**Key changes from review:**
- `iracing_race_cache` uses `UNIQUE(subsession_id, customer_id)` — not `subsession_id UNIQUE` — so multiple watched drivers in the same race don't conflict
- Removed `last_race_subsession_id` from `iracing_driver_state` — dedup uses the cache table (`SELECT 1 FROM iracing_race_cache WHERE subsession_id = ? AND customer_id = ?`)
- `iracing_driver_state` has iRating and Safety Rating for all 4 categories (road, oval, dirt_road, dirt_oval)
- Indexes on qualifying and customer queries

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

### updateGuildConfig extension

Add `iracing_enabled = ?` to the `_updateGuildConfig` prepared statement after `twitter_enabled`. Update the `updateGuildConfig` function to pass `config.iracing_enabled ? 1 : 0` in the correct position. Update the `POST /guild/:guildId` route to include `iracing_enabled: req.body.iracing_enabled === 'on'`.

### CRUD queries

Follow `watched_youtube_channels` pattern:
- `addWatchedIracingDriver(guildId, streamerId, customerId, driverName, notifyChannelId)`
- `removeWatchedIracingDriver(id, streamerId)`
- `getWatchedIracingDriversForGuild(guildId, streamerId)`
- `getAllUniqueWatchedIracingDrivers()` — `SELECT DISTINCT customer_id`
- `getIracingWatchersForDriver(customerId)` — joins watched_iracing_drivers with streamers for enabled check
- `getIracingDriverState(customerId)` / `updateIracingDriverState(customerId, updates)` — upsert pattern
- `upsertIracingRaceCache(raceData)` — `INSERT OR IGNORE` into cache
- `isRaceCached(subsessionId, customerId)` — returns boolean, used for dedup
- `getIracingRaceHistory(customerId, limit)` — recent races from cache ordered by race_date DESC
- `searchIracingQualifying(filters)` — search cache by category/car/track, ORDER BY qualifying_time ASC
- `getIracingDriverStats(customerId)` — aggregate: COUNT, wins (finish_position=1), AVG finish, AVG incidents, best finish
- `updateWatchedIracingDriverChannel(id, streamerId, notifyChannelId)`

### Stats queries

Add `iracing_result_count` CASE WHEN clause to:
- `_getGuildNotificationStats`
- `_getGuildStatsByPeriod`
- `_getGuildStatsLifetime`

---

## Poller

### `src/pollers/iracingResults.js`

**`check(customerId, driverState)`:**
1. Call `getRecentRaces(customerId)` — returns array of recent races (merged from hosted + series, deduped by subsession_id, sorted by end_time desc)
2. For each race, check `isRaceCached(subsessionId, customerId)` — skip if already cached
3. For new races: fetch `getRaceResult(subsessionId)`, extract this driver's result row
4. Build notification data and cache entry
5. Return `{ notify, races: [...], stateUpdate }` or null

**Registration in `manager.js`:**
- New `pollAllIracingResults()` function
- Check `iracingService.isConfigured()` before polling — skip entirely if no credentials
- 2-second delay between drivers
- Registered in `startAll()` with `config.intervals.iracingResults`
- Does NOT poll immediately on startup
- Tier check at notification send time: check `tierConfig.iracing` and `guild.iracing_enabled` for each watcher

**Pre-population on add:**
When a driver is added, fetch recent races and insert into `iracing_race_cache` so old results don't trigger notifications.

---

## Discord Notification Embed

### `buildIracingResultEmbed(raceData)` in `src/discord.js`

**Color:** `0x1a1a2e`

**Layout:**
```
Author: "DriverName finished a race"
Title: "SeriesName — TrackName"
URL: https://members.iracing.com/membersite/member/EventResult.do?subsessionid=X

Fields:
  Position      P3 / 24 (started P7 — gained 4)    [inline]
  iRating       2,145 (+45 ▲)                        [inline]
  Incidents     2x                                    [inline]
  Laps          28 / 28                               [inline]
  Car           BMW M4 GT4                            [inline]
  SOF           2,340                                 [inline]
  Fastest Lap   2:18.456
  Qualifying    2:17.892 (P5)

Footer: "iRacing" + timestamp
```

**Formatting:**
- iRating positive: `(+45 ▲)`, negative: `(-23 ▼)`, zero: `(±0)`
- Position gained: `(started P7 — gained 4 places)`, lost: `(started P2 — lost 1 place)`, same: `(started P3)`
- Lap times formatted as `M:SS.mmm`

**Notification type:** `'iracing_result'`

---

## Dashboard — Guild Config Tab

New tab: **iRacing** (color: `#1a1a2e`, checkered flag icon)

Same UX as Twitch:
- Input: iRacing Customer ID (number)
- Dropdown: notification Discord channel
- Add button
- Driver name auto-resolved from `getDriverProfile()` on add
- List: driver name, iRating badge per category, edit/remove buttons

---

## Dashboard — iRacing Hub Pages

### `GET /dashboard/iracing` — Hub page

Only visible in sidebar if user has any watched iRacing drivers. Shows data scoped to the user's drivers: `SELECT DISTINCT customer_id FROM watched_iracing_drivers WHERE streamer_id = ?`.

**Three sub-tabs:**

**Race History:**
- Table from `iracing_race_cache` filtered to user's watched drivers
- Columns: Driver, Series, Track, Car, Position, iRating Change, Date
- Filterable by driver name and category (Road/Oval/Dirt Road/Dirt Oval)

**Qualifying Leaderboard:**
- Filter dropdowns: category, car, track (populated from cached data)
- Table: Driver, Car, Track, Qualifying Time, Date
- Sorted by fastest qualifying time

**Driver Stats:**
- Select a driver from dropdown
- Cards: iRating per category, Safety Rating, License Class
- Aggregate stats from cache: races, wins, top 5s, avg finish, avg incidents

### `GET /dashboard/iracing/race/:subsessionId` — Race detail page
- Full result card with all embed fields
- Link to iRacing's official results page

---

## Config Changes

### `src/config.js`

```js
// In intervals:
iracingResults: parseInt(process.env.IRACING_POLL_INTERVAL) || 1_800_000,

// In each tier:
iracing: false,          // free
iracing: true,           // starter, pro, enterprise
maxIracingDrivers: 0,    // free
maxIracingDrivers: 10,   // starter
maxIracingDrivers: 50,   // pro
maxIracingDrivers: -1,   // enterprise
```

`IRACING_EMAIL` and `IRACING_PASSWORD` are NOT added to the required env vars array — they are optional. The service gracefully skips when not configured.

---

## Admin Testing Tab

Add "iRacing Race Result" test tool:
- Input: iRacing Customer ID
- Fetches most recent race from API, sends notification to all guilds watching that driver

---

## Files Created

- `src/services/iracing.js` — iRacing Data API client with cookie auth + S3 link following
- `src/pollers/iracingResults.js` — race result poller
- `src/views/iracing-hub.ejs` — hub page with sub-tabs (race history, qualifying, stats)
- `src/views/iracing-race.ejs` — race detail page

## Files Modified

- `src/config.js` — iracingResults interval, tier flags (iracing, maxIracingDrivers)
- `src/db.js` — 3 new tables, Migration 10, indexes, CRUD queries, stats queries update, updateGuildConfig extension
- `src/discord.js` — `buildIracingResultEmbed()`
- `src/pollers/manager.js` — register iRacing poller with isConfigured() guard
- `src/routes/dashboard.js` — CRUD routes, hub routes, guild config data, iracing_enabled in POST
- `src/routes/admin.js` — test tool for iRacing results
- `src/views/guild-config.ejs` — new iRacing tab
- `src/views/header.ejs` — tab color (.tab-iracing), sidebar iRacing hub link (conditional)
- `src/views/dashboard.ejs` — chart typeKeys/typeColors/typeNames update

## Edge Cases

- **Invalid Customer ID:** `getDriverProfile()` returns null → show error "Driver not found"
- **Private profile:** Handle gracefully, show what's available
- **No recent races:** Skip notification, show "No races found" on dashboard
- **API rate limiting:** 2-second delay between drivers, exponential backoff on 429/503
- **Session expiry:** Re-authenticate automatically on 401
- **Old race spam:** Pre-populate cache on driver add
- **Multiple categories:** iRating/SR stored per category (road, oval, dirt_road, dirt_oval)
- **Multi-driver subsessions:** UNIQUE(subsession_id, customer_id) allows same race for different drivers
- **No iRacing credentials:** Service returns no-op, poller skips, features disabled silently
- **S3 link expiry:** S3 pre-signed URLs expire — fetch immediately after getting the link, don't cache the URL

## Future Enhancements (Out of Scope)

- Live race tracking (detect when a driver is currently in session)
- League management and results
- Head-to-head driver comparisons
- Lap time graphs and telemetry
- Season standings pages
- Lap-by-lap race detail data
