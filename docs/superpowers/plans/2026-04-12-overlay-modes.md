# Bridge overlay modes: per-state visibility matrix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single `autoHideOverlays` boolean with a per-overlay 3-column visibility matrix (Not Running / Garage / On Track), driven by the iRacing `IsInGarage` SDK flag.

**Architecture:** `bridge/telemetry.js` reads `IsInGarage` each poll and pushes `{ iracing, inGarage }` through the existing `statusCallback`. `bridge/main.js` derives a mode string (`notRunning | garage | onTrack`), evaluates per-overlay visibility from `settings.overlayVisibility[id][mode]`, and calls `show()` / `hide()` on each `BrowserWindow`. A new `👁 Visibility` sidebar entry in `bridge/control-panel.html` renders the 3-column matrix with instant-persist IPC.

**Tech Stack:** Electron 28 (main process + renderer), `@emiliosp/node-iracing-sdk`, `node:test` for unit tests, plain CommonJS.

**Spec:** `docs/superpowers/specs/2026-04-12-overlay-modes-design.md`

---

## File Structure

**New files:**
- `bridge/overlayVisibility.js` — pure module: `deriveMode({ iracing, inGarage })`, `isOverlayVisibleInMode(visibility, overlayId, mode)`, `buildDefaultVisibility(overlayIds, legacyAutoHide)`, `toggleVisibility(visibility, overlayId, mode, value)`. No electron imports — fully unit-testable.
- `bridge/test-overlayVisibility.js` — `node:test` suite covering the pure module.

**Modified files:**
- `bridge/telemetry.js` — read `IsInGarage` per poll, extend status payload with `inGarage`, fire callback on garage flip.
- `bridge/main.js` — import the pure module, replace `autoHideOverlays` state with `currentMode`, add `applyVisibilityForMode()`, migration block, new IPC handlers, remove old `toggle-autohide` / `autohide-state` handlers.
- `bridge/control-panel.html` — new `👁 Visibility` sidebar entry + content panel, matrix table, mode pill strip, bulk-column toggle, wiring for `get-visibility` / `set-visibility` / `mode-changed`. Remove old `#autohide-check` checkbox and `toggleAutoHide()`. Remove per-overlay `autoHide` entries from `CUSTOMIZE_FIELDS` (they were dead — never read by any code path).
- `bridge/package.json` — version bump from 3.26.3 to 3.27.0.

**Unchanged:** `src/` (server), `data/bot.db` schema, Playwright tests, any skill files.

---

## Task 1: Create the pure visibility module

**Files:**
- Create: `bridge/overlayVisibility.js`

- [ ] **Step 1: Write the module**

Create `bridge/overlayVisibility.js`:

```js
'use strict';

// Pure helpers for overlay visibility per mode.
// No electron/SDK imports — unit-testable with node:test.

const MODES = ['notRunning', 'garage', 'onTrack'];

function deriveMode(status) {
  if (!status || !status.iracing) return 'notRunning';
  return status.inGarage ? 'garage' : 'onTrack';
}

function isOverlayVisibleInMode(visibility, overlayId, mode) {
  const entry = visibility && visibility[overlayId];
  if (!entry) return true;
  return entry[mode] !== false;
}

function buildDefaultVisibility(overlayIds, legacyAutoHide) {
  // legacyAutoHide === true  → hide when not running (previous default)
  // legacyAutoHide === false → show in all three modes
  // legacyAutoHide === undefined → treat as true (first-install default)
  const hideWhenNotRunning = legacyAutoHide !== false;
  const out = {};
  for (const id of overlayIds) {
    out[id] = {
      notRunning: !hideWhenNotRunning,
      garage: true,
      onTrack: true,
    };
  }
  return out;
}

function toggleVisibility(visibility, overlayId, mode, value) {
  if (!MODES.includes(mode)) throw new Error('unknown mode: ' + mode);
  const next = { ...(visibility || {}) };
  const entry = next[overlayId] ? { ...next[overlayId] } : { notRunning: true, garage: true, onTrack: true };
  entry[mode] = !!value;
  next[overlayId] = entry;
  return next;
}

module.exports = {
  MODES,
  deriveMode,
  isOverlayVisibleInMode,
  buildDefaultVisibility,
  toggleVisibility,
};
```

- [ ] **Step 2: Sanity-check the file loads**

Run: `cd bridge && node -e "console.log(require('./overlayVisibility').MODES)"`
Expected: `[ 'notRunning', 'garage', 'onTrack' ]`

- [ ] **Step 3: Commit**

```bash
git add bridge/overlayVisibility.js
git commit -m "feat(bridge): pure overlay-visibility helpers"
```

---

## Task 2: Test the pure visibility module

**Files:**
- Create: `bridge/test-overlayVisibility.js`

- [ ] **Step 1: Write the failing test file**

