# Screenshot Lap Import from Garage61

## Overview

Add the ability to import race data from Garage61 screenshots on the track detail page. Users drop a screenshot, the system extracts race stats using GPT-4o vision, and the data feeds into the existing `track_stats` table.

## User Flow

1. User navigates to a track detail page (`/tracks/:trackName`)
2. Below the class tabs, there's an "Import Race Data" section with:
   - **Car class dropdown** — GTP, LMP2, GT3, GT4, LMP3, GTE, TCR, Porsche Cup, BMW M2, Toyota, Mazda (+ "Auto-detect" option)
   - **Race type dropdown** — Sprint, Open, Endurance, VRS Sprint, VRS Open, IMSA Sprint, IMSA Open, IMSA Endurance, Global Endurance, etc. (+ "Auto-detect" option)
   - **Screenshot drop zone** — drag & drop or click to browse (accepts PNG, JPG, WEBP)
3. User uploads a Garage61 screenshot
4. Screenshot is sent to `POST /api/track-stats/import-screenshot` with the track name + selected class/race type (or "auto" for auto-detect)
5. Server sends the image to GPT-4o vision API with a structured extraction prompt
6. Server returns parsed data: `{ carClass, raceType, avgLapTime, avgQualifyTime, avgPitTime, avgSOF, driverCount, estLaps }`
7. UI shows a **confirmation card** with the extracted values displayed in a readable format:
   - If class/race type was set to "Auto-detect", the dropdowns are pre-filled with the AI's detection
   - If manually selected, those values stay as the user chose
   - All numeric values are shown for review (lap times formatted as m:ss.xxx)
8. User reviews, can adjust the class/race type dropdowns, then clicks "Save"
9. Data is POSTed to existing `POST /api/track-stats` endpoint with the same rolling average upsert logic

## API

### POST /api/track-stats/import-screenshot

**Request:** multipart/form-data
- `image` — the screenshot file (PNG/JPG/WEBP, max 5MB)
- `trackName` — the track name (string)
- `carClass` — selected class or "auto"
- `raceType` — selected race type or "auto"

**Processing:**
1. Convert image to base64
2. Send to OpenAI GPT-4o vision API with extraction prompt (see below)
3. Parse the JSON response
4. If `carClass` or `raceType` was "auto", use the AI-detected values
5. If manually specified, override the AI detection with the user's choice

**Response:**
```json
{
  "ok": true,
  "data": {
    "carClass": "GT3",
    "raceType": "VRS Sprint",
    "avgLapTime": 92.456,
    "avgQualifyTime": 91.234,
    "avgPitTime": 28.5,
    "avgSOF": 2450,
    "driverCount": 24,
    "estLaps": 18
  }
}
```

**Error handling:**
- If OpenAI can't parse the screenshot: `{ ok: false, error: "Could not extract race data from this screenshot" }`
- If image is too large: 400 with size error
- If OpenAI API key missing: 500 with config error

### GPT-4o Vision Prompt

```
You are analyzing a screenshot from Garage61, a racing data website for iRacing.
Extract the following race statistics from the image. Return ONLY valid JSON, no other text.

{
  "carClass": "the car class (e.g. GT3, GTP, LMP2, GT4, LMP3, GTE, TCR, Porsche Cup, BMW M2, Toyota, Mazda) or null if not visible",
  "raceType": "the race/series type (e.g. VRS Sprint, VRS Open, IMSA Sprint, IMSA Open, IMSA Endurance, Global Endurance, Sprint, Open, Endurance) or null if not visible",
  "avgLapTime": average race lap time in seconds (e.g. 92.456 for 1:32.456) or null,
  "avgQualifyTime": average qualifying lap time in seconds or null,
  "avgPitTime": average pit stop time in seconds or null,
  "avgSOF": strength of field (iRating number) or null,
  "driverCount": number of drivers in the session or null,
  "estLaps": total number of race laps or null
}

Parse lap times from formats like "1:32.456" to seconds (92.456).
If a value is not visible in the screenshot, set it to null.
```

## UI Components

### Import Section (on track detail page)

Located below the class tabs and stats content. Collapsible — hidden by default, toggled via an "Import Race Data" button.

**Controls:**
- Car class dropdown: all classes from CLASS_ORDER + "Auto-detect" as first option
- Race type dropdown: all known race types + "Auto-detect" as first option
- Drop zone: same visual pattern as the .ibt upload zone (dashed border, drag & drop)
- "Analyzing..." spinner while waiting for API response

**Confirmation card:**
- Shows extracted values in a grid (label: value pairs)
- Lap times formatted as m:ss.xxx
- SOF formatted with comma separator
- Class and race type dropdowns remain editable
- "Save to Database" button (green) and "Cancel" button
- On save, calls `POST /api/track-stats` with the data formatted to match the existing payload structure

## Technical Details

- **OpenAI API:** Uses `OPENAI_API_KEY` env var (already exists for Whisper)
- **Model:** `gpt-4o-mini` (cheapest vision model, sufficient for structured text extraction)
- **Image handling:** Image is base64-encoded in memory, sent to OpenAI, then discarded. Not stored on disk or DB.
- **Auth:** The endpoint requires authentication (user must be logged in) since it calls an external API with cost implications
- **Rate:** No specific rate limiting beyond auth requirement — low-volume feature

## File Changes

| File | Change |
|------|--------|
| `src/server.js` | Add `POST /api/track-stats/import-screenshot` endpoint |
| `src/views/tracks.ejs` | Add import section UI below class tabs in detail view |

## Out of Scope

- Storing screenshots
- Batch import (multiple screenshots at once)
- Auto-detecting track name from screenshot (track is already known from the page)
- Editing individual extracted values before save (only class + race type are editable)
