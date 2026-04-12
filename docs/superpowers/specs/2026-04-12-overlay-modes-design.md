# Bridge overlay modes: per-state visibility matrix

**Status:** design approved, ready for implementation plan
**Date:** 2026-04-12
**Scope:** `bridge/` only — no server, DB, or web dashboard changes

## Problem

The Bridge currently has a single `autoHideOverlays` boolean. When iRacing connects, *every* enabled overlay shows. When it disconnects, *every* enabled overlay hides. That's a two-state all-or-nothing model.

What the user actually wants is three states and per-overlay control over each:

1. **iRacing not running** — Bridge sitting idle
2. **In garage** — iRacing running, player parked in their garage stall with the setup/menu open
3. **On track** — iRacing running, player in the car (including mid-race pit stops)

Some overlays (Standings, Relative, Track Map, Race Duration) are noise while parked in the garage tweaking setup — the user wants them to disappear in that state and reappear the moment they click "Drive".

## Goals

- Three discrete modes driven from a single source of truth
- Per-overlay visibility for each mode, configurable in one dedicated control-panel page
- Default behavior matches the current `autoHideOverlays = true` default on existing installs (zero surprise)
- No debounce, no heuristics — detection comes straight from the `IsInGarage` SDK flag
- All three state transitions are visibly correct: closed ↔ garage, garage ↔ on-track

## Non-goals

- No server-side visibility config (this is a local per-user preference)
- No separate per-mode overlay positions/sizes — only show/hide
- No additional finer-grained modes (e.g. "in pit lane", "in replay") — the three modes cover the stated need; if we find edge cases later we can extend without breaking the schema
- No UI in the individual overlay panels in the categorized accordion — the matrix is the one and only place

## State model

Three modes, derived in a single place (`main.js`). **Mode identifiers are camelCase and match the settings keys exactly**, so no string translation is needed when reading visibility:

| Mode | Trigger |
|---|---|
| `notRunning` | telemetry not connected to iRacing (`iracing: false`) |
| `garage` | connected AND `IsInGarage === true` |
| `onTrack` | connected AND `IsInGarage === false` |

`IsInGarage` is the iRacing SDK flag exposed by `@emiliosp/node-iracing-sdk` as `VARS.IS_IN_GARAGE` (`'IsInGarage'`). It is 1 when the player car is parked in its garage stall (garage menu open) and 0 the instant the player clicks "Drive" and drops into the car. It is also 0 during mid-race pit stops, so pit stops fall under `on-track` (correct — standings/relative remain useful while the crew is working).

No debounce is applied. `IsInGarage` is a discrete state flag from the sim, not derived from physics, so it does not flicker. If testing proves otherwise we can layer debounce on later without schema changes.

## Detection path

`bridge/telemetry.js` already polls at 10Hz inside `startPolling()`. The changes:

1. Read `ir.get(VARS.IS_IN_GARAGE)?.[0]` alongside the existing per-poll reads.
2. Track `lastInGarage` next to the existing `connected` boolean.
3. When `inGarage` flips while `connected === true`, call `statusCallback({ iracing: true, inGarage })`.
4. The existing on-connect callback fires `{ iracing: true, inGarage }` with the initial value. The existing on-disconnect callback stays `{ iracing: false }` (garage state is meaningless when disconnected).

`main.js` derives the mode in its `startTelemetry` callback:

```js
startTelemetry((status) => {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('iracing-status', status);
  }
  const mode = !status.iracing ? 'notRunning'
             : status.inGarage ? 'garage'
             : 'onTrack';
  applyVisibilityForMode(mode);
});
```

The mode-derivation function is pure and trivially unit-testable — it lives as a small exported helper so `bridge/test-overlayVisibility.js` can assert the truth table.

## Settings schema

New key in `~/Documents/Atleta Racing/settings.json`:

```json
"overlayVisibility": {
  "standings": { "notRunning": true, "garage": true, "onTrack": true },
  "relative":  { "notRunning": true, "garage": true, "onTrack": true },
  "fuel":      { "notRunning": true, "garage": true, "onTrack": true }
}
```