Create `bridge/test-overlayVisibility.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  MODES,
  deriveMode,
  isOverlayVisibleInMode,
  buildDefaultVisibility,
  toggleVisibility,
} = require('./overlayVisibility');

test('MODES: three ordered identifiers', () => {
  assert.deepEqual(MODES, ['notRunning', 'garage', 'onTrack']);
});

test('deriveMode: iracing off -> notRunning', () => {
  assert.equal(deriveMode({ iracing: false }), 'notRunning');
});

test('deriveMode: iracing off ignores inGarage', () => {
  assert.equal(deriveMode({ iracing: false, inGarage: true }), 'notRunning');
});

test('deriveMode: iracing on + inGarage -> garage', () => {
  assert.equal(deriveMode({ iracing: true, inGarage: true }), 'garage');
});

test('deriveMode: iracing on + not in garage -> onTrack', () => {
  assert.equal(deriveMode({ iracing: true, inGarage: false }), 'onTrack');
});

test('deriveMode: null/undefined status -> notRunning', () => {
  assert.equal(deriveMode(null), 'notRunning');
  assert.equal(deriveMode(undefined), 'notRunning');
});

test('isOverlayVisibleInMode: missing visibility -> true', () => {
  assert.equal(isOverlayVisibleInMode(null, 'standings', 'garage'), true);
  assert.equal(isOverlayVisibleInMode({}, 'standings', 'garage'), true);
});

test('isOverlayVisibleInMode: missing entry for overlay -> true', () => {
  assert.equal(isOverlayVisibleInMode({ relative: { garage: false } }, 'standings', 'garage'), true);
});

test('isOverlayVisibleInMode: explicit false -> false', () => {
  const vis = { standings: { notRunning: true, garage: false, onTrack: true } };
  assert.equal(isOverlayVisibleInMode(vis, 'standings', 'garage'), false);
});

test('isOverlayVisibleInMode: explicit true -> true', () => {
  const vis = { standings: { notRunning: true, garage: false, onTrack: true } };
  assert.equal(isOverlayVisibleInMode(vis, 'standings', 'onTrack'), true);
});

test('isOverlayVisibleInMode: missing mode key defaults to true', () => {
  const vis = { standings: { garage: false } };
  assert.equal(isOverlayVisibleInMode(vis, 'standings', 'onTrack'), true);
});

test('buildDefaultVisibility: legacyAutoHide=true hides notRunning', () => {
  const out = buildDefaultVisibility(['standings', 'fuel'], true);
  assert.deepEqual(out, {
    standings: { notRunning: false, garage: true, onTrack: true },
    fuel:      { notRunning: false, garage: true, onTrack: true },
  });
});

test('buildDefaultVisibility: legacyAutoHide=false shows all three', () => {
  const out = buildDefaultVisibility(['standings'], false);
  assert.deepEqual(out, {
    standings: { notRunning: true, garage: true, onTrack: true },
  });
});

test('buildDefaultVisibility: legacyAutoHide undefined treated as true', () => {
  const out = buildDefaultVisibility(['standings'], undefined);
  assert.deepEqual(out, {
    standings: { notRunning: false, garage: true, onTrack: true },
  });
});

test('toggleVisibility: flips a single cell without touching others', () => {
  const vis = {
    standings: { notRunning: true, garage: true, onTrack: true },
    fuel:      { notRunning: true, garage: true, onTrack: true },
  };
  const out = toggleVisibility(vis, 'standings', 'garage', false);
  assert.equal(out.standings.garage, false);
  assert.equal(out.standings.notRunning, true);
  assert.equal(out.standings.onTrack, true);
  assert.equal(out.fuel.garage, true);
});

test('toggleVisibility: does not mutate input', () => {
  const vis = { standings: { notRunning: true, garage: true, onTrack: true } };
  toggleVisibility(vis, 'standings', 'garage', false);
  assert.equal(vis.standings.garage, true);
});

test('toggleVisibility: creates entry for unknown overlay', () => {
  const out = toggleVisibility({}, 'standings', 'garage', false);
  assert.deepEqual(out.standings, { notRunning: true, garage: false, onTrack: true });
});

test('toggleVisibility: throws on unknown mode', () => {
  assert.throws(() => toggleVisibility({}, 'standings', 'pitLane', false));
});
```

- [ ] **Step 2: Run the test file, expect all pass**

Run: `cd bridge && node --test test-overlayVisibility.js`
Expected: all tests pass (18 tests).

- [ ] **Step 3: Run the full bridge test suite to confirm nothing broke**

Run: `cd bridge && node --test test-overlayVisibility.js test-sidebarState.js test-incidentTracker.js`
Expected: all three files' tests pass.

- [ ] **Step 4: Commit**

```bash
git add bridge/test-overlayVisibility.js
git commit -m "test(bridge): overlay-visibility pure-module tests"
```

---

## Task 3: Telemetry emits inGarage flag in status payload

**Files:**
- Modify: `bridge/telemetry.js:517-597` (connect handler), `bridge/telemetry.js:599-624` (poll/disconnect handler), `bridge/telemetry.js:625` (add `lastInGarage` state)

- [ ] **Step 1: Add `lastInGarage` state near the top of `startTelemetry`**

Open `bridge/telemetry.js`. After line 546 (`let raceSessionTotalTime = 0;`), add:

```js
  let lastInGarage = false; // tracked across polls to fire statusCallback only on change
```

- [ ] **Step 2: Include inGarage on initial connect**

