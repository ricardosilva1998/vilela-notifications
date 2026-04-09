# VTuber Face Tracker — Design Spec

## Overview

A browser-based 3D face tracker that lets streamers display an animated VRM avatar on their stream via OBS Browser Source. Webcam-driven face tracking (head rotation, eye movement, mouth sync) runs entirely client-side using MediaPipe Face Landmarker + Three.js + @pixiv/three-vrm. Streamers pick from bundled models or upload their own VRM files.

## Architecture

### Client-Side Stack (all in-browser, zero server processing)

- **MediaPipe Face Landmarker** — ML face detection, returns 478 face landmarks + blend shapes (eye blink, mouth open, brow movement, etc.)
- **Three.js** — 3D rendering engine
- **@pixiv/three-vrm** — loads VRM avatar models into Three.js, maps blend shapes and bone rotations to the model

### Server-Side (Express, minimal)

- Serves the VTuber EJS page at `/vtuber/:token`
- API endpoints for model listing, upload, deletion, and selection
- Static file serving for bundled models (`public/vtuber/models/`) and custom uploads (`data/vtuber-models/`)

### URL Scheme

- `/vtuber/:token` — dashboard mode (dark background, webcam preview, FPS counter)
- `/vtuber/:token?mode=stream` — OBS mode (transparent background, avatar only, no UI)
- Token reuses the existing streamer overlay token — no extra auth needed

## Dashboard UI — Experimental Tab

The existing Experimental tab in `dashboard.ejs` is replaced with:

### 1. Info Card
- Description text: "Track your face with your webcam and display an animated 3D avatar on your stream via OBS Browser Source."
- 3-step instructions: Pick a model → Launch tracker & allow camera → Copy OBS URL & add as Browser Source

### 2. Model Selector Card
- **Header row**: "Choose Avatar" title + "+ Upload VRM" button (file picker, .vrm only)
- **Category filter pills**: All | Anime | Animals | Robots | Custom
  - "Custom" category shows only the streamer's uploaded models
  - "All" shows bundled + custom
- **Model grid**: `grid-template-columns: repeat(auto-fill, minmax(100px, 1fr))`
  - Each cell: thumbnail area (3D preview or placeholder icon) + model name
  - Selected model: purple border glow (`#667eea`) + checkmark badge
  - Clicking a model calls `PUT /api/vtuber/select` and updates the iframe if tracker is running
  - Custom models show a delete button (X) on hover

### 3. Tracker Toolbar
- Left: status indicator dot (grey=stopped, green=running) + status text ("Not started" / "Running — Model Name")
- Right: "Copy OBS URL" button + "Launch Tracker" / "Stop Tracker" toggle button

### 4. Preview Area
- Iframe embedding `/vtuber/:token` (dashboard mode)
- 500px height, dark background
- Shows placeholder with face icon + "Click Launch Tracker to start" when inactive

## VTuber Page — `/vtuber/:token`

Single EJS page that handles both modes.

### Dashboard Mode (default)
- Dark solid background (`#1a1a2e`)
- Full-viewport Three.js canvas with the 3D avatar centered
- Small webcam preview in bottom-left corner (120x90px, border-radius, semi-transparent border)
- FPS + tracking status overlay in top-right corner (monospace, semi-transparent)
- Loads the streamer's selected model from the API

### Stream Mode (`?mode=stream`)
- Transparent background (`background: transparent` on body and canvas `alpha: true`)
- Canvas fills the entire viewport
- No webcam preview, no FPS counter, no UI elements
- Just the animated 3D avatar — OBS renders transparency as chroma

### Face Tracking Pipeline
1. `navigator.mediaDevices.getUserMedia({ video: true })` — get webcam stream
2. MediaPipe `FaceLandmarker.detectForVideo()` — extract face landmarks + blend shapes each frame
3. Map blend shapes to VRM model:
   - **Eyes**: `eyeBlinkLeft`, `eyeBlinkRight`, `eyeLookIn/Out/Up/Down`
   - **Mouth**: `mouthOpen`, `mouthSmile`, `jawOpen`
   - **Brows**: `browInnerUp`, `browOuterUp`, `browDown`
4. Calculate head rotation from landmark positions (pitch, yaw, roll)
5. Apply rotations to VRM model's head/neck bones via `vrm.humanoid.getNormalizedBoneNode()`
6. Three.js renders the scene each frame via `requestAnimationFrame`

