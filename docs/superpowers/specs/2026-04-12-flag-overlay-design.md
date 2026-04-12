# Flag Overlay Design

**Date:** 2026-04-12
**Status:** Approved — ready for implementation plan
**Owner:** Bridge

## Summary

A new Bridge overlay (`flags`) that pops up a small animated waving flag whenever iRacing raises a green, yellow, blue, white, black, or checkered flag for the player. State-driven lifecycle: it appears when the flag is raised, stays visible for as long as iRacing keeps it active (minimum 3 seconds), and fades out when iRacing clears it. Priority ladder handles overlapping flags, a 15-second cooldown keeps blue flags from spamming in multi-class races.

The overlay follows every existing Bridge convention: small draggable dark panel, `overlay-utils.js` for drag/click-through/scale, sidebar entry in the control panel under the **Race** group, unit-tested pure-JS state module alongside `incidentTracker.js`.

## Goals & non-goals

### Goals
- Show the six flags listed above with the right color and label.
- Never miss a flag change — it should be visible the instant iRacing raises it.
- Never spam — blue-flag noise in multi-class is suppressed.
- Keep the rendering client dumb — all business logic lives in a testable pure-JS module.

### Non-goals
- **No sound.** Silent by default; can be added later.
- **No historical log.** This is an alert overlay, not a timeline.
- **No disqualify / meatball / furled / red flags.** Only the six flags the user asked for. Existing meatball/furled/disqualify tracking lives in `incidentTracker.js` and continues to work independently.
- **No sector yellows.** We don't try to distinguish local vs. full-course yellows — iRacing sets the same `yellow`/`yellowWaving` bits for both via `CarIdxSessionFlags`.
- **No auto-resize based on flag length.** Fixed window size.

## User stories

- *As a driver*, I want to see a waving yellow flag on my screen the moment a caution falls, so I can lift instantly.
- *As a driver in a multi-class race*, I want a single blue-flag alert per lapping car, not a continuous strobe.
- *As a driver getting a penalty*, I want to see a black flag clearly so I know to pit.
- *As a driver on the final lap*, I want a white flag reminder.
- *As a driver crossing the line at race end*, I want a checkered flag celebration.
- *As a user*, I want to drag the overlay wherever I want on my screen, like every other Bridge overlay.

## Architecture

```
iRacing SDK
    │
    ▼
telemetry.js   ── (per-poll tick, 10 Hz) ──▶  flagState.js  (pure factory, no electron)
    │                                             │
    │                                             ▼
    │                                        getState() → { activeFlag, since, rawBits }
    │                                             │
    ▼                                             │
broadcastToChannel('flags', …)  ◀───────────────┘
    │
    ├──▶ local WebSocket server  ──▶  flags.html  (waving SVG overlay)
    └──▶ pitwallUplink (future — not in this spec)
```

Files touched:

| File | Status | Role |
|------|--------|------|
| `bridge/flagState.js` | **NEW** | Pure-JS factory: priority ladder, blue throttle, state machine. |
| `bridge/telemetry.js` | modified | Instantiate `flagState`, call `tick()` per poll, broadcast on `flags` channel. |
| `bridge/overlays/flags.html` | **NEW** | Renders the waving SVG + label. Subscribes to `flags` WS channel. |
| `bridge/main.js` | modified | One entry added to the `OVERLAYS` array. |
| `bridge/control-panel.html` | modified | Sidebar entry, panel container, `overlays` list row, `CUSTOMIZE_FIELDS.flags` row. |
| `bridge/test-flagState.js` | **NEW** | `node:test` unit suite. |
| `bridge/tests/overlays.spec.js` | modified | Add `flags` to the Playwright fixture. |
| `bridge/tests/mock-data.js` | modified | Add a `flags` channel fixture. |
| `bridge/package.json` | modified | Version bump. |

## `flagState.js` module

Self-contained factory, same shape as `incidentTracker.js`. No electron, no SDK imports.

**Exports:** `createFlagState()` → `{ init, tick, getState, reset }`

### Constants

