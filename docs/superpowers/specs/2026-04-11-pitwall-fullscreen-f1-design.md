# Pitwall Redesign — Full-Screen F1 Style

**Date:** 2026-04-11
**Status:** Approved
**File:** `src/views/racing-pitwall.ejs`

## Overview

Redesign the pitwall viewer page from a card-based grid within the standard page layout into a full-screen, F1 TV broadcast-inspired telemetry dashboard. The page becomes a dedicated immersive experience with no nav/sidebar, drag-and-drop panel customization, and the Atleta Purple color theme.

## Current State

The existing pitwall (`racing-pitwall.ejs`) renders inside the standard header/footer layout with:
- A "Team Drivers" card grid at the top for driver selection
- A 2-column grid of 9 iframe panels (standings, relative, fuel, inputs, trackmap, weather, wind, stintlaps, raceduration)
- Placeholder "Waiting for driver..." text until a driver is selected
- WebSocket connection for driver online/offline status

All WebSocket relay infrastructure (`pitwallRelay.js`), Bridge uplink (`pitwallUplink.js`), team management routes (`racing-team.js`), and overlay dual-mode support are fully built and unchanged by this redesign.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Layout style | F1 TV Broadcast — 3-column asymmetric + bottom strip | Standings-dominant hierarchy matches real pitwall priorities |
| Page chrome | Full-screen, no nav/sidebar | Maximum data density; dedicated immersive experience |
| Driver switching | Avatar dots in timing bar | Minimal footprint, always visible, very F1 |
| Panels | All 9 (standings, relative, fuel, inputs, trackmap, weather, wind, stintlaps, raceduration) | User wants full data; layout accommodates all |
| Customization | Drag-and-drop rearrange + resize by dragging edges | Full flexibility, layout persisted per-user |
| Color palette | Atleta Purple (existing CSS variables) | Brand consistency across platform |
| Exit | Back button + ESC key | Quick escape from full-screen mode |

## Page Structure

### Full-Screen Shell

The page renders as a standalone full-screen document — no `header.ejs`/`footer.ejs` includes. It includes its own minimal `<head>` with the required fonts and CSS variables from the Atleta design system (copied inline, not importing header.ejs).

```
┌─────────────────────────────────────────────────────────────────┐
│ [←] LIVE │ P3 Driver Alpha │ 1:23.456 │ LAP 12/24 │ 42:15 │ (●)(●)(○) │
├──────────────┬──────────────────┬───────────────────────────────┤
│              │   Relative       │   Track Map                   │
│  Standings   │                  │                               │
│  (full-ht)   ├────────┬─────────┼─────────────┬─────────────────┤
│              │ Fuel   │Duration │  Weather    │  Wind           │
├──────────────┴────────┴─────────┴─────────────┴─────────────────┤
│  Inputs (compact)     │  Session Laps (horizontal scroll)       │
└───────────────────────┴─────────────────────────────────────────┘
```

### Timing Bar (Top)

Fixed bar across the top of the viewport. Contains:

1. **Back button** — `←` icon, navigates to `/racing/team`. Also triggered by ESC key.
2. **LIVE badge** — Red pill with "LIVE" text when driver is in an active session. Hidden when no driver selected.
3. **Driver info** — Position badge (e.g., "P3"), driver name, best/last lap time. Shows "Select a driver" when none selected.
4. **Session info** — Lap count (e.g., "LAP 12/24"), time remaining. Populated from `session` channel data.
5. **Connection status** — Small colored dot (green = connected, yellow = connecting, gray = disconnected). No label text — dot only.
6. **Driver dots** — Right-aligned. One circle per team member, showing first two initials. Green border = online (Bridge connected), gray border = offline. The currently spectated driver has a filled accent background. Click to switch. Hovering shows tooltip with full name + online status.

The timing bar height is fixed at 48px. Background: `var(--bg-surface)` with bottom border `var(--border)`.

### Panel Grid (Main Area)

The area below the timing bar and above the bottom strip fills the remaining viewport height (`calc(100vh - 48px - bottomStripHeight)`).

**Default layout** (3-column asymmetric):
- **Left column (ratio ~2.5fr):** Standings — full height of the main area
- **Middle column (ratio ~2fr):** Relative (top ~60%), Fuel + Race Duration side-by-side (bottom ~40%)
- **Right column (ratio ~1.5fr):** Track Map (top ~60%), Weather + Wind side-by-side (bottom ~40%)

**Bottom strip** (fixed ~80px height, full width):
- **Left (~30%):** Inputs — compact horizontal layout: throttle bar (green), brake bar (red), gear number, speed. No trace graph in this compact view.
- **Right (~70%):** Session Laps — horizontal scrollable row of lap time chips. Best lap highlighted in purple. Current lap on the right edge. Shows lap number + time per chip.

### Panel Rendering

Each panel is an `<iframe>` loading the existing Bridge overlay HTML files via the pitwall relay path (`/pitwall/overlays/standings.html?ws=...&driver=...`). This is unchanged from the current implementation.

Panel containers have:
- A small uppercase label in the top-left corner (e.g., "STANDINGS") — 9px, `text-transform: uppercase`, `letter-spacing: 0.5px`, color `var(--text-muted)`
- No card-style background — panels sit directly on the page background with subtle 1px borders (`var(--border)`) between them
- Iframes fill the panel container minus the label height

When no driver is selected, panels show centered placeholder text "Waiting for driver..." in `rgba(255,255,255,0.12)`.

## Drag-and-Drop Customization

### Interaction Model

