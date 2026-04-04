# iRacing Overlay Manager — Design Spec

**Date:** 2026-04-04
**Status:** Approved

## Overview

A complete iRacing overlay system for streamers: a downloadable Electron bridge app reads real-time telemetry from iRacing, serves it via WebSocket, and 6 browser-based overlays render the data as OBS browser sources. Configuration and customization managed through the Atleta dashboard.

## Architecture

```
[iRacing Game] → shared memory → [Atleta Bridge (Electron, Windows)]
                                          ↓ WebSocket ws://localhost:9100
                                 [Browser Overlays (OBS Browser Sources)]
                                          ↑ Settings loaded from
                                 [Atleta Dashboard (atletanotifications.com)]
```

Three components:
1. **Atleta Bridge** — Electron desktop app, reads iRacing SDK, serves WebSocket
2. **Web Overlays** — 6 standalone HTML pages, connect to bridge, render data
3. **Dashboard UI** — iRacing tab for configuration, overlay URLs, bridge download

---

## Sub-project 1: Atleta Bridge (Electron App)

### Tech Stack
- Electron (Node.js runtime)
- `node-irsdk` — Node.js bindings for iRacing SDK shared memory
- `ws` — WebSocket server
- Packaged as Windows `.exe` installer via `electron-builder`

### Behavior
- System tray app (no main window by default, tray icon only)
- Tray icon colors: green (connected to iRacing), yellow (waiting for iRacing), red (error)
- Right-click menu: Status, Open Dashboard, Quit
- Auto-detects iRacing process start/stop
- WebSocket server on `ws://localhost:9100`
- Broadcasts telemetry to connected overlay clients

### WebSocket Protocol

Clients connect and send a subscribe message:
```json
{ "type": "subscribe", "channels": ["standings", "relative", "fuel", "wind", "proximity", "session"] }
```

Bridge broadcasts data per channel at different rates:

| Channel | Rate | Data |
|---------|------|------|
| `session` | 1Hz | trackName, sessionType, lapsRemaining, timeRemaining, driverList, weatherInfo |
| `standings` | 1Hz | Array of { position, carIdx, driverName, carNumber, interval, lastLap, bestLap, inPit, onLeadLap, classColor } |
| `relative` | 5Hz | Array of { carIdx, driverName, carNumber, gapSeconds, isLapped, isLappingYou, classColor } — ~5 ahead + ~5 behind |
| `fuel` | 1Hz (per lap update) | fuelLevel, fuelPerLap (avg), lapsOfFuel, lapsRemaining, fuelToFinish, fuelToAdd, lastLapFuel |
| `wind` | 2Hz | windDirection (degrees), windSpeed (m/s), carHeading (degrees) |
| `proximity` | 10Hz | carLeftRight (0=none, 1=left, 2=right, 3=both), leftCarGap, rightCarGap |

Message format:
```json
{ "type": "data", "channel": "standings", "timestamp": 1712345678, "data": { ... } }
```

Connection status messages:
```json
{ "type": "status", "iracing": true, "session": "Race", "track": "Daytona International Speedway" }
{ "type": "status", "iracing": false }
```

### iRacing SDK Variables Used

From `node-irsdk` telemetry:
- `SessionInfo` — driver list, track info, session type, weather
- `SessionNum`, `SessionState`, `SessionLapsRemaining`, `SessionTimeRemain`
- `CarIdxPosition`, `CarIdxClassPosition`, `CarIdxEstTime`, `CarIdxLastLapTime`, `CarIdxBestLapTime`
- `CarIdxOnPitRoad`, `CarIdxLapCompleted`, `CarIdxF2Time` (relative gap)
- `FuelLevel`, `FuelLevelPct`, `FuelUsePerHour`
- `Lap`, `LapCompleted`, `Speed`
- `WindDir`, `WindVel`
- `CarLeftRight`
- `PlayerCarIdx` — identifies which car is the user

### Fuel Calculator Logic
- Track fuel used per lap: `fuelAtStartOfLap - fuelAtEndOfLap`
- Rolling average of last 5 laps
- `lapsOfFuel = fuelLevel / avgFuelPerLap`
- `fuelToFinish = lapsRemaining * avgFuelPerLap`
- `fuelToAdd = fuelToFinish - fuelLevel` (clamped to 0 if negative)
- Updates after each completed lap