```js
const MIN_DWELL_MS = 3000;          // min time a flag stays on screen
const BLUE_COOLDOWN_MS = 15000;     // cooldown after blue clears

// iRacing irsdk_Flags bits (subset we care about)
const BIT_CHECKERED = 0x1;
const BIT_WHITE     = 0x2;
const BIT_GREEN     = 0x4 | 0x400;                    // green | greenHeld
const BIT_YELLOW    = 0x8 | 0x100 | 0x4000 | 0x8000;  // yellow | yellowWaving | caution | cautionWaving
const BIT_BLUE      = 0x20;
const BIT_BLACK     = 0x10000;

// Priority ladder (lower number = higher priority)
const PRIORITY = { black: 1, checkered: 2, white: 3, yellow: 4, blue: 5, green: 6 };
```

### Input to `tick()`

```js
tick({
  rawBits: number,   // CarIdxSessionFlags[playerCarIdx]
  tNow: number,      // Date.now()
});
```

### Output of `getState()`

```js
{
  activeFlag: 'black' | 'checkered' | 'white' | 'yellow' | 'blue' | 'green' | null,
  since: number | null,    // tNow when activeFlag first became non-null (for fade-in / animation)
  rawBits: number,         // echoed for debugging
}
```

### Internal state (`init()`)

```js
{
  displayed: null,                // currently-shown flag key or null
  displayedSince: 0,              // tNow when displayed became non-null
  lastRawBits: 0,
  blueWasPresented: false,        // was blue actually shown (not suppressed) in the previous tick
  blueCooldownUntil: 0,           // tNow after which blue is allowed to re-trigger
}
```

### `tick()` algorithm

1. Derive the set of active flag keys from `rawBits`. A flag key is active if any of its mapped bits are set.
2. Apply the blue-flag throttle (see below). Blue may get dropped from the active set.
3. Compute `candidate` = highest-priority flag in the filtered active set, or `null` if empty.
4. If `candidate !== null` and `candidate !== state.displayed`:
   `state.displayed = candidate; state.displayedSince = tNow`.
5. If `candidate === null`:
   only clear `state.displayed` once `tNow - state.displayedSince >= MIN_DWELL_MS`.
6. Update `blueWasPresented` based on whether blue was in the filtered active set.
7. Update `lastRawBits = rawBits`.

### Blue-flag throttle

- On the edge `blueWasPresented: true → false` (blue was being shown and just cleared), set `blueCooldownUntil = tNow + BLUE_COOLDOWN_MS`.
- When checking whether blue is "active": blue is active only if `rawBits` has blue **and** `tNow >= blueCooldownUntil`.
- Throttle does **not** interrupt an already-showing blue — if blue keeps waving continuously, `blueWasPresented` stays true, cooldown never starts.
- Throttle applies only to `blue`; other flags are unaffected by `blueCooldownUntil`.

### `reset()`

Calls `init()` — drops the cooldown, clears `displayed`. Called by `telemetry.js` on telemetry (re)connect so nothing stale carries over.

### No `onSessionChange()`

iRacing clears flags naturally between sessions; the state machine self-clears within `MIN_DWELL_MS`. A telemetry disconnect + reconnect is handled by `reset()`.

## `telemetry.js` wiring

All additions mirror the `incidentTracker` pattern.

**Module top (near line 24):**
```js
const { createFlagState } = require('./flagState');
```

**Instance creation (near line 197, next to `incidentTracker`):**
```js
const flagState = createFlagState();
```

**On telemetry (re)connect (around line 582):**
```js
flagState.reset();
```

**Per-poll tick (right after `incidentTracker.tick({…})`, ~line 1642):**
```js
try {
  flagState.tick({
    rawBits: (carIdxFlags && carIdxFlags[playerCarIdx]) || 0,
    tNow: Date.now(),
  });
} catch (e) { /* never let the flag tracker take down the poll loop */ }
```
Reuses the `carIdxFlags` read that `incidentTracker` already makes — no new SDK reads.

**Broadcast (new block right after the `session` channel broadcast, ~line 1070):**
```js
broadcastToChannel('flags', { type: 'data', channel: 'flags', data: flagState.getState() });
```
Every poll (10 Hz). Payload is ~60 bytes; bandwidth is negligible.

## `flags.html` overlay