Replace the connect-success block inside `connectInterval`. Find (around line 582):

```js
        log('[Telemetry] Connected to iRacing!');
        broadcastToChannel('_all', { type: 'status', iracing: true });
        if (statusCallback) statusCallback({ iracing: true });
        startPolling();
```

Replace with:

```js
        log('[Telemetry] Connected to iRacing!');
        // Pull initial IsInGarage before first broadcast so main.js enters the
        // correct mode immediately (no flash of notRunning → onTrack).
        let initialInGarage = false;
        try {
          ir.refreshSharedMemory();
          initialInGarage = !!ir.get(VARS.IS_IN_GARAGE)?.[0];
        } catch (e) {}
        lastInGarage = initialInGarage;
        broadcastToChannel('_all', { type: 'status', iracing: true, inGarage: initialInGarage });
        if (statusCallback) statusCallback({ iracing: true, inGarage: initialInGarage });
        startPolling();
```

- [ ] **Step 3: Detect garage flips inside the poll loop**

Inside the `pollInterval = setInterval(() => { ... }, 33)` body. After `ir.refreshSharedMemory(); pollCount++;` (around line 626) and before the session-change detection block, add:

```js
        // === Garage state change detection ===
        try {
          const inGarageNow = !!ir.get(VARS.IS_IN_GARAGE)?.[0];
          if (inGarageNow !== lastInGarage) {
            lastInGarage = inGarageNow;
            broadcastToChannel('_all', { type: 'status', iracing: true, inGarage: inGarageNow });
            if (statusCallback) statusCallback({ iracing: true, inGarage: inGarageNow });
          }
        } catch (e) {}
```

- [ ] **Step 4: Reset `lastInGarage` on both disconnect paths**

Connect-error disconnect path (around line 589-593, inside `catch (e)` after the connect attempt):

```js
      if (connected) {
        connected = false; ir = null;
        lastInGarage = false;
        log('[Telemetry] Disconnected: ' + e.message);
        broadcastToChannel('_all', { type: 'status', iracing: false });
        if (statusCallback) statusCallback({ iracing: false });
        resetFuel();
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
      }
```

Poll-detected disconnect path (around line 604-620, inside `if (!ir.isConnected())`):

```js
            connected = false;
            lastInGarage = false;
            log('[Telemetry] Disconnected during poll');
            broadcastToChannel('_all', { type: 'status', iracing: false });
            if (statusCallback) statusCallback({ iracing: false });
            resetFuel(); clearInterval(pollInterval); pollInterval = null;
```

- [ ] **Step 5: Syntax-check telemetry.js**

Run: `cd bridge && node --check telemetry.js`
Expected: exits 0, no output.

- [ ] **Step 6: Commit**

```bash
git add bridge/telemetry.js
git commit -m "feat(bridge): emit inGarage flag in telemetry status payload"
```

---

## Task 4: Wire the mode-derivation helper into main.js and remove autoHide state

**Files:**
- Modify: `bridge/main.js:22` (add require), `bridge/main.js:40` (replace `autoHideOverlays`), `bridge/main.js:132` (remove autohide load), `bridge/main.js:298-310` (status callback), `bridge/main.js:330-339` (startup visibility), `bridge/main.js:467` (remove autohide save), `bridge/main.js:603-612` (createOverlayWindow — respect current mode), `bridge/main.js:712-715` (remove `toggle-autohide`), `bridge/main.js:786-791` (remove `autohide-state` reply)

- [ ] **Step 1: Import the visibility helper**

At `bridge/main.js:27` (after the `const pitwallUplink = require('./pitwallUplink');` line), add:

```js
const {
  deriveMode,
  isOverlayVisibleInMode,
  buildDefaultVisibility,
  toggleVisibility,
} = require('./overlayVisibility');
```

- [ ] **Step 2: Replace `autoHideOverlays` with `currentMode`**

Find `bridge/main.js:40`:

```js
let autoHideOverlays = true;
```

Replace with:

```js
let currentMode = 'notRunning';
```

- [ ] **Step 3: Remove the old autohide load line**

Find `bridge/main.js:132`:

```js
  if (settings.autoHideOverlays !== undefined) autoHideOverlays = settings.autoHideOverlays;
```

Delete this entire line.

- [ ] **Step 4: Add one-shot migration directly after `settings = loadSettings();`**

Insert immediately after `settings = loadSettings();` (the line you just stripped the autohide-load from):

```js
  // One-shot migration: convert legacy autoHideOverlays into per-overlay overlayVisibility.
  // Idempotent — only runs if overlayVisibility has not been created yet.
  if (!settings.overlayVisibility) {
    settings.overlayVisibility = buildDefaultVisibility(
      OVERLAYS.map(o => o.id),
      settings.autoHideOverlays
    );
    delete settings.autoHideOverlays;
    saveSettings(settings);
  }
```

- [ ] **Step 5: Add `applyVisibilityForMode()` helper near the top of the file**

Insert right after `const APP_ICON_PATH = resolveIconPath();` (around line 67) and before `const OVERLAYS = [`:

