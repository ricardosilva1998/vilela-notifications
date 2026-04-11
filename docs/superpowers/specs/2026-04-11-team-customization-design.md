# Team Customization — Picture & Banner

## Summary

Team owners can upload a **team picture** (circular, like user avatars) and a **banner** (wide header image) for their team. Both appear on the team detail page with interactive crop editors for upload. Only owners can upload (future-proofed for admin role).

## Layout — Team Detail Page

The current card header on `racing-team-detail.ejs` is replaced with a new banner + inline section:

1. **Banner** — full-width at the top of the card (~800×200 rendered), gradient fallback (`linear-gradient(135deg, #1a1a2e, #16213e, #0f3460)`) when no banner is uploaded.
2. **Inline section below banner** — circular team picture (56px displayed), team name, member count, role badge, and invite code (for owners). Matches the current card styling.

Owners see a camera/edit icon overlay on hover for both the picture and banner to trigger the crop editor modal.

## Crop Editors

Both editors use the same modal UX as the avatar crop editor on `racing-account.ejs` (canvas-based, drag to pan, scroll/pinch to zoom, "Save" button posts base64 to server).

### Team Picture
- **Shape:** Circular crop preview
- **Output:** 128×128 JPEG
- **Max size:** 500KB base64 (~700KB string length)
- **Displayed at:** 56px circular on the detail page

### Banner
- **Shape:** Rectangular crop preview, ~4:1 aspect ratio
- **Output:** 800×200 JPEG
- **Max size:** 700KB base64 (~1MB string length)
- **Displayed at:** full card width on the detail page

## Storage

Base64 data URLs stored directly in the `teams` table (same pattern as user avatars in `racing_users.avatar`).

### DB Migration

```sql
ALTER TABLE teams ADD COLUMN picture TEXT;
ALTER TABLE teams ADD COLUMN banner TEXT;
```

Auto-runs on startup in `src/db.js` migration block.

### Query Functions

- `updateTeamPicture(teamId, base64)` — updates `teams.picture`
- `updateTeamBanner(teamId, base64)` — updates `teams.banner`

## Routes

### `POST /racing/teams/:teamId/picture`
- **Auth:** Racing user, team member with `role === 'owner' || role === 'admin'`
- **Body:** JSON `{ picture: "data:image/jpeg;base64,..." }`
- **Validation:** Must start with `data:image/`, max 700KB string length
- **Response:** `{ ok: true }`

### `POST /racing/teams/:teamId/banner`
- **Auth:** Racing user, team member with `role === 'owner' || role === 'admin'`
- **Body:** JSON `{ banner: "data:image/jpeg;base64,..." }`
- **Validation:** Must start with `data:image/`, max 1MB string length
- **Response:** `{ ok: true }`

## Permission Model

Permission check uses `role === 'owner' || role === 'admin'`. The `admin` role does not exist yet in `team_members` — this future-proofs for when it's added. Currently only `owner` will pass.

## Out of Scope

- Team images on the team cards list page (`racing-teams.ejs`)
- Team images on pitwall or pitwall picker
- Team images in the Bridge control panel
- Team admin role implementation
- File-based storage (stays base64 in DB)