Follows the Bridge overlay conventions — dark semi-transparent panel, header with title, body rendered dynamically from the `flags` WS channel.

### Structure

```html
<div class="overlay-panel">
  <div class="overlay-header">
    <span><span class="status-dot"></span>FLAGS</span>
  </div>
  <div class="flag-body" id="flag-body">
    <svg class="flag-svg" viewBox="0 0 140 96">
      <defs>
        <pattern id="checker" x="0" y="0" width="16" height="16" patternUnits="userSpaceOnUse">
          <rect x="0" y="0" width="8" height="8" fill="#000"/>
          <rect x="8" y="0" width="8" height="8" fill="#fff"/>
          <rect x="0" y="8" width="8" height="8" fill="#fff"/>
          <rect x="8" y="8" width="8" height="8" fill="#000"/>
        </pattern>
      </defs>
      <rect class="flag-pole" x="8" y="8" width="2" height="88" fill="#555"/>
      <path class="flag-fabric" d="M10 12 Q35 0, 60 12 T110 12 L110 60 Q85 72, 60 60 T10 60 Z">
        <animate attributeName="d"
          values="M10 12 Q35 0, 60 12 T110 12 L110 60 Q85 72, 60 60 T10 60 Z;
                  M10 12 Q35 24, 60 12 T110 12 L110 60 Q85 48, 60 60 T10 60 Z;
                  M10 12 Q35 0, 60 12 T110 12 L110 60 Q85 72, 60 60 T10 60 Z"
          dur="1.2s" repeatCount="indefinite"/>
      </path>
    </svg>
    <div class="flag-label" id="flag-label"></div>
  </div>
</div>
```

### Dynamic rendering

```js
const FLAG_STYLES = {
  green:     { color: '#22c55e', label: 'GREEN' },
  yellow:    { color: '#f7c948', label: 'YELLOW' },
  blue:      { color: '#3b82f6', label: 'BLUE' },
  white:     { color: '#ffffff', label: 'WHITE' },
  black:     { color: '#0a0a0a', label: 'BLACK' },
  checkered: { color: 'url(#checker)', label: 'CHECKERED' },
};
```

### Client state machine

```js
let lastActive = null;
onData('flags', data => {
  const active = data && data.activeFlag;
  if (active === lastActive) return;

  const body = document.getElementById('flag-body');
  if (active === null) {
    body.classList.remove('visible');
  } else {
    const style = FLAG_STYLES[active];
    fabric.setAttribute('fill', style.color);
    label.textContent = style.label;
    label.style.color = (active === 'black' || active === 'checkered') ? '#fff' : style.color;
    body.classList.add('visible');
  }
  lastActive = active;
});
```

### CSS transitions

```css
.flag-body { opacity: 0; transition: opacity 0.6s ease-out; }
.flag-body.visible { opacity: 1; transition: opacity 0.3s ease-in; }
```

### `overlay-utils.js` integration

One line, matching every other overlay:
```js
require('./overlay-utils').init({ headerToggle: true, drag: true, clickThrough: true, scale: true });
```

### Pitwall mode

Supports `?pitwall=1` for the Team Pitwall page — same pattern as other overlays. In pitwall mode the overlay skips the direct WebSocket connection and listens for `postMessage` from the parent page. The pitwall relay already forwards channel data, so no server-side work is needed.

## Control panel + `main.js` integration

### `bridge/main.js`

Add to the `OVERLAYS` array (near line 70):
```js
{ id: 'flags', name: 'Flags', width: 180, height: 130 },
```

### `bridge/control-panel.html`

1. Sidebar entry in the **Race** group next to `raceduration` (around line 642):
   ```html
   <div class="sidebar-item" data-panel="flags" onclick="navigateTo('flags')">
     <span class="sidebar-icon">&#128681;</span> Flags
   </div>
   ```
2. Empty panel container (around line 766):
   ```html
   <div class="content-panel" id="panel-flags"></div>
   ```
3. `overlays` list row (around line 1055):
   ```js
   { id: 'flags', icon: '&#128681;', name: 'Flags', width: 180, height: 130 },
   ```