### Libraries (loaded via CDN, no build step)
- `@mediapipe/tasks-vision` — Face Landmarker
- `three` — 3D engine
- `@pixiv/three-vrm` — VRM loader + runtime

## Database Schema

### New table: `vtuber_models`
```sql
CREATE TABLE IF NOT EXISTS vtuber_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  streamer_id INTEGER REFERENCES streamers(id),  -- NULL for bundled
  name TEXT NOT NULL,
  category TEXT NOT NULL,  -- 'anime', 'animal', 'robot', 'custom'
  filename TEXT NOT NULL,
  is_bundled INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

### Altered table: `streamers`
```sql
ALTER TABLE streamers ADD COLUMN vtuber_model_id INTEGER REFERENCES vtuber_models(id);
```

### Seed data
On startup, `db.js` seeds bundled models into `vtuber_models` (with `is_bundled = 1`, `streamer_id = NULL`) if they don't already exist. Uses filename as the uniqueness check.

## API Endpoints

All model management endpoints go in `routes/dashboard.js` (behind auth middleware).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/vtuber/models` | Yes | List bundled models + current streamer's custom models |
| POST | `/api/vtuber/models` | Yes | Upload custom VRM (multipart, .vrm only, stored in `data/vtuber-models/`) |
| DELETE | `/api/vtuber/models/:id` | Yes | Delete custom model (only if `streamer_id` matches, cannot delete bundled) |
| PUT | `/api/vtuber/select` | Yes | Set `streamers.vtuber_model_id` to chosen model ID |
| GET | `/vtuber/:token` | No | VTuber face tracker page (token-based, like overlay) |

### Upload handling
- Raw request body upload (same pattern as existing sound/sponsor uploads in the project — no multer dependency)
- Client sends file via `fetch()` with the VRM file as the request body + filename in a header
- Server writes chunks to `data/vtuber-models/{streamer_id}_{timestamp}_{original_name}.vrm`
- Max file size: 50MB (VRM models can be large), enforced via `Content-Length` check
- On upload, inserts row into `vtuber_models` with `category = 'custom'`, `is_bundled = 0`

## File Storage

### Bundled models: `public/vtuber/models/`
- Shipped with the app, committed to git
- 4-6 CC0/public domain VRM files sourced from VRoid Hub sample models
- Served via Express static middleware at `/vtuber/models/`
- Cannot be deleted by users

### Custom uploads: `data/vtuber-models/`
- Persistent volume on Railway (same pattern as `data/sounds/`, `data/sponsors/`)
- Served via Express static route at `/vtuber-models/`
- Per-streamer, deletable by owner

## Starter Models (Bundled)

6 models across categories, all CC0/public domain:

| Name | Category | Description | Source |
|------|----------|-------------|--------|
| VRM Default | anime | Standard VRoid sample character | VRoid Hub (Pixiv CC0) |
| Vita | anime | Female anime character | VRoid Hub CC0 |
| Haruto | anime | Male anime character | VRoid Hub CC0 |
| Mech Unit | robot | Mechanical/robot humanoid | Free VRM CC0 |
| Neko | animal | Cat-eared humanoid | Free VRM CC0 |
| Kitsune | animal | Fox spirit humanoid | Free VRM CC0 |

During implementation, source actual CC0 VRM files from VRoid Hub (https://hub.vroid.com — filter by "free download" + "modification allowed"). If specific models aren't available, use the VRoid Studio default export models (AvatarSample_A/B) which are CC0 by Pixiv. Start with whatever CC0 VRMs are readily available — the exact lineup can be adjusted later since users can upload their own.

## Files to Create/Modify

### New files
- `src/views/vtuber.ejs` — face tracker page (Three.js + MediaPipe + VRM rendering)
- `src/routes/vtuber.js` — route for `/vtuber/:token` page
- `public/vtuber/models/` — directory for bundled VRM files
- `data/vtuber-models/` — directory for custom uploads (`.gitkeep`)

### Modified files
- `src/db.js` — add `vtuber_models` table migration + seed bundled models + add `vtuber_model_id` column to streamers
- `src/server.js` — mount vtuber route, add static route for `data/vtuber-models/`
- `src/routes/dashboard.js` — add model CRUD API endpoints + upload handling
- `src/views/dashboard.ejs` — replace Experimental tab UI with model selector + updated iframe

## Out of Scope
- Live model switching via SSE (dashboard controls only for now)
- Model thumbnail generation (use placeholder icons per category)
- Custom model validation beyond file extension
- Model sharing between streamers
- VRM model editing/customization within the app