```js
function applyVisibilityForMode(mode) {
  currentMode = mode;
  Object.entries(overlayWindows).forEach(([id, win]) => {
    if (!win || win.isDestroyed()) return;
    if (isOverlayVisibleInMode(settings.overlayVisibility, id, mode)) {
      try { win.show(); } catch (e) {}
    } else {
      try { win.hide(); } catch (e) {}
    }
  });
  if (controlWindow && !controlWindow.isDestroyed()) {
    try { controlWindow.webContents.send('mode-changed', { mode }); } catch (e) {}
  }
}
```

- [ ] **Step 6: Replace the autohide status-callback branch**

Find the `startTelemetry((status) => { ... })` block (around `bridge/main.js:298-310`):

```js
  startTelemetry((status) => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('iracing-status', status);
    }
    // Auto-hide/show overlays based on iRacing connection
    if (autoHideOverlays) {
      if (status.iracing) {
        Object.values(overlayWindows).forEach(w => { if (w && !w.isDestroyed()) w.show(); });
      } else {
        Object.values(overlayWindows).forEach(w => { if (w && !w.isDestroyed()) w.hide(); });
      }
    }
  });
```

Replace with:

```js
  startTelemetry((status) => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('iracing-status', status);
    }
    applyVisibilityForMode(deriveMode(status));
  });
```

- [ ] **Step 7: Replace the startup overlay-restoration autohide branch**

Find the block around `bridge/main.js:330-339`:

```js
  // Restore enabled overlays from settings (hidden if autoHide is on — shown when iRacing connects)
  if (settings.enabledOverlays && Array.isArray(settings.enabledOverlays)) {
    settings.enabledOverlays.forEach(id => createOverlayWindow(id));
    // Hide all overlays initially when autoHide is on (iRacing isn't connected yet)
    if (autoHideOverlays) {
      setTimeout(() => {
        Object.values(overlayWindows).forEach(w => { if (w && !w.isDestroyed()) w.hide(); });
      }, 200);
    }
  }
```

Replace with:

```js
  // Restore enabled overlays from settings, then apply visibility for the current mode
  // (notRunning at launch — telemetry status callback will flip us to garage/onTrack shortly).
  if (settings.enabledOverlays && Array.isArray(settings.enabledOverlays)) {
    settings.enabledOverlays.forEach(id => createOverlayWindow(id));
    setTimeout(() => applyVisibilityForMode(currentMode), 200);
  }
```

- [ ] **Step 8: Remove the autohide save line from `persistSettings`**

Find `bridge/main.js:467`:

```js
  settings.autoHideOverlays = autoHideOverlays;
```

Delete this entire line.

- [ ] **Step 9: Make `createOverlayWindow` respect `currentMode`**

Find the end of `createOverlayWindow` — the block that runs after the overlay is inserted into `overlayWindows[overlayId] = win;` (around `bridge/main.js:604-612`):

```js
  overlayWindows[overlayId] = win;

  // Wire up voice chat overlay to voice input module
  if (overlayId === 'voicechat') {
    setVoiceChatWindow(win);
  }

  persistSettings();
}
```

Replace with:

```js
  overlayWindows[overlayId] = win;

  // Wire up voice chat overlay to voice input module
  if (overlayId === 'voicechat') {
    setVoiceChatWindow(win);
  }

  // Respect current mode — if this overlay is hidden in the active mode,
  // hide it immediately so it does not flash visible before the next mode transition.
  if (!isOverlayVisibleInMode(settings.overlayVisibility, overlayId, currentMode)) {
    try { win.hide(); } catch (e) {}
  }

  persistSettings();
}
```

- [ ] **Step 10: Remove the `toggle-autohide` IPC handler**

Find `bridge/main.js:712-715`:

```js
ipcMain.on('toggle-autohide', (event, enabled) => {
  autoHideOverlays = enabled;
  persistSettings();
});
```

Delete this entire handler.

- [ ] **Step 11: Remove `autohide-state` reply from `get-overlay-states`**

Find `bridge/main.js:786-791`:

```js
ipcMain.on('get-overlay-states', (event) => {
  const states = {};
  OVERLAYS.forEach(o => { states[o.id] = !!overlayWindows[o.id]; });
  event.reply('overlay-states', states);
  event.reply('autohide-state', autoHideOverlays);
});
```

Replace with:

```js
ipcMain.on('get-overlay-states', (event) => {
  const states = {};
  OVERLAYS.forEach(o => { states[o.id] = !!overlayWindows[o.id]; });
  event.reply('overlay-states', states);
});
```

- [ ] **Step 12: Syntax-check main.js**

Run: `cd bridge && node --check main.js`
Expected: exits 0.

- [ ] **Step 13: Commit**

```bash
git add bridge/main.js
git commit -m "feat(bridge): mode-based visibility evaluator + autohide migration"
```

---

## Task 5: Add `get-visibility` / `set-visibility` IPC handlers in main.js

**Files:**
- Modify: `bridge/main.js` — add two new IPC handlers in the IPC section.

- [ ] **Step 1: Add the handlers after the `get-overlay-states` handler**

Find the handler at `bridge/main.js:786` (the one that was just edited in Task 4 Step 11). Immediately after its closing `});`, add:

```js
ipcMain.on('get-visibility', (event) => {
  event.returnValue = {
    visibility: settings.overlayVisibility || {},
    currentMode,
  };
});

ipcMain.on('set-visibility', (event, payload) => {
  if (!payload || typeof payload !== 'object') return;
  const { overlayId, mode, value } = payload;
  if (!overlayId || !mode) return;
  try {
    settings.overlayVisibility = toggleVisibility(settings.overlayVisibility, overlayId, mode, value);
  } catch (e) {
    return; // unknown mode
  }
  saveSettings(settings);
  applyVisibilityForMode(currentMode);
  if (controlWindow && !controlWindow.isDestroyed()) {
    try {
      controlWindow.webContents.send('visibility-changed', { overlayId, mode, value: !!value });
    } catch (e) {}
  }
});
```

- [ ] **Step 2: Syntax-check main.js**

Run: `cd bridge && node --check main.js`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add bridge/main.js
git commit -m "feat(bridge): get-visibility + set-visibility IPC handlers"
```

---

## Task 6: Remove the global autohide checkbox and `toggleAutoHide` from control-panel.html

**Files:**
- Modify: `bridge/control-panel.html:745-748` (autohide checkbox), `bridge/control-panel.html:2189-2192` (toggleAutoHide function), `bridge/control-panel.html:2438-2441` (autohide-state listener)

- [ ] **Step 1: Remove the global autohide checkbox**

Find `bridge/control-panel.html:745-748`:

```html
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#8b8a9e;margin-top:10px;cursor:pointer;">
          <input type="checkbox" id="autohide-check" checked onchange="toggleAutoHide(this.checked)" style="accent-color:#9146ff;">
          Auto-hide overlays when iRacing closes
        </label>
```

Delete the entire `<label>` block (4 lines).

- [ ] **Step 2: Remove the `toggleAutoHide` function**

Find `bridge/control-panel.html:2189-2192`:

```js
    // ─── Auto-hide ─────────────────────────────────────────
    function toggleAutoHide(enabled) {
      ipcRenderer.send('toggle-autohide', enabled);
    }
```

Delete all 4 lines.

- [ ] **Step 3: Remove the `autohide-state` IPC listener**

Find `bridge/control-panel.html:2438-2441`:

```js
    ipcRenderer.on('autohide-state', (event, enabled) => {
      const check = document.getElementById('autohide-check');
      if (check) check.checked = enabled;
    });
```

Delete all 4 lines.

- [ ] **Step 4: Grep-verify every autohide reference is gone from the file**

Run: `grep -nE "autohide|autoHide|toggleAutoHide" bridge/control-panel.html | grep -v "key: 'autoHide'"`
Expected: no output (empty). The `grep -v` excludes the per-overlay `CUSTOMIZE_FIELDS` entries — those are cleaned up in Task 7.

- [ ] **Step 5: Commit**

```bash
git add bridge/control-panel.html
git commit -m "refactor(bridge): drop global autohide checkbox (replaced by visibility matrix)"
```

---

## Task 7: Remove dead per-overlay `autoHide` entries from CUSTOMIZE_FIELDS

**Files:**
- Modify: `bridge/control-panel.html:1080`, `1090`, `1101`, `1114`, `1120`, `1127`, `1141`, `1165`, `1180`, `1189`, `1194`, `1203`, `1208`, `1215` (14 occurrences total)

Context: grep confirmed these `{ key: 'autoHide', ... }` entries in `CUSTOMIZE_FIELDS` render a checkbox in every overlay's settings panel, but no code path in the Bridge ever reads `overlayCustom[x].autoHide`. They were leftover from an earlier iteration and are dead UI. Removing them is in-scope because we are replacing the autohide model entirely.

- [ ] **Step 1: Delete every `autoHide` field entry in CUSTOMIZE_FIELDS**

For each of the overlay configs under `const CUSTOMIZE_FIELDS = { ... }` (starting at `bridge/control-panel.html:1067`), find and delete the single line matching:

```js
        { key: 'autoHide', label: 'Auto-hide when iRacing closes', type: 'checkbox', default: true },
```

There are 14 of them, one per overlay (standings, relative, fuel, wind, proximity, chat, trackmap, voicechat, inputs, drivercard, stintlaps, weather, raceduration, pitstrategy). Use your editor's find-all-in-file + delete-line.

- [ ] **Step 2: Sanity-check that exactly zero `autoHide` field entries remain**

Run: `grep -c "key: 'autoHide'" bridge/control-panel.html`
Expected: `0`

- [ ] **Step 3: Grep-verify every `autoHide` reference is gone from the file**

Run: `grep -nE "autohide|autoHide|toggleAutoHide" bridge/control-panel.html`
Expected: no output (empty).

- [ ] **Step 4: Commit**

```bash
git add bridge/control-panel.html
git commit -m "refactor(bridge): remove dead per-overlay autoHide field entries"
```

---

## Task 8: Add `👁 Visibility` sidebar entry and empty content panel

**Files:**
- Modify: `bridge/control-panel.html:629-631` (add sidebar item), `bridge/control-panel.html:730` (add content panel div), `bridge/control-panel.html:1414-1447` (extend navigateTo)

- [ ] **Step 1: Add the sidebar item in the General group**

Find `bridge/control-panel.html:629-631`:

```html
        <div class="sidebar-item" data-panel="broadcast" onclick="navigateTo('broadcast')">
          <span class="sidebar-icon" style="color:#3ecf8e;">&#128225;</span> Broadcasting
        </div>
      </div>