4. `CUSTOMIZE_FIELDS.flags` entry:
   ```js
   flags: [
     { key: 'posX', label: 'Position X (px)', type: 'number', default: '0', min: -5000, max: 5000 },
     { key: 'posY', label: 'Position Y (px)', type: 'number', default: '0', min: -3000, max: 3000 },
     { key: 'autoHide', label: 'Auto-hide when iRacing closes', type: 'checkbox', default: true },
     { key: 'showBlue', label: 'Show blue flag alerts', type: 'checkbox', default: true },
   ],
   ```

Favorites / Recent / sidebar search / sidebar-state persistence all pick the new overlay up automatically because they iterate the `overlays` list.

### `showBlue` escape hatch

Some drivers will prefer to mute blue flags entirely in multi-class. When `showBlue` is false, the overlay drops blue from `FLAG_STYLES` lookup on the client side — the server module stays pure, no conditionals in `flagState.js`.

## Data flow details

### Flag bit sources

We read only `CarIdxSessionFlags[playerCarIdx]`. It contains both session-wide flags (green, yellow, white, checkered) and per-car flags (black, blue) for the player's car. No need to combine with the global `SessionFlags` variable.

### Broadcast cadence

Every poll (~10 Hz). Payload is tiny; downstream consumers can throttle if needed.

### Pitwall relay (future)

Not in scope for this spec, but the `flags` channel is designed to be relay-safe — the payload is a single small JSON object with no timestamps that would break serialization.

## Error handling

- `flagState.tick()` is wrapped in `try/catch` in `telemetry.js` with a comment explaining that the poll loop must never die from a tracker bug. Matches the `incidentTracker` pattern.
- `reset()` is idempotent.
- The overlay gracefully handles `data === null` or missing `activeFlag` — it treats them as "no flag" and fades out.

## Testing

### Unit tests — `bridge/test-flagState.js` (new)

`node:test` suite. Target ~20 tests.

**State-machine coverage:**
- starts idle (`activeFlag === null`)
- green bit → `green` active, `since` set
- yellow bit variants (`yellow`, `yellowWaving`, `caution`, `cautionWaving`) all resolve to `yellow`
- green bit variants (`green`, `greenHeld`) all resolve to `green`
- flag clears → still visible until `MIN_DWELL_MS` elapses, then `null`
- brief blip < 3s → flag stays on screen for the full 3s

**Priority coverage:**
- yellow + blue active → `yellow`
- black alone → `black`
- black + yellow → `black`
- yellow → green transition → `green`
- checkered + white → `checkered`

**Blue throttle coverage:**
- first blue shows
- blue clears → 10s later blue re-appears → suppressed
- blue clears → 16s later blue re-appears → shows
- throttle only applies to blue
- `reset()` clears the cooldown

**Run command:**
```sh
cd bridge && node --test test-incidentTracker.js test-sidebarState.js test-flagState.js
```

### UI tests — `bridge/tests/overlays.spec.js` (modified)

Add `flags` to the Playwright fixture alongside the existing 14 overlays:
- Bounds at 6 scales × 3 data scenarios (idle, mid-flag, transitioning)
- Font sizes
- Header toggle × 3 scales
- Render assertion per flag key (green/yellow/blue/white/black/checkered): correct fabric fill and label text
- Fade-in / fade-out transitions between states

Mock data for the `flags` channel goes in `bridge/tests/mock-data.js` — a small addition (one channel, a handful of scenarios).

### Manual test checklist

- Start a practice session, trigger a local yellow → overlay shows yellow for the duration of the caution.
- Race start → green flag appears, clears after 3s.
- Get a black flag (drive the wrong way in pits) → overlay shows black until cleared.
- Multi-class session with blue flags → blue shows once, 15s cooldown prevents spam.
- Cross the finish line on the final lap → white then checkered in sequence, checkered persists until next session.
- Drag the overlay around → position persists like other overlays.
- Toggle the header off → header disappears via `overlay-utils.js`.
- Toggle `showBlue` off in the control panel → blue flags no longer render.

## Rollout

Pure-additive change — nothing existing is modified behaviorally. Version bump (`bridge/package.json`), single commit, push to trigger the existing GitHub Actions bridge release workflow.

## Open questions

None. All clarifying questions from brainstorming have been resolved.
