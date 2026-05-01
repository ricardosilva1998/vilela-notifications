# Session Data, Lap History & Telemetry Comparison — Design Spec

## Context

Bridge currently sends only aggregated track stats (per-class averages) to the server at the end of races. Users want per-session, per-lap data — including practice — with telemetry traces for post-session analysis and lap comparison. This enables tracking improvement over time, comparing laps against yourself or others, and a MoTeC-style telemetry viewer on the web dashboard.

## Scope

Three sub-projects, built in order:

1. **Session Capture Pipeline** — Bridge captures per-lap data + telemetry during P/Q/R sessions, uploads to server
2. **Track Page Enhancement** — Practice/Race tabs on track detail page, session history, lap list drill-down
3. **Lap Comparison Tool** — Web-based multi-channel telemetry comparison (MoTeC/Atlas style)

A future sub-project (out of scope): real-time Bridge overlay comparing current lap to a reference lap while driving.

## Decisions

- **Session types:** Practice + Qualify + Race — all captured
- **Identity:** Bridge ID (UUID) + iRacing username. No Discord link required (can add later)
- **Lap data:** Lap times + context (fuel, temps, position, incidents) + telemetry traces (10Hz)
- **Telemetry channels:** throttle, brake, speed, gear, steering angle, lapDistPct — 6 values per sample
- **Storage:** All server-side. Telemetry stored as gzip-compressed JSON arrays in SQLite
- **Privacy:** Sessions private by default. Users toggle public or share via token link
- **Comparison UI:** Web dashboard, MoTeC-style stacked channel graphs with synced crosshair

## 1. Database Schema

### `sessions` table

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bridge_id TEXT NOT NULL,
  iracing_name TEXT NOT NULL,
  track_name TEXT NOT NULL,
  car_class TEXT NOT NULL,
  car_name TEXT NOT NULL,
  session_type TEXT NOT NULL,          -- 'practice', 'qualify', 'race'
  race_type TEXT,                       -- 'IMSA Sprint', 'VRS Open', etc. (null for practice)
  is_public INTEGER DEFAULT 0,
  share_token TEXT,                     -- random token for share links
  conditions TEXT,                      -- JSON: { airTemp, trackTemp, humidity, skies, windSpeed }
  sof INTEGER,                          -- strength of field (qualify/race only)
  finish_position INTEGER,              -- class position (race only)
  irating_change INTEGER,               -- +/- (race only)
  driver_count INTEGER,                 -- total in class
  best_lap_time REAL,
  lap_count INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_sessions_track ON sessions(track_name);