```

Replace with:

```html
        <div class="sidebar-item" data-panel="broadcast" onclick="navigateTo('broadcast')">
          <span class="sidebar-icon" style="color:#3ecf8e;">&#128225;</span> Broadcasting
        </div>
        <div class="sidebar-item" data-panel="visibility" onclick="navigateTo('visibility')">
          <span class="sidebar-icon" style="color:#9146ff;">&#128065;</span> Visibility
        </div>
      </div>
```

- [ ] **Step 2: Add the content panel below Broadcasting**

Find `bridge/control-panel.html:730`:

```html
      <!-- ═══ BROADCASTING PANEL ═══ -->
      <div class="content-panel" id="panel-broadcast"></div>
```

Replace with:

```html
      <!-- ═══ BROADCASTING PANEL ═══ -->
      <div class="content-panel" id="panel-broadcast"></div>

      <!-- ═══ VISIBILITY PANEL ═══ -->
      <div class="content-panel" id="panel-visibility"></div>
```

- [ ] **Step 3: Extend `navigateTo` to render the visibility page on entry**

Find the dynamic-page re-render block in `navigateTo` (around `bridge/control-panel.html:1426-1433`):

```js
      // Re-render dynamic pages
      if (panelId === 'favorites') renderFavoritesPage();
      if (panelId === 'recent') renderRecentPage();
      if (panelId === 'broadcast') {
        // Re-sync from persisted state on every entry so uncommitted edits
        // don't leak across tab switches.
        resetBroadcastPending();
        renderBroadcastPage();
      }
```

Replace with:

```js
      // Re-render dynamic pages
      if (panelId === 'favorites') renderFavoritesPage();
      if (panelId === 'recent') renderRecentPage();
      if (panelId === 'broadcast') {
        // Re-sync from persisted state on every entry so uncommitted edits
        // don't leak across tab switches.
        resetBroadcastPending();
        renderBroadcastPage();
      }
      if (panelId === 'visibility') renderVisibilityPage();
```

- [ ] **Step 4: Add `visibility` to RECENT_EXCLUDE so it doesn't pollute Recent**

Find the `RECENT_EXCLUDE` set (around `bridge/control-panel.html:1435`):

```js
      const RECENT_EXCLUDE = new Set(['overview', 'favorites', 'recent', 'account', 'updates', 'logs', 'about']);
```

Replace with:

```js
      const RECENT_EXCLUDE = new Set(['overview', 'favorites', 'recent', 'visibility', 'account', 'updates', 'logs', 'about']);
```

(`visibility` is not in the `overlays` array, so the `overlays.find(...)` check after this set would also catch it, but adding to the explicit exclude list is clearer and prevents future regressions if someone reorders the checks.)

- [ ] **Step 5: Commit (with an interim placeholder renderer)**

Before committing, add a placeholder `renderVisibilityPage` stub so the file parses. Add this function right after `renderBroadcastPage` (search for `function renderBroadcastPage`). We'll fill it in in Task 9:

```js
    // ─── Visibility page (placeholder, populated in task 9) ────
    function renderVisibilityPage() {
      const panel = document.getElementById('panel-visibility');
      if (!panel) return;
      panel.innerHTML = '<div style="padding:20px;color:#8b8a9e;">Loading…</div>';
    }
