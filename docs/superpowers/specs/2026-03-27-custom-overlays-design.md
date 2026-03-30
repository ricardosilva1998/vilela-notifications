# Custom Overlays Design Spec

## Goal

Add a template-based custom overlay system to vilela-notifications that lets the streamer create, customize, and control overlays via chat commands. Overlays include scene banners (Starting Soon, BRB, Ending), info bars/tickers (social media, schedule, scrolling text), custom alerts (image+sound popups, text popups), and static content panels.

## User Decisions

- **Overlay types:** Scene banners, info bars/tickers, custom alerts, static panels
- **Control method:** Chat commands (`!brb`, `!starting`, etc.) with "always on" option for static content
- **Creation flow:** Pre-made templates with customizable text, colors, fonts, images
- **Dashboard UI:** Table list with toggle switches, name, type, command, status
- **OBS setup:** One browser source per type (3 new: scenes, bar, custom-alerts)

## Data Model

### `custom_overlays` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY | Auto-increment |
| `streamer_id` | INTEGER | FK to streamers |
| `type` | TEXT | `"scene"`, `"bar"`, `"custom-alert"` |
| `name` | TEXT | Display name ("Starting Soon") |
| `template` | TEXT | Template ID ("centered-text", "split-layout", "full-image", "social-bar", "ticker", "image-popup", "text-popup") |
| `chat_command` | TEXT | Trigger command without `!` prefix ("brb", "starting"). NULL for always-on overlays |
| `config` | TEXT (JSON) | Template-specific settings (see below) |
| `is_active` | INTEGER | 0 or 1 — whether currently showing |
| `always_on` | INTEGER | 0 or 1 — if 1, overlay is always visible (no chat toggle) |
| `sort_order` | INTEGER | Display order in dashboard |
| `created_at` | TEXT | ISO timestamp |

### Config JSON by template

**centered-text:**
```json
{
  "heading": "STARTING SOON",
  "subtext": "Stream begins shortly...",
  "font": "Montserrat",
  "textColor": "#FFFFFF",
  "bgType": "gradient",
  "bgColor1": "#1a1a3e",
  "bgColor2": "#2d1b69",
  "bgImage": null,
  "showCountdown": true,
  "countdownMinutes": 5
}
```

**split-layout:**
```json
{
  "heading": "BRB",
  "subtext": "Be right back!",
  "font": "Montserrat",
  "textColor": "#FFFFFF",
  "bgColor": "#1a1a3e",
  "image": "/uploads/custom/brb-image.png",
  "imageSide": "left",
  "showCountdown": true,
  "countdownMinutes": 5
}
```

**full-image:**
```json
{
  "image": "/uploads/custom/starting-soon-bg.png",
  "overlayText": "",
  "textColor": "#FFFFFF",
  "textPosition": "center"
}
```

**social-bar:**
```json
{
  "links": [
    { "platform": "twitter", "handle": "@vilela" },
    { "platform": "instagram", "handle": "@vilela" },
    { "platform": "youtube", "handle": "vilela" }
  ],
  "bgColor": "#1a1a2e",
  "textColor": "#FFFFFF",
  "font": "System Default",
  "position": "bottom",
  "scrolling": false
}
```

**ticker:**
```json
{
  "text": "Follow on Twitter @vilela | Next stream: Wednesday 8PM",
  "bgColor": "#1a1a2e",
  "textColor": "#FFFFFF",
  "font": "System Default",
  "scrollSpeed": "medium",
  "position": "bottom"
}
```

**image-popup:**
```json
{
  "image": "/uploads/custom/hype-alert.gif",
  "sound": "/uploads/custom/hype-alert.mp3",
  "duration": 5,
  "animation": "zoom",
  "volume": 0.8
}
```

**text-popup:**
```json
{
  "text": "HYPE!",
  "font": "Bangers",
  "textColor": "#FFD700",
  "fontSize": "4rem",
  "bgColor": "transparent",
  "duration": 3,
  "animation": "zoom",
  "sound": null,
  "volume": 0.8
}
```

## OBS Browser Sources

Three new sources, alongside existing alerts and sponsors:

| Source | URL | Purpose |
|--------|-----|---------|
| Alerts (existing) | `/overlay/alerts/TOKEN` | Follow, sub, raid notifications |
| Sponsors (existing) | `/overlay/sponsors/TOKEN` | Sponsor image rotation |
| Scenes | `/overlay/scenes/TOKEN` | Starting Soon, BRB, Ending banners |
| Info Bar | `/overlay/bar/TOKEN` | Social bar, schedule, ticker |
| Custom Alerts | `/overlay/custom-alerts/TOKEN` | Custom image/text popups |

Each source connects via SSE to receive toggle/config events. On connect, the server sends current state of all overlays for that type so the source shows the correct state immediately.

## SSE Events

### Scene overlay events
```json
{ "type": "scene-toggle", "overlay": { "id": 1, "template": "centered-text", "config": {...}, "is_active": true } }
```

### Bar overlay events
```json
{ "type": "bar-toggle", "overlay": { "id": 3, "template": "social-bar", "config": {...}, "is_active": true } }
```

### Custom alert events
```json
{ "type": "custom-alert-trigger", "overlay": { "id": 5, "template": "image-popup", "config": {...} } }
```
Custom alerts are fire-and-forget — they show for their configured duration then disappear. They don't have an `is_active` toggle state.

### Config event (on SSE connect)
```json
{ "type": "config", "serverVersion": "abc123", "overlays": [ ...all overlays of this type... ] }
```

## Chat Command Flow