- One entry per overlay ID (matching the `OVERLAYS` array in `main.js`).
- Each entry is an object with three booleans.
- **Defaulting rule:** a missing overlay entry or missing mode key reads as `true`. This means:
  - New overlays added to the `OVERLAYS` array in future releases automatically show in all three modes without requiring a settings migration.
  - Users are never surprised by an overlay disappearing just because their config file doesn't mention it yet.

A three-line read helper in `main.js`:

```js
function isOverlayVisibleInMode(overlayId, mode) {
  const vis = settings.overlayVisibility?.[overlayId];
  if (!vis) return true;
  return vis[mode] !== false;
}
```

## Migration

Runs once in `main.js` during startup, immediately after `loadSettings()`. Only runs if `overlayVisibility` is not already present (idempotent — will not re-run on subsequent launches):

```js
if (!settings.overlayVisibility) {
  const defaultNotRunning = settings.autoHideOverlays !== false; // previous default was true
  settings.overlayVisibility = {};
  OVERLAYS.forEach(o => {
    settings.overlayVisibility[o.id] = {
      notRunning: !defaultNotRunning, // autoHide=true  -> notRunning:false (hide when not running, matches previous behavior)
                                      // autoHide=false -> notRunning:true  (always show, matches previous behavior)
      garage: true,
      onTrack: true,
    };
  });
  delete settings.autoHideOverlays;
  saveSettings(settings);
}
```

After migration, `autoHideOverlays` no longer exists in the settings file and no code path reads it. The following are also removed:

- `let autoHideOverlays = true;` declaration (main.js ~40)
- The `settings.autoHideOverlays` read in the load block (main.js ~132)
- The `settings.autoHideOverlays = autoHideOverlays;` save line (main.js ~467)
- `get-autohide`, `set-autohide`, and `autohide-state` IPC handlers (main.js ~713, ~790)
- The corresponding autohide UI controls in `control-panel.html` (replaced by the matrix)

## Visibility evaluation

Single evaluator in `main.js`:

```js
let currentMode = 'notRunning';

function applyVisibilityForMode(mode) {
  currentMode = mode;
  Object.entries(overlayWindows).forEach(([id, win]) => {
    if (!win || win.isDestroyed()) return;
    if (isOverlayVisibleInMode(id, mode)) win.show();
    else win.hide();
  });
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('mode-changed', { mode });
  }
}
```

Called from four places:

1. The `startTelemetry` status callback (every mode transition during runtime).
2. The startup initial-hide block (main.js ~334) replaces its unconditional hide-all with `applyVisibilityForMode('notRunning')` so overlays a user has explicitly marked visible in "Not Running" appear at launch before iRacing is up.
3. `createOverlayWindow` (after a newly-enabled overlay is instantiated, so it respects the current mode rather than flashing visible).
4. The `set-visibility` IPC handler (after a user toggle, so the change is visible immediately).

## IPC surface

New handlers in `main.js`, removing the three `autohide` handlers:

| Channel | Direction | Payload | Purpose |
|---|---|---|---|
| `get-visibility` | sync invoke | → `{ visibility: settings.overlayVisibility, currentMode }` | Control panel loads matrix state on page open |
| `set-visibility` | async | `{ overlayId, mode, value }` | User toggled a cell. Persists, re-evaluates, broadcasts `visibility-changed` |
| `visibility-changed` | main→renderer | `{ overlayId, mode, value }` | Notify any open control panel of external changes (future multi-window safety) |
| `mode-changed` | main→renderer | `{ mode }` | Fired from `applyVisibilityForMode`, lets the matrix highlight the active column |

`get-visibility` uses `ipcMain.on` with `event.returnValue` (sync) to match the existing control-panel pattern for initial state reads. `set-visibility` uses `ipcMain.on` async.

## Control panel UI

A new sidebar entry `👁 Visibility` added between `📡 Broadcasting` and the divider that precedes the categorized accordion in `control-panel.html`.