```

Then commit:

```bash
git add bridge/control-panel.html
git commit -m "feat(bridge): visibility sidebar entry + panel placeholder"
```

---

## Task 9: Implement the visibility matrix renderer

**Files:**
- Modify: `bridge/control-panel.html` — replace the `renderVisibilityPage` placeholder with the full implementation. Add CSS for the matrix table. Add IPC listener for `mode-changed` and `visibility-changed`.

- [ ] **Step 1: Add CSS for the matrix**

Find the CSS block near the existing `.overview-grid` / `.ov-card` styles (search for `.overview-grid` in the `<style>` section near the top of the file). Add these rules at the end of the `<style>` block (just before `</style>`):

```css
    /* ─── Visibility matrix ─────────────────────────────── */
    .vis-mode-pills { display:flex; gap:8px; margin:12px 0 18px; }
    .vis-mode-pill {
      padding:6px 12px; border-radius:999px; font-size:10px; font-weight:600;
      text-transform:uppercase; letter-spacing:0.5px;
      background:rgba(255,255,255,0.05); color:#5c5b6e;
      border:1px solid rgba(255,255,255,0.08);
    }
    .vis-mode-pill.active { background:rgba(145,70,255,0.18); color:#c7aafe; border-color:rgba(145,70,255,0.4); }
    .vis-table { width:100%; border-collapse:collapse; font-size:12px; }
    .vis-table th, .vis-table td { padding:10px 8px; text-align:left; border-bottom:1px solid rgba(255,255,255,0.05); }
    .vis-table th { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:1px; color:#8b8a9e; }
    .vis-table th.vis-col { cursor:pointer; text-align:center; user-select:none; }
    .vis-table th.vis-col:hover { color:#c7aafe; }
    .vis-table td.vis-col { text-align:center; }
    .vis-table .vis-row-icon { font-size:16px; margin-right:8px; }
    .vis-table .vis-row-name { color:#e8e6f0; }
    .vis-table input[type="checkbox"] { accent-color:#9146ff; width:16px; height:16px; cursor:pointer; }
    .vis-table tr.vis-active-mode td { background:rgba(145,70,255,0.06); }
```

- [ ] **Step 2: Replace the placeholder `renderVisibilityPage`**

Find the placeholder added in Task 8:

```js
    // ─── Visibility page (placeholder, populated in task 9) ────
    function renderVisibilityPage() {
      const panel = document.getElementById('panel-visibility');
      if (!panel) return;
      panel.innerHTML = '<div style="padding:20px;color:#8b8a9e;">Loading…</div>';
    }
```

Replace with:

```js
    // ─── Visibility page ─────────────────────────────────
    let visibilityState = { visibility: {}, currentMode: 'notRunning' };

    function refreshVisibilityStateFromMain() {
      try {
        visibilityState = ipcRenderer.sendSync('get-visibility') || { visibility: {}, currentMode: 'notRunning' };
      } catch (e) {
        visibilityState = { visibility: {}, currentMode: 'notRunning' };
      }
    }

    function isVisibleCell(overlayId, mode) {
      const vis = visibilityState.visibility;
      const entry = vis && vis[overlayId];
      if (!entry) return true;
      return entry[mode] !== false;
    }

    function renderVisibilityPage() {
      const panel = document.getElementById('panel-visibility');
      if (!panel) return;
      refreshVisibilityStateFromMain();

      const mode = visibilityState.currentMode;
      const modePill = (key, label) => {
        const active = (mode === key) ? ' active' : '';
        return '<span class="vis-mode-pill' + active + '" data-mode="' + key + '">' + label + '</span>';
      };

      const rows = overlays.map(ov => {
        const cell = (modeKey) => {
          const checked = isVisibleCell(ov.id, modeKey) ? 'checked' : '';
          return '<td class="vis-col"><input type="checkbox" ' + checked +
            ' onchange="setVisibilityCell(\'' + ov.id + '\', \'' + modeKey + '\', this.checked)"></td>';
        };
        return '<tr data-overlay-id="' + ov.id + '">' +
          '<td><span class="vis-row-icon">' + ov.icon + '</span><span class="vis-row-name">' + ov.name + '</span></td>' +
          cell('notRunning') + cell('garage') + cell('onTrack') +
          '</tr>';
      }).join('');

      panel.innerHTML =
        '<div style="display:flex;align-items:center;gap:10px;font-size:16px;font-weight:700;color:#e8e6f0;margin-bottom:6px;">' +
          '<span style="color:#9146ff;font-size:18px;">👁</span> Overlay visibility per state' +
        '</div>' +
        '<div style="font-size:11px;color:#5c5b6e;margin-bottom:12px;">' +
          'Pick which overlays show in each state. Changes save instantly. Click a column header to toggle that whole column.' +
        '</div>' +
        '<div class="vis-mode-pills">' +
          modePill('notRunning', 'Not running') +
          modePill('garage', 'Garage') +
          modePill('onTrack', 'On track') +
        '</div>' +
        '<table class="vis-table">' +
          '<thead><tr>' +
            '<th>Overlay</th>' +
            '<th class="vis-col" onclick="bulkToggleVisibilityColumn(\'notRunning\')">Not Running</th>' +
            '<th class="vis-col" onclick="bulkToggleVisibilityColumn(\'garage\')">Garage</th>' +
            '<th class="vis-col" onclick="bulkToggleVisibilityColumn(\'onTrack\')">On Track</th>' +
          '</tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>';
    }

    function setVisibilityCell(overlayId, mode, value) {
      // Optimistic local update so the UI reflects immediately
      if (!visibilityState.visibility[overlayId]) {
        visibilityState.visibility[overlayId] = { notRunning: true, garage: true, onTrack: true };
      }
      visibilityState.visibility[overlayId][mode] = !!value;
      ipcRenderer.send('set-visibility', { overlayId, mode, value: !!value });
    }

    function bulkToggleVisibilityColumn(mode) {
      // If every cell in the column is currently true, turn them all off. Otherwise turn them all on.
      const allOn = overlays.every(ov => isVisibleCell(ov.id, mode));
      const target = !allOn;
      overlays.forEach(ov => {
        if (!visibilityState.visibility[ov.id]) {
          visibilityState.visibility[ov.id] = { notRunning: true, garage: true, onTrack: true };
        }
        visibilityState.visibility[ov.id][mode] = target;
        ipcRenderer.send('set-visibility', { overlayId: ov.id, mode, value: target });
      });
      renderVisibilityPage();
    }
```

- [ ] **Step 3: Listen for `mode-changed` pushed from main**

Find the block that registers IPC listeners near the bottom of the script (search for `ipcRenderer.on('pitwall-teams'`). Add these two listeners next to it:

```js
    ipcRenderer.on('mode-changed', (event, payload) => {
      if (payload && payload.mode) visibilityState.currentMode = payload.mode;
      if (currentPanel === 'visibility') renderVisibilityPage();
    });

    ipcRenderer.on('visibility-changed', (event, payload) => {
      if (!payload || !payload.overlayId || !payload.mode) return;
      if (!visibilityState.visibility[payload.overlayId]) {
        visibilityState.visibility[payload.overlayId] = { notRunning: true, garage: true, onTrack: true };
      }
      visibilityState.visibility[payload.overlayId][payload.mode] = !!payload.value;
      if (currentPanel === 'visibility') renderVisibilityPage();
    });
```

- [ ] **Step 4: Grep-verify the new symbols landed where expected**

```bash
grep -c "function renderVisibilityPage" bridge/control-panel.html   # expect 1
grep -c "function setVisibilityCell" bridge/control-panel.html      # expect 1
grep -c "function bulkToggleVisibilityColumn" bridge/control-panel.html  # expect 1
grep -c "mode-changed" bridge/control-panel.html                    # expect >= 1
grep -c "visibility-changed" bridge/control-panel.html              # expect >= 1
grep -c "vis-mode-pill" bridge/control-panel.html                   # expect >= 3 (css + 2 usages)
```

If any count is wrong, the edits did not land correctly — fix before proceeding.

- [ ] **Step 5: Commit**

```bash
git add bridge/control-panel.html
git commit -m "feat(bridge): visibility matrix UI with instant persist + bulk toggle"
```

---

## Task 10: Version bump + end-to-end manual test

**Files:**
- Modify: `bridge/package.json:3`

- [ ] **Step 1: Bump version from 3.26.3 to 3.27.0**

Open `bridge/package.json`. Find:

```json
  "version": "3.26.3",
```

Replace with:

```json
  "version": "3.27.0",
```

(Minor bump, not patch: this is a user-facing feature change, not a bugfix.)

- [ ] **Step 2: Run every unit test suite one final time**

Run: `cd bridge && node --test test-overlayVisibility.js test-sidebarState.js test-incidentTracker.js`
Expected: all tests across all three files pass.

- [ ] **Step 3: Manual end-to-end check**

Launch the Bridge against a live iRacing session (or tell the user to do so if you can't run iRacing yourself). Walk through the full matrix:

1. **iRacing closed** — enable several overlays. Confirm: only overlays with `notRunning: true` are visible.
2. **Launch iRacing, sit in garage (menu)** — confirm overlays marked `garage: true` become visible, the rest stay hidden.
3. **Click Drive, pull out onto track** — confirm `onTrack: true` overlays appear, garage-only ones hide.
4. **Pit stop during a race** — confirm nothing toggles (stays in `onTrack` mode — `IsInGarage` stays false during a crewed pit stop).
5. **Exit to garage mid-session** — confirm flip back to `garage` mode.
6. **Quit iRacing** — confirm flip back to `notRunning` mode.
7. **Matrix page** — uncheck a cell, watch the corresponding overlay disappear instantly if it's in the active mode.

If any transition mis-fires, fix it before moving on. **Do not claim success without running this end-to-end.**

- [ ] **Step 4: Test the migration path on an existing settings file**

Copy your current `~/Documents/Atleta Racing/settings.json` to a backup. Edit the live file to remove `overlayVisibility` entirely and add `"autoHideOverlays": true` at the top level. Launch the Bridge.

Confirm:
- `overlayVisibility` is present after launch, every overlay has `notRunning: false, garage: true, onTrack: true`.
- `autoHideOverlays` key is gone from the file.
- Behavior at startup (before iRacing connects) matches pre-upgrade: all overlays hidden.

Restore your backup.

- [ ] **Step 5: Commit the version bump**

```bash
git add bridge/package.json
git commit -m "chore(bridge): bump to v3.27.0 for overlay visibility matrix"
```

- [ ] **Step 6: Push to trigger Railway + Bridge release**

Run: `git push`
Expected: pre-push Playwright hook runs and passes, push succeeds, GitHub Actions begins the Bridge NSIS installer build.

---

## Appendix: File touch summary

| File | Change type |
|---|---|
| `bridge/overlayVisibility.js` | **new** — pure visibility helpers |
| `bridge/test-overlayVisibility.js` | **new** — node:test suite (18 tests) |
| `bridge/telemetry.js` | modified — reads `IS_IN_GARAGE`, emits `inGarage` in status payload |
| `bridge/main.js` | modified — replaces `autoHideOverlays` with mode evaluator, new IPC, migration |
| `bridge/control-panel.html` | modified — new Visibility sidebar + matrix page; removes global and per-overlay autoHide UI |
| `bridge/package.json` | modified — version bump to 3.27.0 |
| `docs/superpowers/specs/2026-04-12-overlay-modes-design.md` | (already committed) |
| `docs/superpowers/plans/2026-04-12-overlay-modes.md` | this file |

No changes to: `src/`, `data/`, Playwright tests, server, DB schema.