CREATE INDEX idx_sessions_bridge ON sessions(bridge_id);
CREATE INDEX idx_sessions_share ON sessions(share_token);
```

### `session_laps` table

```sql
CREATE TABLE IF NOT EXISTS session_laps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  lap_number INTEGER NOT NULL,
  lap_time REAL NOT NULL,               -- seconds
  sector_times TEXT,                     -- JSON: [s1, s2, s3] if available
  fuel_used REAL,                        -- liters consumed this lap
  air_temp REAL,
  track_temp REAL,
  is_pit_lap INTEGER DEFAULT 0,
  position INTEGER,                      -- class position at end of lap
  incidents INTEGER,                     -- cumulative incident count
  is_valid INTEGER DEFAULT 1             -- false for outlap, pit lap, off-track
);
CREATE INDEX idx_session_laps_session ON session_laps(session_id);
```

### `lap_telemetry` table

```sql
CREATE TABLE IF NOT EXISTS lap_telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lap_id INTEGER NOT NULL REFERENCES session_laps(id) ON DELETE CASCADE,
  data TEXT NOT NULL                     -- gzip JSON: [[throttle,brake,speed,gear,steer,pct], ...] @ 10Hz
);
CREATE INDEX idx_lap_telemetry_lap ON lap_telemetry(lap_id);
```

### Storage estimates

- Per sample: 6 floats in JSON array ~30 bytes
- Per lap (90s at 10Hz): 900 samples × 30 bytes = ~27KB raw → ~8-10KB gzip
- Per race (30 laps): ~300KB telemetry
- Per practice (20 laps): ~200KB telemetry
- 100 sessions: ~25MB total — well within SQLite / Railway volume capacity

## 2. Session Capture Pipeline (Bridge)

### Data collection during session

Bridge already polls iRacing telemetry at ~30ms intervals. Add a session recorder that:

1. **Detects session start:** New `SessionNum` or first telemetry after iRacing connect
2. **Records session metadata:** track name, car class, car name, session type (from `SessionInfo.Sessions[sessionNum].SessionType`), weather conditions
3. **Buffers telemetry per lap:** ring buffer collecting `[throttle, brake, speed, gear, steer, lapDistPct]` at 10Hz (every 3rd poll at 30ms = ~100ms intervals)
4. **Detects lap completion:** Same as stintlaps overlay — watch for `lastLap` value changes on the player's car
5. **On lap complete:** Freeze the telemetry buffer, create a lap record with context (fuel used, temps, position, incidents, pit status)
6. **Validates laps:** Mark as invalid if: outlap (lap 1 after pit or session start), pit in-lap, lap time > 2× best lap (off-track/incident), or lap time < 30s (cut track)

### Session end detection

- `SessionNum` changes (practice → qualify → race)
- iRacing disconnects (`iracing` status goes false)
- Bridge app quits (flush on `before-quit` event)
- Timeout: no new laps for 5 minutes in practice

### Upload

On session end:

1. Build session payload: `{ session: {...}, laps: [{...}, ...], telemetry: [{lapNumber, data: gzipBase64}, ...] }`
2. Compress telemetry arrays with pako (gzip in browser/Node)
3. `POST /api/session` with the full payload
4. Retry on failure (queue in `~/Documents/Atleta Bridge/pending-sessions.json`, retry on next session or app restart)
5. Generate `share_token` server-side (random 12-char alphanumeric)

### What stays the same

- Existing track stats aggregation (`POST /api/track-stats`) continues unchanged
- Live session heartbeat unchanged
- All existing overlays unchanged

## 3. API Endpoints

### Upload

`POST /api/session` — Upload complete session (no auth, identified by bridge_id)

Request body:
```json
{
  "bridge_id": "uuid",
  "iracing_name": "Max Verstappen",
  "session": {
    "track_name": "Circuit de Spa-Francorchamps",
    "car_class": "GT3 2025",
    "car_name": "Ferrari 296 GT3",
    "session_type": "practice",
    "race_type": null,
    "conditions": { "airTemp": 22.5, "trackTemp": 45.3, "humidity": 65, "skies": "Clear", "windSpeed": 8.5 },
    "sof": null,
    "finish_position": null,
    "irating_change": null,
    "driver_count": 1,
    "best_lap_time": 137.842,
    "lap_count": 24
  },
  "laps": [
    { "lap_number": 1, "lap_time": 165.123, "sector_times": null, "fuel_used": null, "air_temp": 22.5, "track_temp": 45.3, "is_pit_lap": false, "position": 1, "incidents": 0, "is_valid": false },
    { "lap_number": 2, "lap_time": 139.455, "sector_times": [44.8, 48.2, 46.4], "fuel_used": 3.2, "air_temp": 22.5, "track_temp": 45.8, "is_pit_lap": false, "position": 1, "incidents": 0, "is_valid": true }
  ],
  "telemetry": [
    { "lap_number": 1, "data": "<gzip base64 of [[t,b,s,g,st,pct], ...]>" },
    { "lap_number": 2, "data": "<gzip base64>" }
  ]
}
```

Response: `{ id: 42, share_token: "abc123def456" }`

### Query

`GET /api/sessions/:trackName` — List sessions for a track

Query params: `?bridge_id=uuid` (required — returns own sessions + public sessions from others)

Response: array of session summaries (no laps, no telemetry)

`GET /api/session/:id` — Session detail with laps

Query params: `?bridge_id=uuid` (for auth check) or `?token=sharetoken`

Returns session + all laps (no telemetry — loaded on demand)

`GET /api/session/:id/telemetry/:lapId` — Single lap telemetry

Returns the gzip JSON telemetry data for one lap. Loaded when user clicks a lap in comparison view.

`GET /api/session/share/:token` — Access session via share link

Returns session + laps (same as GET /api/session/:id but auth via token)

### Modify

`PATCH /api/session/:id` — Toggle public, update settings

Body: `{ is_public: true }` or `{ is_public: false }`

Query params: `?bridge_id=uuid` (must match session owner)

`DELETE /api/session/:id` — Delete session + laps + telemetry (cascade)

Query params: `?bridge_id=uuid` (must match session owner)

## 4. Track Page Enhancement

### New tabs on track detail (`/tracks/:trackName`)

Add two tabs alongside the existing Stats tab:

- **Stats** — existing class-based race type statistics (unchanged)
- **Practice** — practice session history
- **Race** — qualify + race session history

### Session list (Practice and Race tabs)

Both tabs show a filterable session list:

**Filters:**
- "My Sessions" / "Public Sessions" toggle (default: My Sessions)
- Car class filter (optional)
- Car name filter (optional)

**Session row columns:** Date, Car, Best Lap, Laps, Conditions (temp + weather icon), Privacy icon (lock = private, globe = public)

**Click a session** → drill down to session detail view

### Session detail view

**Header:** Session type + track + car, date, lap count, conditions, privacy controls (Make Public button, Copy Share Link button)

**Lap table columns:** Lap #, Time, Delta to Best, Fuel Used, Track Temp, Telemetry icon (📊)

**Visual indicators:**
- Best lap highlighted in purple
- Invalid laps (outlap, pit) shown dimmed with tag
- Pit laps marked with "PIT" tag
- Delta: green for faster than best, red for slower

**Select laps for comparison:** Checkboxes on each valid lap. "Compare Selected" button appears when 2+ laps selected.

## 5. Lap Comparison — Telemetry Viewer

### Layout

Full-width page at `/tracks/:trackName/compare?laps=id1,id2` (or within a modal on the session detail page).

**Toolbar:** Lap legend (color-coded), lap times with delta, Zoom Fit / Reset buttons

**Crosshair info bar:** Shows exact values at cursor position for all laps — track distance %, throttle, brake, speed, gear, steering, cumulative time delta

**6 stacked channel graphs** (top to bottom):
1. **Time Delta** — cumulative time gained/lost (reference lap = 0 line). Fill color below/above zero.
2. **Speed** (km/h) — Y axis 60-320 km/h typical range
3. **Throttle** (0-100%) — sharp on/off patterns
4. **Brake** (0-100%) — with fill under curve for visibility
5. **Steering** (degrees) — center = straight, L/R deflection
6. **Gear** (1-6+) — step function

**X axis:** Track distance % (lapDistPct 0-100%). Both laps aligned by position, not time.

**Sector dividers:** Vertical lines at S1/S2/S3 boundaries across all graphs

**Sector breakdown table:** Below graphs. Per-sector times for each lap with deltas (green = faster, red = slower).

### Interactions

- **Crosshair:** Mouse hover syncs a vertical line across ALL channels. Info bar updates in real-time.
- **Zoom:** Scroll wheel zooms in/out on X axis (track distance). All channels zoom together. Useful for analyzing individual corners.
- **Pan:** Click-drag horizontally when zoomed in.
- **Rendering:** HTML5 Canvas for smooth 60fps with 900+ data points per trace. One canvas per channel, synchronized via shared X-axis state.

### Multi-lap comparison

Support comparing 2-4 laps simultaneously. Each lap gets a distinct color. Can compare:
- Your laps from the same session
- Your laps across different sessions (same track)
- Your lap vs someone else's public/shared lap

## 6. Privacy & Sharing Model

- **Default:** All sessions private (`is_public = 0`)
- **Make Public:** Toggle on session detail page. Public sessions appear in "Public Sessions" on the track page for all users.
- **Share Link:** Every session gets a `share_token` on creation. URL: `/tracks/:trackName/session/:shareToken`. Works even for private sessions — the token acts as access.
- **Track page visibility:** Shows own sessions (always) + public sessions from others. Filterable.
- **Comparison access:** Can compare any lap the user can see (own, public, or accessed via share link).
- **Deletion:** Owner can delete their sessions. Cascade deletes laps and telemetry.

## 7. New Files

- `bridge/sessionRecorder.js` — Session data collection, lap detection, telemetry buffering, upload logic
- `src/views/tracks.ejs` — Enhanced with Practice/Race tabs, session list, session detail, comparison view (all client-side routed)
- `src/db.js` — New tables + migration + query functions
- `src/server.js` — New API endpoints

No new EJS files needed — the track detail page handles all views with client-side tab/routing.

## 8. Implementation Order

**Phase 1: Session Capture Pipeline**
1. DB migration (sessions, session_laps, lap_telemetry tables)
2. API endpoints (POST /api/session, GET endpoints)
3. Bridge sessionRecorder.js (buffer laps + telemetry, upload on session end)
4. Retry queue for failed uploads

**Phase 2: Track Page Enhancement**
5. Practice / Race tabs on track detail page
6. Session list with filters (my sessions / public)
7. Session detail view with lap table
8. Privacy toggle + share link generation

**Phase 3: Lap Comparison Tool**
9. Comparison page layout + toolbar
10. Canvas-based multi-channel graph renderer
11. Crosshair sync + zoom/pan interactions
12. Sector breakdown table
13. Cross-session and cross-user comparison

## Verification

1. Practice in iRacing → Bridge captures all laps with telemetry → uploads to server
2. Navigate to /tracks/spa → Practice tab shows the session
3. Click session → see all laps with deltas, fuel, conditions
4. Select 2 laps → compare → see 6 stacked telemetry channels with synced crosshair
5. Zoom into a corner → see exact brake point / throttle application differences
6. Toggle session to public → appears in "Public Sessions" for other users
7. Copy share link → open in incognito → can view session and compare laps
8. Qualify and Race sessions also captured and shown in Race tab
9. Delete a session → laps and telemetry cleaned up (cascade)
10. Bridge restart with pending uploads → retries successfully