1. **Enter edit mode** — A small gear icon in the timing bar (left of driver dots). Click toggles edit mode. Visual indicator: panel borders glow with accent color, drag handles appear on each panel label.
2. **Drag to rearrange** — Grab a panel by its label bar and drag to swap positions with another panel. Panels snap to grid slots. During drag, the target slot highlights.
3. **Resize by dragging edges** — Panel dividers (the borders between panels) are draggable. Cursor changes to `col-resize` or `row-resize` on hover. Dragging redistributes space between adjacent panels. Minimum panel size enforced (150px width, 100px height).
4. **Exit edit mode** — Click gear icon again, or press ESC (if no panel is being dragged). Layout auto-saves.

### Layout Persistence

Layout is stored as a JSON object in `localStorage` under key `pitwall-layout-v1`:

```json
{
  "panels": [
    { "id": "standings", "gridArea": "1 / 1 / 3 / 2", "visible": true },
    { "id": "relative", "gridArea": "1 / 2 / 2 / 3", "visible": true },
    { "id": "fuel", "gridArea": "2 / 2 / 3 / 2.5", "visible": true },
    ...
  ],
  "columnRatios": [2.5, 2, 1.5],
  "rowRatios": [0.6, 0.4],
  "bottomStripHeight": 80,
  "version": 1
}
```

A "Reset layout" button in the gear dropdown restores defaults.

### Implementation Approach

Use CSS Grid with `grid-template-columns` and `grid-template-rows` set from the stored ratios. Panel placement via `grid-area` property. Drag/resize logic is vanilla JS (no library) — the existing codebase has no drag libraries and this keeps it consistent.

Key implementation details:
- Drag handles: mousedown on panel label starts drag. mousemove updates a ghost element. mouseup on target slot triggers swap.
- Resize: mousedown on a border element (thin invisible div overlaid on grid gaps). mousemove adjusts the `fr` ratios of adjacent columns/rows. mouseup saves.
- All state tracked in a plain JS object, serialized to localStorage on change.
- On page load: read localStorage, apply layout. If no saved layout, use defaults.

## Panel Specifications

Each panel renders an existing overlay iframe. No overlay code changes needed — the overlays already support the `?ws=` parameter for pitwall mode.

| Panel | Overlay File | Default Position | Notes |
|-------|-------------|------------------|-------|
| Standings | standings.html | Left column, full height | Dominant panel |
| Relative | relative.html | Middle column, top | |
| Fuel | fuel.html | Middle column, bottom-left | Side-by-side with Duration |
| Race Duration | raceduration.html | Middle column, bottom-right | Side-by-side with Fuel |
| Track Map | trackmap.html | Right column, top | |
| Weather | weather.html | Right column, bottom-left | Side-by-side with Wind |
| Wind | wind.html | Right column, bottom-right | Side-by-side with Weather |
| Inputs | inputs.html | Bottom strip, left | Compact horizontal mode |
| Session Laps | stintlaps.html | Bottom strip, right | Horizontal scroll mode |

## Styling

### Colors (Atleta Purple Theme)

All values from existing CSS custom properties in `header.ejs`:

- **Page background:** `var(--bg-base)` (#0c0d14)
- **Timing bar / panel backgrounds:** `var(--bg-surface)` (#141520)
- **Panel borders:** `var(--border)` (rgba(255,255,255,0.06))
- **Edit mode glow:** `var(--accent)` (#9146ff)
- **LIVE badge:** `#e10600` (F1 red — the one F1-specific color kept for the LIVE indicator)
- **Driver online:** `var(--success)` (#3ecf8e)
- **Driver offline:** `var(--text-muted)` (#5c5b6e)
- **Text:** `var(--text-primary)`, `var(--text-secondary)`, `var(--text-muted)` as appropriate

### Typography

- **Timing bar data:** `monospace` for lap times, positions, lap counts (matches F1 broadcast aesthetic)
- **Panel labels:** `var(--font-body)` (DM Sans), 9px uppercase
- **Driver dots initials:** `var(--font-display)` (Outfit), 9px bold

### No Header/Footer

The page does NOT include `header.ejs` or `footer.ejs`. It is a standalone HTML document with:
- Inline `<style>` block copying only the needed CSS variables and base styles
- Google Fonts link for Outfit + DM Sans
- Lucide icons script for the back arrow and gear icon

## WebSocket Integration

No changes to the WebSocket protocol or relay infrastructure. The existing JS logic from `racing-pitwall.ejs` is preserved:

- Connect to `/ws/pitwall` on page load
- Receive `auth-ok` with `activeDrivers` list → update driver dot borders
- Receive `driver-online`/`driver-offline` → update driver dot borders
- On driver dot click → `subscribe` message with all channels + selected driverId → load iframe srcs
- On deselect → clear iframe srcs, show placeholders
- Reconnect on disconnect (3s delay)

The only change: driver selection triggers via clicking timing bar dots instead of clicking card elements.

## ESC Key Behavior

- If in edit mode and not dragging → exit edit mode
- If not in edit mode → navigate back to `/racing/team`

## Route

No route changes. The page is still served at `/racing/pitwall` by the existing `racing-team.js` route handler. Only the EJS template changes.

## What Does NOT Change

- `pitwallRelay.js` — WebSocket relay server (untouched)
- `pitwallUplink.js` — Bridge uplink (untouched)
- `racing-team.js` — Routes and team management (untouched)
- Bridge overlay HTML files — All 9 overlays render unchanged in iframes
- WebSocket protocol — Same messages, same channels, same auth
- Database — No schema changes
- Team management UI — `/racing/team` page unchanged

## Files Changed

| File | Change |
|------|--------|
| `src/views/racing-pitwall.ejs` | Complete rewrite — full-screen F1 layout with drag/drop |

Single file change. Everything else (relay, uplink, routes, overlays) stays as-is.