### Relative Calculation
- Uses `CarIdxEstTime` (estimated time around track for each car)
- Gap = `playerEstTime - otherEstTime`, normalized to track length
- Sort by gap, take closest 5 ahead and 5 behind
- Flag lapped/lapping based on `CarIdxLapCompleted` comparison

### File Structure
```
bridge/
├── package.json
├── main.js              # Electron main process — tray, lifecycle
├── telemetry.js         # iRacing SDK reader, data extraction
├── websocket.js         # WebSocket server, channel subscriptions
├── fuel-calculator.js   # Fuel tracking and calculations
├── relative.js          # Relative gap calculations
├── icons/               # Tray icons (green/yellow/red)
└── build/               # electron-builder config
```

---

## Sub-project 2: Web Overlays (6 overlay pages)

### Shared Infrastructure
- All overlays served from Atleta app: `/overlay/iracing/:type/:token`
- Standalone HTML pages (no header/footer, like the existing alert overlay)
- Connect to `ws://localhost:9100` on load
- Subscribe to relevant channels only
- Reconnect automatically if bridge disconnects
- Load custom styling from streamer's saved settings (passed via SSE init or embedded in page)
- Transparent background (for OBS chroma key / browser source)

### Overlay 1: Standings

**Route:** `/overlay/iracing/standings/:token`
**Channels:** `session`, `standings`

Display:
- Table with columns: POS | # | DRIVER | INTERVAL | LAST | BEST | PIT
- Highlight player's row with accent color
- Lapped cars in blue text, cars on lead lap in white
- Pit indicator: orange dot
- Scrollable, auto-centers on player position
- Shows class colors for multiclass races

Customization (dashboard):
- Number of rows visible (10/15/20/all)
- Show/hide columns (last lap, best lap, pit)
- Font size, colors, opacity
- Compact vs expanded mode

### Overlay 2: Relative

**Route:** `/overlay/iracing/relative/:token`
**Channels:** `session`, `relative`

Display:
- Vertical list: 5 cars ahead, YOUR CAR (highlighted), 5 cars behind
- Each row: car number, driver name, gap in seconds (e.g., +1.234 / -0.567)
- Color coding: white (same lap), blue (lapped), red (lapping you)
- Gap changes animate (getting closer = green flash, getting further = red flash)

Customization:
- Number of cars shown (3/5/7 each direction)
- Show/hide car numbers
- Font size, colors, opacity

### Overlay 3: Fuel Calculator

**Route:** `/overlay/iracing/fuel/:token`
**Channels:** `session`, `fuel`

Display:
- Compact card layout:
  ```
  FUEL: 12.3L          LAPS LEFT: 8
  AVG/LAP: 1.54L       FUEL NEEDED: 12.3L
  LAPS OF FUEL: 8.0    ADD ON PIT: 0.0L
  ```