Clicking it shows a page titled **Overlay visibility per state** containing:

- **Mode pill strip** at the top: three pills labelled `Not running`, `Garage`, `On track`. The active one is highlighted and updates live via `mode-changed` IPC. Purely informational — not clickable.
- **Three-column matrix table**, one row per overlay in the existing `OVERLAYS` array order. Columns:
  - **Overlay** — icon + name, same visual style as the cards in Favorites/Recent for consistency
  - **Not Running** — checkbox
  - **Garage** — checkbox
  - **On Track** — checkbox
- **Column header bulk toggle** — clicking "Not Running" / "Garage" / "On Track" header text toggles every checkbox in that column at once (small QoL for "turn off the garage column entirely").
- **Instant persist** — every checkbox change fires `set-visibility` immediately; no save button. Matches the rest of the control panel.

No changes are made to the per-overlay settings panels in the categorized accordion. The matrix is the single configuration surface.

## Files touched

- `bridge/telemetry.js` — add `IS_IN_GARAGE` read, extend status payload with `inGarage`, fire `statusCallback` on garage flip
- `bridge/main.js` — export `deriveMode()` helper, add `isOverlayVisibleInMode()`, `applyVisibilityForMode()`, the migration block, the new IPC handlers, remove the three `autoHide*` handlers and their state, call `applyVisibilityForMode` from startup/status-callback/createOverlayWindow/set-visibility
- `bridge/control-panel.html` — new `👁 Visibility` sidebar entry and page, matrix table renderer, mode pill strip, bulk-column toggle, `get-visibility` / `set-visibility` / `mode-changed` / `visibility-changed` wiring, removal of old autoHide UI
- `bridge/test-overlayVisibility.js` — new `node:test` file asserting the `deriveMode()` truth table (3 cases) and the default-true behavior of `isOverlayVisibleInMode()` for missing keys
- `bridge/package.json` — version bump (CLAUDE.md rule: every Bridge change bumps version)

No changes to: `src/` (server), `data/bot.db` schema, Playwright tests, web dashboard, other skill files.

## Testing

**Unit** — `cd bridge && node --test test-overlayVisibility.js test-sidebarState.js test-incidentTracker.js`. New file adds:

- `deriveMode({ iracing: false })` → `'notRunning'`
- `deriveMode({ iracing: true, inGarage: true })` → `'garage'`
- `deriveMode({ iracing: true, inGarage: false })` → `'onTrack'`
- `isOverlayVisibleInMode('unknown', 'garage')` → `true`
- `isOverlayVisibleInMode('standings', 'garage')` with `{ standings: { garage: false } }` in settings → `false`

**Manual** — run the Bridge against a live iRacing session and verify:

1. iRacing closed: only overlays with `notRunning: true` are visible
2. Launch iRacing, sit in garage: `garage`-column overlays become visible, the rest hide
3. Click "Drive" → in car → on track: `on-track`-column overlays become visible, garage-only ones hide
4. Pit stop mid-race: stays in `on-track` mode (no flicker)
5. Exit to garage mid-session: flips back to `garage` mode
6. Close iRacing: flips back to `not-running` mode

**Migration** — test three upgrade paths:

1. Existing user with `autoHideOverlays: true` (default): after first launch, `overlayVisibility` exists, all entries have `notRunning: false, garage: true, onTrack: true`, `autoHideOverlays` key is gone, behavior at startup before iRacing connects is identical to pre-upgrade (all overlays hidden).
2. Existing user with `autoHideOverlays: false`: `notRunning: true` for all, behavior matches pre-upgrade (all overlays visible before iRacing connects).
3. Second launch after migration: the `if (!settings.overlayVisibility)` guard prevents any second migration, settings file is unchanged.

## Risks and open questions

- **None load-bearing.** The `IsInGarage` flag is the official SDK state; we're using it as documented.
- **Future:** if users request per-mode overlay positions or per-mode sizes, the `overlayVisibility` schema can extend into `overlayModes` without breaking this version's booleans. Out of scope for this spec.
