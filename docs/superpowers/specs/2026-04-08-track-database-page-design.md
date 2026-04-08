# Track Database Page — Design Spec

## Context
Track stats are currently buried in the dashboard admin iRacing tab. Users want a dedicated, rich track database page with track info, class-specific stats, and screenshot-based lap import.

## Routes
- `GET /tracks` — main track list page (admin only)
- `GET /tracks/:trackName` — track detail page
- `POST /api/track-screenshot` — upload screenshot for OCR processing

Sidebar link: "Track Database" with globe icon, below existing nav items, admin-only.

## 1. Track List Page (`/tracks`)

### Layout
- **Header**: "Track Database" title + grid/list toggle + search input + "Upload IBT" button
- **Grid view**: Cards with track layout canvas preview, track name, length, turns, class count, race count
- **List view**: Compact rows with thumbnail, track name, location, length, turns, classes, race count
- **Toggle**: Grid/List preference saved to localStorage
- **Missing tracks**: Red dashed border (grid) or red left border (list), "Upload IBT to add" text
- **Search**: Client-side filter by track name

### Data Source
- `GET /api/track-maps` — existing endpoint for track layout data
- `GET /api/track-stats` — existing endpoint for race stats
- Merged client-side: tracks from track_maps + stats from track_stats

### Track Info
Store in `track_maps` table (extend with new columns via migration):
- `track_length` TEXT (e.g., "7.004 km")
- `track_turns` INTEGER
- `track_country` TEXT
- `track_city` TEXT

Populated from iRacing's `WeekendInfo` session YAML (TrackLength, TrackNumTurns, TrackCountry, TrackCity) — Bridge already reads WeekendInfo, add these fields to the upload.

## 2. Track Detail Page (`/tracks/:trackName`)

### Header Banner
- Back button (← Back to tracks)
- Track layout canvas (from track_maps API)
- Track name, location (city, country)
- Stats: length, turns, total races, classes count
- Track image: auto-fetched from iRacing media by track name (fallback to gradient)

### Class Tabs
- One tab per car class detected for this track (GTP, LMP2, GT3, etc.)
- Active tab highlighted, others muted
- Tab content shows stats table for that class

### Stats Table (per class tab)
Columns: Race Type | Avg Lap | Avg Pit | Avg Qualify | Est. Laps | Avg SOF | Races | Avg Drivers

Race types shown depend on class:
- GT3: Regionals, VRS Sprint, IMSA Sprint, VRS Open, IMSA Open, IMSA Endurance, Global Endurance
- LMP2: LMP2 Sprint, IMSA Sprint, IMSA Open, IMSA Endurance, Global Endurance
- GTP: Proto Sprint, IMSA Sprint, IMSA Open, IMSA Endurance, Global Endurance
- Others: Sprint, Open, Endurance

Missing race types show dimmed `--` placeholders.

### Screenshot Upload
- Drop zone at bottom of each class tab
- Accepts PNG/JPG screenshots from Garage61 or similar tools
- Upload to `POST /api/track-screenshot`
- Server processes with Tesseract.js OCR
- Extracts: driver names, lap times, positions
- Returns structured data for review before saving
- WAP detection: laps >2s slower than driver's average flagged as "worst affected points"

## 3. Screenshot OCR Pipeline

### Server-Side Processing
1. Upload image to `data/screenshots/` (temporary)
2. Run Tesseract.js OCR on server
3. Parse extracted text for tabular lap data (regex patterns for time formats M:SS.mmm)
4. Return structured JSON: `{ drivers: [{ name, laps: [{ lap, time, isWAP }] }] }`
5. Client displays for review → user confirms → data saved to track_stats

### WAP Detection
- For each driver: calculate average lap time (excluding first lap and pit laps)
- Flag laps where `lapTime > avgLapTime + 2.0s` as WAP
- In the review UI: WAP laps highlighted in red with delta shown

### Dependencies
- `tesseract.js` — add to server package.json (not Bridge)
- `multer` — for file upload handling (already available or add)

## 4. Database Changes

### Extend track_maps table
```sql
ALTER TABLE track_maps ADD COLUMN track_length TEXT;
ALTER TABLE track_maps ADD COLUMN track_turns INTEGER;
ALTER TABLE track_maps ADD COLUMN track_country TEXT;
ALTER TABLE track_maps ADD COLUMN track_city TEXT;
```

### Bridge telemetry: send track metadata on upload
Add to the track map upload payload: TrackLength, TrackNumTurns, TrackCountry, TrackCity from WeekendInfo.

## 5. New Files
- `src/views/tracks.ejs` — track list + detail (single page with client-side routing)
- `src/routes/tracks.js` — route handler (or add to server.js)
- No new Bridge files needed (data already collected)

## 6. Visual Design
- Follows existing dark theme (CSS custom properties from header.ejs)
- Same card styles, colors, fonts as dashboard
- Track layout canvas: reuse existing `drawTrackPreview()` function
- Responsive grid: `repeat(auto-fill, minmax(200px, 1fr))`

## 7. Access Control
- Admin only (same as current track upload)
- Sidebar link only visible to admin users
- Routes check `isAdmin` middleware

## Verification
1. Navigate to /tracks from sidebar — see grid of track cards
2. Toggle to list view — see compact rows
3. Search filters tracks by name
4. Click a track — see detail page with header + class tabs
5. Switch class tabs — see correct stats per class
6. Upload a Garage61 screenshot — OCR extracts lap times
7. WAP laps highlighted in review
8. Missing tracks show red indicator
9. Upload IBT button works (links to existing upload flow)