- Color indicators: green (enough fuel), yellow (marginal), red (won't finish)
- Updates after each lap completion

Customization:
- Units (liters/gallons)
- Show/hide specific fields
- Horizontal vs vertical layout
- Font size, colors, opacity

### Overlay 4: Streaming Chat

**Route:** `/overlay/iracing/chat/:token`
**Channels:** None (uses Atleta SSE, not bridge WebSocket)

This overlay is different — it doesn't use iRacing telemetry. It connects to the Atleta server's SSE endpoint to receive Twitch/YouTube/Kick chat messages merged into one feed.

Display:
- Chat messages with platform icon (Twitch/YT/Kick), username (colored), message
- Messages fade in from bottom, scroll up
- Auto-removes after configurable time (30s/60s/never)

Implementation:
- New SSE channel on the overlay endpoint that forwards chat messages
- Twitch chat already received via tmi.js — emit to overlayBus with `type: 'chat'`
- YouTube chat already received via youtubeLiveChat.js — emit to overlayBus with `type: 'chat'`
- Kick chat would need a new integration (mark as "coming soon" for now)

Customization:
- Max messages shown
- Fade time
- Font size, colors, opacity
- Show/hide platform icons
- Show/hide usernames

### Overlay 5: Wind Direction

**Route:** `/overlay/iracing/wind/:token`
**Channels:** `wind`

Display:
- Circular compass (120x120px)
- Arrow showing wind direction relative to car heading
- Wind speed in center (km/h or mph)
- Headwind (red tint), tailwind (green tint), crosswind (yellow tint)
- Compass rotates as car turns, wind arrow stays in absolute direction

Customization:
- Size (small/medium/large)
- Units (km/h / mph / m/s)
- Show/hide speed number
- Opacity

### Overlay 6: Car Proximity (Spotter)

**Route:** `/overlay/iracing/proximity/:token`
**Channels:** `proximity`

Display:
- Top-down silhouette of a race car (centered)
- Left/right indicators that light up when a car is alongside
- Yellow = car alongside but safe gap
- Red = car overlapping, danger
- Optional: show gap distance in seconds

Customization:
- Size
- Colors
- Show/hide gap numbers
- Opacity

### Shared File Structure
```
public/overlay/iracing/
├── shared.js            # WebSocket client, reconnect logic, settings loader
├── shared.css           # Common styles, transparent background, fonts
├── standings.html + standings.js + standings.css
├── relative.html + relative.js + relative.css
├── fuel.html + fuel.js + fuel.css
├── chat.html + chat.js + chat.css
├── wind.html + wind.js + wind.css
└── proximity.html + proximity.js + proximity.css
```

### Overlay Routes
```
src/routes/overlay.js — add:
  GET /overlay/iracing/:type/:token — serves the overlay HTML page
```

---

## Sub-project 3: Dashboard UI

### iRacing Tab on Dashboard

New tab alongside Discord/Twitch/Kick: **iRacing** (using existing `.tab-iracing` CSS)

**Layout:**
1. **Bridge Download Card** — download link for Atleta Bridge `.exe`, version number, installation instructions
2. **Connection Status Card** — shows if bridge is detected (checks `ws://localhost:9100` from browser)
3. **Overlay Cards** (6 cards in 2-column grid) — each with:
   - Enable toggle
   - OBS URL with copy button
   - "Customize" button → opens overlay builder/settings
4. **Overlay Settings Page** — `/dashboard/iracing/overlays` — per-overlay customization (colors, fonts, sizes, layout options)

### DB Schema

New table `iracing_overlay_settings`:
```sql
CREATE TABLE IF NOT EXISTS iracing_overlay_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  streamer_id INTEGER NOT NULL,
  overlay_type TEXT NOT NULL,
  enabled INTEGER DEFAULT 0,
  settings TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (streamer_id) REFERENCES streamers(id) ON DELETE CASCADE,
  UNIQUE(streamer_id, overlay_type)
);
```

`settings` is a JSON string with overlay-specific configuration (colors, font size, number of rows, etc.).

### Routes
```
GET  /dashboard/iracing/overlays         — overlay settings page
POST /dashboard/iracing/overlays/:type   — save overlay settings
GET  /overlay/iracing/:type/:token       — serve overlay page (public)
```

---

## Implementation Phases

### Phase 1: Bridge App
- Set up Electron project in `bridge/` folder
- Implement iRacing SDK reader with `node-irsdk`
- WebSocket server with channel subscriptions
- Telemetry extraction for all 6 data channels
- Fuel calculator logic
- Relative gap calculations
- System tray with status icon
- Package as `.exe` installer

### Phase 2: Web Overlays
- Shared WebSocket client + reconnect logic
- Standings overlay
- Relative overlay
- Fuel calculator overlay
- Wind direction overlay
- Car proximity overlay
- Streaming chat overlay (uses SSE, not bridge)

### Phase 3: Dashboard UI
- iRacing tab with overlay cards
- DB table + routes for overlay settings
- Per-overlay customization pages
- Bridge download section
- Connection status check

---

## Technical Notes

- `node-irsdk` requires Windows — the bridge app is Windows-only
- The web overlays work on any OS since they're just browser pages
- Bridge WebSocket is local-only (localhost) — no internet required for telemetry
- Overlay styling/settings are stored on the server and loaded when the overlay page opens
- The streaming chat overlay is the exception — it connects to Atleta SSE, not the bridge
- Kick chat integration marked as "coming soon" in the chat overlay