1. Message arrives in `chatManager`
2. Check if message starts with `!` and matches a custom overlay `chat_command`
3. If match found:
   - For scenes/bars: toggle `is_active` in database, emit SSE event
   - For custom alerts: don't toggle state, just emit the trigger event (alert shows for duration then disappears)
4. Commands are only processed from the streamer and moderators (new permission check — current `handleMessage` processes all users, so add `isBroadcaster || isMod` check before custom overlay commands)

### Command registration

On startup and whenever overlays are created/updated/deleted, reload the command map from the database. The map is `{ "brb": overlayId, "starting": overlayId }`. No bot restart needed.

## Templates

### Scene Templates

**centered-text** — Full-screen overlay with centered heading, optional subtext, optional countdown timer. Background is solid color, gradient, or uploaded image.

**split-layout** — Two-column layout: image on one side, text + optional countdown on the other. Background color behind both.

**full-image** — Uploaded image fills the entire source. Optional text overlay on top with configurable position (top/center/bottom).

### Info Bar Templates

**social-bar** — Horizontal strip with platform icons and handles. Positioned at top or bottom. Can be static or slowly scrolling. Platform icons: Twitter/X, Instagram, YouTube, Twitch, TikTok, Discord, GitHub, Facebook.

**ticker** — Scrolling text marquee. Customizable text, scroll speed (slow/medium/fast), bar color, text color. Positioned at top or bottom.

### Custom Alert Templates

**image-popup** — Uploaded image (PNG/GIF) appears centered on screen for configurable duration with animation (fade/zoom/slide). Optional sound file plays on trigger.

**text-popup** — Large styled text appears on screen for configurable duration with animation. Optional sound. Useful for "HYPE!", "GG", or custom celebration text.

## Dashboard UI

### Custom Overlays page (`/dashboard/custom-overlays`)

**Table list layout:**
- Columns: Name, Type, Command, Status, Toggle
- `+ New Overlay` button top-right
- Click row to edit overlay
- Toggle switch to manually show/hide (same as chat command)
- Delete button (with confirmation)

### Creation flow (3 steps)

**Step 1 — Choose Template:**
- Tab bar: Scenes | Info Bars | Alerts
- Visual template cards with preview thumbnails
- Click to select

**Step 2 — Customize:**
- Left: form fields specific to the selected template
- Right: live preview (16:9 aspect ratio)
- Fields update preview in real-time

**Step 3 — Set Command:**
- Chat command input with `!` prefix shown
- "Always on" checkbox (disables command input)
- Create / Save button

### Dashboard integration
- New "Custom Overlays" card on main dashboard linking to the management page
- New OBS URLs shown in overlay builder URL dropdown and overlay config page

## File Structure

### New files
- `src/routes/customOverlays.js` — Express router: CRUD routes, SSE endpoints, file upload
- `src/views/custom-overlays.ejs` — Management page with table list and create/edit modal
- `public/overlay/scenes.js` — OBS client: connects SSE, renders scene templates
- `public/overlay/bar.js` — OBS client: connects SSE, renders info bar templates
- `public/overlay/custom-alerts.js` — OBS client: connects SSE, renders alert templates

### Modified files
- `src/db.js` — `custom_overlays` table creation, CRUD methods (`addCustomOverlay`, `updateCustomOverlay`, `deleteCustomOverlay`, `getCustomOverlays`, `getCustomOverlayByCommand`, `toggleCustomOverlay`)
- `src/server.js` — Mount `/dashboard/custom-overlays` and `/overlay/scenes|bar|custom-alerts` routes
- `src/services/chatManager.js` — Load custom commands on startup, listen for `!` commands, toggle overlays and emit SSE events
- `src/views/dashboard.ejs` — Add "Custom Overlays" card linking to management page
- `src/views/overlay-builder.ejs` — Add new OBS URLs to the URL dropdown
- `src/views/overlay-config.ejs` — Show all 5 OBS source URLs

## Upload Handling

Custom overlay images and sounds are uploaded to `data/uploads/custom/`. A new `express.static` mount is needed in `server.js` to serve these files (same pattern as existing sounds/sponsors mounts).

The upload route accepts:
- Images: PNG, JPG, GIF, WebP (max 5MB)
- Sounds: MP3, WAV, OGG (max 2MB)

Files are named `{overlayId}-{field}-{timestamp}.{ext}` to avoid conflicts.

## Countdown Timer

Scene overlays can have an optional countdown. When activated:
1. Chat command includes optional duration: `!starting 5` (5 minutes) or just `!starting` (uses configured default)
2. The SSE event includes `countdownMinutes`
3. Client-side JS runs the countdown, updating every second
4. When countdown hits 0, the overlay stays visible (streamer dismisses manually with same command)

## Error Handling

- Duplicate chat commands: Prevent at creation time. Show error if command already in use.
- Missing images: Show template with placeholder/solid color if image URL 404s.
- SSE disconnect: Same reconnection pattern as existing overlays (manual 5s retry).
- Invalid template config: Validate on save, use template defaults for missing fields.

## Verification

1. Create a "Starting Soon" scene overlay with centered-text template → customize colors/text → set `!starting` command → save
2. Open `/overlay/scenes/TOKEN` in browser → type `!starting` in Twitch chat → verify overlay appears with correct design
3. Type `!starting` again → verify overlay hides
4. Create a social bar with "always on" → open `/overlay/bar/TOKEN` → verify it shows immediately
5. Create an image-popup alert with `!hype` command → trigger in chat → verify it shows for configured duration then disappears
6. Edit an existing overlay → change colors → save → verify OBS updates without refresh
7. Delete an overlay → verify it disappears from dashboard and OBS
8. Check all 5 OBS URLs appear in overlay builder dropdown and overlay config page
