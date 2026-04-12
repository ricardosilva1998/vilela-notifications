# Flag Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new Bridge overlay (`flags`) that pops up a small animated waving flag whenever iRacing raises a green / yellow / blue / white / black / checkered flag for the player.

**Architecture:** New pure-JS `flagState.js` factory module (same pattern as `incidentTracker.js`) holds the priority ladder, blue-flag throttle, and minimum-dwell state machine. `telemetry.js` ticks it each poll and broadcasts its `getState()` on a new `flags` WebSocket channel. A new `flags.html` overlay subscribes and renders an SVG waving flag whose fill/label swap based on the active flag key.

**Tech Stack:** Node.js (CommonJS), `node:test` for unit tests, SVG + CSS for the overlay rendering, Playwright for UI tests. No new npm dependencies.

**Reference spec:** `docs/superpowers/specs/2026-04-12-flag-overlay-design.md`

---

## File Map

| Path | Status | Responsibility |
|------|--------|----------------|
| `bridge/flagState.js` | **NEW** | Pure-JS factory: priority ladder + blue throttle + min-dwell state machine. |
| `bridge/test-flagState.js` | **NEW** | `node:test` unit suite for `flagState.js`. |
| `bridge/telemetry.js` | modified | Require, instantiate, reset-on-connect, tick-per-poll, broadcast on `flags` channel. |
| `bridge/overlays/flags.html` | **NEW** | Draggable overlay window: waving SVG + dynamic fill/label via `flags` channel. |
| `bridge/main.js` | modified | Single entry in the `OVERLAYS` array. |
| `bridge/control-panel.html` | modified | Sidebar item, panel container, `overlays` list row, `CUSTOMIZE_FIELDS.flags` row. |
| `bridge/tests/mock-data.js` | modified | Add `flags` generator + `OVERLAY_CHANNELS.flags` entry. |
| `bridge/tests/overlays.spec.js` | modified | Register `flags` in `OVERLAY_SIZES` and `waitForRender` selector list. |
| `bridge/package.json` | modified | Version bump 3.26.3 → 3.26.4. |

---

## Task 1: `flagState.js` — write failing tests

**Files:**
- Create: `bridge/test-flagState.js`

- [ ] **Step 1: Write the full failing test file**

Write this exact content to `bridge/test-flagState.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFlagState } = require('./flagState');

// iRacing irsdk_Flags bits
const CHECKERED    = 0x1;
const WHITE        = 0x2;
const GREEN        = 0x4;
const YELLOW       = 0x8;
const BLUE         = 0x20;
const YELLOW_WAVE  = 0x100;
const GREEN_HELD   = 0x400;
const CAUTION      = 0x4000;
const CAUTION_WAVE = 0x8000;
const BLACK        = 0x10000;

test('starts idle with null activeFlag', () => {
  const s = createFlagState();
  const st = s.getState();
  assert.equal(st.activeFlag, null);
  assert.equal(st.since, null);
  assert.equal(st.rawBits, 0);
});

test('green bit → active green', () => {
  const s = createFlagState();
  s.tick({ rawBits: GREEN, tNow: 1000 });
  const st = s.getState();
  assert.equal(st.activeFlag, 'green');
  assert.equal(st.since, 1000);
  assert.equal(st.rawBits, GREEN);
});

test('yellow bit → active yellow', () => {
  const s = createFlagState();
  s.tick({ rawBits: YELLOW, tNow: 1000 });
  assert.equal(s.getState().activeFlag, 'yellow');
});

test('yellowWaving bit resolves to yellow', () => {
  const s = createFlagState();
  s.tick({ rawBits: YELLOW_WAVE, tNow: 1000 });
  assert.equal(s.getState().activeFlag, 'yellow');
});

test('caution bit resolves to yellow', () => {
  const s = createFlagState();
  s.tick({ rawBits: CAUTION, tNow: 1000 });
  assert.equal(s.getState().activeFlag, 'yellow');
});

test('cautionWaving bit resolves to yellow', () => {
  const s = createFlagState();
  s.tick({ rawBits: CAUTION_WAVE, tNow: 1000 });
  assert.equal(s.getState().activeFlag, 'yellow');
});

test('greenHeld bit resolves to green', () => {
  const s = createFlagState();
  s.tick({ rawBits: GREEN_HELD, tNow: 1000 });
  assert.equal(s.getState().activeFlag, 'green');
});

test('black bit → active black', () => {
  const s = createFlagState();
  s.tick({ rawBits: BLACK, tNow: 1000 });
  assert.equal(s.getState().activeFlag, 'black');
});

test('blue bit → active blue', () => {
  const s = createFlagState();
  s.tick({ rawBits: BLUE, tNow: 1000 });
  assert.equal(s.getState().activeFlag, 'blue');
});

test('white bit → active white', () => {
  const s = createFlagState();
  s.tick({ rawBits: WHITE, tNow: 1000 });
  assert.equal(s.getState().activeFlag, 'white');
});

test('checkered bit → active checkered', () => {
  const s = createFlagState();
  s.tick({ rawBits: CHECKERED, tNow: 1000 });
  assert.equal(s.getState().activeFlag, 'checkered');
});

test('priority: yellow + blue active → yellow wins', () => {
  const s = createFlagState();
  s.tick({ rawBits: YELLOW | BLUE, tNow: 1000 });
  assert.equal(s.getState().activeFlag, 'yellow');
});

test('priority: black beats yellow', () => {
  const s = createFlagState();
  s.tick({ rawBits: YELLOW | BLACK, tNow: 1000 });
  assert.equal(s.getState().activeFlag, 'black');
});

test('priority: checkered beats white', () => {
  const s = createFlagState();
  s.tick({ rawBits: WHITE | CHECKERED, tNow: 1000 });
  assert.equal(s.getState().activeFlag, 'checkered');
});

test('priority: green has lowest priority', () => {
  const s = createFlagState();
  s.tick({ rawBits: GREEN | YELLOW, tNow: 1000 });
  assert.equal(s.getState().activeFlag, 'yellow');
});

test('transition yellow → green switches the active flag', () => {
  const s = createFlagState();
  s.tick({ rawBits: YELLOW, tNow: 1000 });
  assert.equal(s.getState().activeFlag, 'yellow');
  s.tick({ rawBits: GREEN, tNow: 1200 });
  assert.equal(s.getState().activeFlag, 'green');
  assert.equal(s.getState().since, 1200);
});

test('flag clears but stays visible through MIN_DWELL_MS', () => {
  const s = createFlagState();
  s.tick({ rawBits: YELLOW, tNow: 1000 });
  s.tick({ rawBits: 0,      tNow: 2000 }); // cleared after 1s — still within 3s dwell
  assert.equal(s.getState().activeFlag, 'yellow');
});

test('flag clears completely once MIN_DWELL_MS has elapsed', () => {
  const s = createFlagState();
  s.tick({ rawBits: YELLOW, tNow: 1000 });
  s.tick({ rawBits: 0,      tNow: 2000 });  // still dwelling
  s.tick({ rawBits: 0,      tNow: 4500 });  // 3500ms after display start → beyond dwell
  assert.equal(s.getState().activeFlag, null);
  assert.equal(s.getState().since, null);
});

test('blue shows first time', () => {
  const s = createFlagState();
  s.tick({ rawBits: BLUE, tNow: 1000 });
  assert.equal(s.getState().activeFlag, 'blue');
});

test('blue cleared → re-blue within 15s cooldown is suppressed', () => {
  const s = createFlagState();
  s.tick({ rawBits: BLUE, tNow: 1000 });
  s.tick({ rawBits: 0,    tNow: 2000 });   // blue cleared → cooldown starts at 2000
  // Dwell expires; displayed clears at or after 4000
  s.tick({ rawBits: 0,    tNow: 5000 });
  assert.equal(s.getState().activeFlag, null);
  // Re-blue at 10000 — 8000ms into cooldown, should still be suppressed (cooldown ends 17000)
  s.tick({ rawBits: BLUE, tNow: 10000 });
  assert.equal(s.getState().activeFlag, null);
});

test('blue cleared → re-blue after 15s cooldown shows again', () => {
  const s = createFlagState();
  s.tick({ rawBits: BLUE, tNow: 1000 });
  s.tick({ rawBits: 0,    tNow: 2000 });   // cooldown starts at 2000, ends 17000
  s.tick({ rawBits: 0,    tNow: 5000 });   // displayed clears here
  s.tick({ rawBits: BLUE, tNow: 18000 });  // past cooldown
  assert.equal(s.getState().activeFlag, 'blue');
});

test('blue throttle does not suppress yellow', () => {
  const s = createFlagState();
  s.tick({ rawBits: BLUE,   tNow: 1000 });
  s.tick({ rawBits: 0,      tNow: 2000 });   // cooldown starts
  s.tick({ rawBits: 0,      tNow: 5000 });   // cleared
  s.tick({ rawBits: YELLOW, tNow: 6000 });
  assert.equal(s.getState().activeFlag, 'yellow');
});

test('reset() clears cooldown and displayed state', () => {
  const s = createFlagState();
  s.tick({ rawBits: BLUE, tNow: 1000 });
  s.tick({ rawBits: 0,    tNow: 2000 });
  s.reset();
  s.tick({ rawBits: BLUE, tNow: 3000 });  // would be suppressed without reset
  assert.equal(s.getState().activeFlag, 'blue');
});

test('getState echoes rawBits', () => {
  const s = createFlagState();
  s.tick({ rawBits: YELLOW | BLUE, tNow: 1000 });
  assert.equal(s.getState().rawBits, YELLOW | BLUE);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```sh
cd bridge && node --test test-flagState.js
```

Expected: FAIL — `Cannot find module './flagState'` (file doesn't exist yet).

- [ ] **Step 3: Do NOT commit yet.** Proceed to Task 2 — we commit the failing test together with the passing implementation.

---

## Task 2: `flagState.js` — implement to pass tests

**Files:**
- Create: `bridge/flagState.js`

- [ ] **Step 1: Write the module**

Write this exact content to `bridge/flagState.js`:

```js
'use strict';

// Self-contained flag state tracker — no electron, no iRacing SDK imports.
// Consumed by telemetry.js via tick() and broadcast on the 'flags' WS channel.
// Priority ladder + blue-flag throttle + minimum-dwell state machine.

function createFlagState() {
  let state;

  function init() {
    state = {
      displayed: null,          // currently-shown flag key or null
      displayedSince: 0,        // tNow when displayed became non-null
      lastRawBits: 0,
      blueWasPresented: false,  // was blue actually shown (not suppressed) in the previous tick
      blueCooldownUntil: 0,     // tNow after which blue is allowed to re-trigger
    };
  }

  function reset() {
    init();
  }

  const MIN_DWELL_MS = 3000;
  const BLUE_COOLDOWN_MS = 15000;

  // iRacing irsdk_Flags bits (subset we care about)
  const BIT_CHECKERED = 0x1;
  const BIT_WHITE     = 0x2;
  const BIT_GREEN     = 0x4 | 0x400;                    // green | greenHeld
  const BIT_YELLOW    = 0x8 | 0x100 | 0x4000 | 0x8000;  // yellow | yellowWaving | caution | cautionWaving
  const BIT_BLUE      = 0x20;
  const BIT_BLACK     = 0x10000;

  // Lower number = higher priority
  const PRIORITY = { black: 1, checkered: 2, white: 3, yellow: 4, blue: 5, green: 6 };

  function activeFlagKeysFromBits(rawBits) {
    const keys = [];
    if ((rawBits & BIT_BLACK)     !== 0) keys.push('black');
    if ((rawBits & BIT_CHECKERED) !== 0) keys.push('checkered');
    if ((rawBits & BIT_WHITE)     !== 0) keys.push('white');
    if ((rawBits & BIT_YELLOW)    !== 0) keys.push('yellow');
    if ((rawBits & BIT_BLUE)      !== 0) keys.push('blue');
    if ((rawBits & BIT_GREEN)     !== 0) keys.push('green');
    return keys;
  }

  function highestPriority(keys) {
    if (keys.length === 0) return null;
    let best = keys[0];
    let bestP = PRIORITY[best];
    for (let i = 1; i < keys.length; i++) {
      const p = PRIORITY[keys[i]];
      if (p < bestP) { best = keys[i]; bestP = p; }
    }
    return best;
  }

  function tick(snapshot) {
    const tNow = snapshot.tNow;
    const rawBits = snapshot.rawBits | 0;

    const active = activeFlagKeysFromBits(rawBits);

    // Blue-flag throttle. Edge-triggered cooldown start when blue clears
    // (blueWasPresented: true → false).
    const hasBlue = active.indexOf('blue') !== -1;
    if (state.blueWasPresented && !hasBlue) {
      state.blueCooldownUntil = tNow + BLUE_COOLDOWN_MS;
    }
    const inCooldown = tNow < state.blueCooldownUntil;
    const filtered = (inCooldown && hasBlue)
      ? active.filter((k) => k !== 'blue')
      : active;
    const blueShownThisTick = filtered.indexOf('blue') !== -1;

    const candidate = highestPriority(filtered);

    if (candidate !== null && candidate !== state.displayed) {
      state.displayed = candidate;
      state.displayedSince = tNow;
    } else if (candidate === null && state.displayed !== null) {
      if (tNow - state.displayedSince >= MIN_DWELL_MS) {
        state.displayed = null;
        state.displayedSince = 0;
      }
    }

    state.blueWasPresented = blueShownThisTick;
    state.lastRawBits = rawBits;
  }

  function getState() {
    return {
      activeFlag: state.displayed,
      since: state.displayed ? state.displayedSince : null,
      rawBits: state.lastRawBits,
    };
  }

  init();

  return { init, tick, getState, reset };
}

module.exports = { createFlagState };
```

- [ ] **Step 2: Run tests to verify they pass**

Run:
```sh
cd bridge && node --test test-flagState.js
```

Expected: PASS — `ℹ pass 24` (all 24 tests).

- [ ] **Step 3: Run the combined bridge test suite to ensure nothing else broke**

Run:
```sh
cd bridge && node --test test-incidentTracker.js test-sidebarState.js test-flagState.js
```

Expected: PASS — all three suites green (28 + 15 + 24 = 67 tests).

- [ ] **Step 4: Commit**

```sh
git add bridge/flagState.js bridge/test-flagState.js
git commit -m "feat(bridge): flagState.js — pure-JS priority ladder + blue throttle + min dwell"
```

---

## Task 3: Wire `flagState` into `telemetry.js`

**Files:**
- Modify: `bridge/telemetry.js`

- [ ] **Step 1: Add the require at the top of the module**

Find the block of requires near the top (around line 24, next to the `incidentTracker` require) and add one line:

```js
const { createIncidentTracker } = require('./incidentTracker');
const { createFlagState } = require('./flagState');
```

- [ ] **Step 2: Instantiate the module**

Find the `const incidentTracker = createIncidentTracker();` line (around line 197) and add the flag state instance right below it:

```js
const incidentTracker = createIncidentTracker();
const flagState = createFlagState();
```

- [ ] **Step 3: Reset on (re)connect**

Find the `connect` branch that currently calls reset helpers after a successful iRacing connection (around line 582, where other `.clear()` and `resetFuel()` calls happen). Add a `flagState.reset();` call there:

```js
// …existing clears…
resetFuel();
flagState.reset();
// …
```

- [ ] **Step 4: Call `tick()` each poll**

Find the `incidentTracker.tick({…})` block around line 1642 and add a second `tick` call immediately after it:

```js
try {
  incidentTracker.tick({
    trackSurface,
    incidentCount,
    sessionFlags: (carIdxFlags && carIdxFlags[playerCarIdx]) || 0,
    speed: playerSpeed,
    onPitRoad: !!(onPitRoad && onPitRoad[playerCarIdx]),
    lapDistPct: playerPct,
    currentLap: currentLap || 0,
    tNow: Date.now(),
  });
} catch (e) { /* never let the tracker take down the poll loop */ }
try {
  flagState.tick({
    rawBits: (carIdxFlags && carIdxFlags[playerCarIdx]) || 0,
    tNow: Date.now(),
  });
} catch (e) { /* never let the flag tracker take down the poll loop */ }
```

- [ ] **Step 5: Broadcast on the new `flags` channel**

Find the `broadcastToChannel('session', {…})` call around line 1048. Immediately AFTER that block (after the closing `}});` on line 1070) add a new broadcast:

```js
broadcastToChannel('session', { type: 'data', channel: 'session', data: {
  // …existing session payload…
  incidents: _showIncidents ? (() => { try { return incidentTracker.getState(); } catch (e) { return null; } })() : null,
}});

broadcastToChannel('flags', { type: 'data', channel: 'flags', data: (() => {
  try { return flagState.getState(); } catch (e) { return null; }
})() });
```

- [ ] **Step 6: Verify no syntax errors by running the bridge unit tests**

Run:
```sh
cd bridge && node --test test-incidentTracker.js test-sidebarState.js test-flagState.js
```

Expected: PASS — the wiring doesn't touch any unit-tested module, this just confirms nothing in those files was accidentally modified.

- [ ] **Step 7: Verify telemetry.js parses**

Run:
```sh
node -c bridge/telemetry.js
```

Expected: no output (success). Any syntax error would print to stderr.

- [ ] **Step 8: Commit**

```sh
git add bridge/telemetry.js
git commit -m "feat(bridge): wire flagState into telemetry poll + new flags channel"
```

---

## Task 4: Create `flags.html` overlay

**Files:**
- Create: `bridge/overlays/flags.html`

- [ ] **Step 1: Write the overlay file**

Write this exact content to `bridge/overlays/flags.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Flags</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: transparent; overflow: hidden; font-family: 'Segoe UI', -apple-system, sans-serif; color: #e8e6f0; }
    .overlay-panel { background: rgba(12,13,20,0.85); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; backdrop-filter: blur(12px); overflow: hidden; position: relative; }
    .overlay-header { display: flex; align-items: center; justify-content: space-between; padding: 5px 10px; background: rgba(255,255,255,0.04); border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; color: rgba(255,255,255,0.5); }
    .status-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; margin-right: 4px; }
    .status-dot.connected { background: #3ecf8e; }
    .status-dot.waiting { background: #f79009; }
    .status-dot.demo { background: #f79009; }

    .flag-body {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 10px 14px 14px;
      opacity: 0;
      transition: opacity 0.6s ease-out;
    }
    .flag-body.visible {
      opacity: 1;
      transition: opacity 0.3s ease-in;
    }
    .flag-svg {
      width: 110px;
      height: 76px;
      display: block;
      filter: drop-shadow(0 4px 16px rgba(0,0,0,0.5));
    }
    .flag-label {
      font-size: 14px;
      font-weight: 800;
      letter-spacing: 2.5px;
      color: #fff;
      text-transform: uppercase;
    }
  </style>
</head>
<body>
  <div class="overlay-panel">
    <div class="overlay-header">
      <span>FLAGS</span>
      <span id="connection-status"><span class="status-dot demo"></span></span>
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
        <rect x="8" y="8" width="2" height="88" fill="#555"/>
        <path id="flag-fabric" d="M10 12 Q35 0, 60 12 T110 12 L110 60 Q85 72, 60 60 T10 60 Z" fill="#888">
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

  <script>
    let _fs, _logPath;
    try { _fs = require('fs'); _logPath = require('path').join(require('os').homedir(), 'atleta-bridge.log'); } catch(e) {}
    function log(msg) {
      console.log(msg);
      if (_fs) try { _fs.appendFileSync(_logPath, '[' + new Date().toISOString() + '] ' + msg + '\n'); } catch(e) {}
    }

    const BRIDGE_URL = new URLSearchParams(window.location.search).get('ws') || 'ws://localhost:9100';
    const PITWALL_DRIVER_ID = new URLSearchParams(window.location.search).get('driver') ? parseInt(new URLSearchParams(window.location.search).get('driver')) : null;
    const PITWALL_MODE = new URLSearchParams(window.location.search).get('pitwall') === '1';
    let ws = null;
    let bridgeConnected = false;
    let iracingConnected = false;
    const dataHandlers = {};

    function connectBridge(channels) {
      if (PITWALL_MODE) {
        bridgeConnected = true; iracingConnected = true; updateStatus();
        window.addEventListener('message', function(e) {
          var msg = e.data; if (!msg || !msg.type) return;
          if (msg.type === 'bridge-connected') { bridgeConnected = true; updateStatus(); }
          else if (msg.type === 'status') { iracingConnected = msg.iracing; updateStatus(); }
          else if (msg.type === 'data' && dataHandlers[msg.channel]) { dataHandlers[msg.channel](msg.data); }
        });
        return;
      }
      log('[Flags] Connecting to ' + BRIDGE_URL);
      try { ws = new WebSocket(BRIDGE_URL); } catch(e) { log('[Flags] WS error: ' + e.message); setTimeout(() => connectBridge(channels), 3000); return; }
      ws.onopen = () => { log('[Flags] Connected'); bridgeConnected = true; updateStatus(); ws.send(JSON.stringify({ type: 'subscribe', channels, driverId: PITWALL_DRIVER_ID })); };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'bridge-connected') { bridgeConnected = true; updateStatus(); }
          else if (msg.type === 'status') { iracingConnected = msg.iracing; updateStatus(); }
          else if (msg.type === 'data' && dataHandlers[msg.channel]) { dataHandlers[msg.channel](msg.data); }
        } catch(e) {}
      };
      ws.onclose = () => { log('[Flags] Disconnected'); bridgeConnected = false; iracingConnected = false; updateStatus(); setTimeout(() => connectBridge(channels), 3000); };
      ws.onerror = () => { log('[Flags] WS error'); try { ws.close(); } catch(e) {} };
    }
    function onData(ch, fn) { dataHandlers[ch] = fn; }
    function updateStatus() {
      const el = document.getElementById('connection-status');
      if (!el) return;
      if (!bridgeConnected) { el.innerHTML = '<span class="status-dot demo"></span>'; }
      else if (!iracingConnected) { el.innerHTML = '<span class="status-dot waiting"></span>'; }
      else { el.innerHTML = '<span class="status-dot connected"></span>'; }
    }

    // Per-flag visual style. Dropping a key here hides that flag from the overlay
    // (used by the showBlue control-panel toggle below).
    const FLAG_STYLES = {
      green:     { color: '#22c55e', label: 'GREEN' },
      yellow:    { color: '#f7c948', label: 'YELLOW' },
      blue:      { color: '#3b82f6', label: 'BLUE' },
      white:     { color: '#ffffff', label: 'WHITE' },
      black:     { color: '#0a0a0a', label: 'BLACK' },
      checkered: { color: 'url(#checker)', label: 'CHECKERED' },
    };

    // Respect the control-panel showBlue toggle (?showBlue=false)
    const showBlue = new URLSearchParams(window.location.search).get('showBlue') !== 'false';
    if (!showBlue) delete FLAG_STYLES.blue;

    const fabric = document.getElementById('flag-fabric');
    const label = document.getElementById('flag-label');
    const body = document.getElementById('flag-body');
    let lastActive = null;

    function renderFlag(data) {
      const active = data && data.activeFlag;
      const style = active ? FLAG_STYLES[active] : null;
      const effectiveActive = style ? active : null;  // treat filtered-out flags as none
      if (effectiveActive === lastActive) return;
      if (effectiveActive === null) {
        body.classList.remove('visible');
      } else {
        fabric.setAttribute('fill', style.color);
        label.textContent = style.label;
        label.style.color = (effectiveActive === 'black' || effectiveActive === 'checkered')
          ? '#fff'
          : style.color;
        body.classList.add('visible');
      }
      lastActive = effectiveActive;
    }

    onData('flags', renderFlag);
    connectBridge(['flags']);
  </script>
  <script src="overlay-utils.js"></script>
</body>
</html>
```

- [ ] **Step 2: Verify the file loads** (open in any local HTTP server or trust that it'll be covered by the Playwright tests in Task 6).

No direct-run test at this stage — the first real verification happens in Task 6 (Playwright).

- [ ] **Step 3: Commit**

```sh
git add bridge/overlays/flags.html
git commit -m "feat(bridge): flags.html — animated waving flag overlay"
```

---

## Task 5: Register the overlay in `main.js`

**Files:**
- Modify: `bridge/main.js`

- [ ] **Step 1: Add one entry to the `OVERLAYS` array**

Find the `OVERLAYS` array starting at line 70 and add the new entry. Place it alphabetically or next to `raceduration` — both are fine; the order affects only the legacy raw list, not sidebar grouping. Insert after `raceduration`:

```js
const OVERLAYS = [
  // …existing entries through raceduration…
  { id: 'raceduration', name: 'Race Duration', width: 280, height: 170 },
  { id: 'flags', name: 'Flags', width: 180, height: 130 },
  { id: 'drivercard', name: 'Driver Card', width: 300, height: 180 },
  // …remaining entries unchanged…
];
```

- [ ] **Step 2: Verify main.js parses**

Run:
```sh
node -c bridge/main.js
```

Expected: no output (success).

- [ ] **Step 3: Commit**

```sh
git add bridge/main.js
git commit -m "feat(bridge): register flags overlay in main.js OVERLAYS"
```

---

## Task 6: Control panel integration

**Files:**
- Modify: `bridge/control-panel.html`

- [ ] **Step 1: Add the sidebar item in the Race group**

Find the Race group around line 634 and add a new sidebar-item entry after `raceduration`:

```html
<div class="sidebar-group-label" onclick="toggleSidebarGroup('race')">&#9654; Race</div>
<div class="sidebar-group collapsed" id="group-race">
  <div class="sidebar-item" data-panel="standings" onclick="navigateTo('standings')">
    <span class="sidebar-icon">&#127937;</span> Standings
  </div>
  <div class="sidebar-item" data-panel="relative" onclick="navigateTo('relative')">
    <span class="sidebar-icon">&#128202;</span> Relative
  </div>
  <div class="sidebar-item" data-panel="raceduration" onclick="navigateTo('raceduration')">
    <span class="sidebar-icon">&#9201;</span> Duration
  </div>
  <div class="sidebar-item" data-panel="flags" onclick="navigateTo('flags')">
    <span class="sidebar-icon">&#128681;</span> Flags
  </div>
  <div class="sidebar-item" data-panel="pitstrategy" onclick="navigateTo('pitstrategy')">
    <span class="sidebar-icon">&#9881;</span> Pit Strategy
  </div>
  <!-- …rest of race group… -->
</div>
```

- [ ] **Step 2: Add the empty panel container**

Find the content panels section around line 766 (the line with `<div class="content-panel" id="panel-raceduration"></div>`) and add a new container right after it:

```html
<div class="content-panel" id="panel-raceduration"></div>
<div class="content-panel" id="panel-flags"></div>
```

- [ ] **Step 3: Add the overlays list row**

Find the `const overlays = [` array around line 1055 and add a new row after the `raceduration` entry:

```js
{ id: 'raceduration', icon: '&#9201;', name: 'Race Duration', width: 280, height: 170 },
{ id: 'flags', icon: '&#128681;', name: 'Flags', width: 180, height: 130 },
{ id: 'drivercard', icon: '&#127183;', name: 'Driver Card', width: 300, height: 180 },
```

- [ ] **Step 4: Add the `CUSTOMIZE_FIELDS.flags` entry**

Find the `CUSTOMIZE_FIELDS` object. After the `raceduration` entry (around line 1210), add:

```js
raceduration: [
  { key: 'posX', label: 'Position X (px)', type: 'number', default: '0', min: -5000, max: 5000 },
  { key: 'posY', label: 'Position Y (px)', type: 'number', default: '0', min: -3000, max: 3000 },
  { key: 'autoHide', label: 'Auto-hide when iRacing closes', type: 'checkbox', default: true },
  { key: 'showIncidents', label: 'Incident counters (off-tracks, penalties, slow laps)', type: 'checkbox', default: true },
],
flags: [
  { key: 'posX', label: 'Position X (px)', type: 'number', default: '0', min: -5000, max: 5000 },
  { key: 'posY', label: 'Position Y (px)', type: 'number', default: '0', min: -3000, max: 3000 },
  { key: 'autoHide', label: 'Auto-hide when iRacing closes', type: 'checkbox', default: true },
  { key: 'showBlue', label: 'Show blue flag alerts', type: 'checkbox', default: true },
],
```

- [ ] **Step 5: Verify control-panel.html parses (it's HTML so syntax is permissive, but at least confirm JS blocks are valid)**

Run:
```sh
grep -c '"flags"' bridge/control-panel.html
```

Expected: `4` or more (sidebar item, panel, overlays row, CUSTOMIZE_FIELDS key).

- [ ] **Step 6: Commit**

```sh
git add bridge/control-panel.html
git commit -m "feat(bridge): control panel sidebar + settings for flags overlay"
```

---

## Task 7: Add `flags` to the Playwright test fixture

**Files:**
- Modify: `bridge/tests/mock-data.js`
- Modify: `bridge/tests/overlays.spec.js`

- [ ] **Step 1: Add a `flags` generator in `mock-data.js`**

Find `generateSession` (around line 138). Add a new generator function right after it:

```js
function generateFlags(scenarioName) {
  // Simple, deterministic fixtures keyed off scenario name.
  switch (scenarioName) {
    case 'empty':
      return { activeFlag: null, since: null, rawBits: 0 };
    case 'minimal':
      return { activeFlag: 'green', since: Date.now(), rawBits: 0x4 };
    case 'extreme':
      return { activeFlag: 'black', since: Date.now(), rawBits: 0x10000 };
    default:
      return { activeFlag: 'yellow', since: Date.now(), rawBits: 0x8 };
  }
}
```

- [ ] **Step 2: Include `flags` in each scenario's return object**

`buildScenario` has two `return { … }` statements — one inline for the `'empty'` case and the final shared return for every other scenario. Add `flags:` to both:

```js
// 'empty' case:
return {
  standings: [],
  session: generateSession('--', 'Practice', 0, 0),
  fuel: { /* …unchanged… */ },
  wind: { windDirection: 0, windSpeed: 0, carHeading: 0 },
  inputs: { throttle: 0, brake: 0, clutch: 1, steer: 0, gear: 0, speed: 0 },
  relative: { playerCarIdx: 0, spectatedCarIdx: 0, cars: [], focusCar: null },
  trackmap: { trackPath: [], trackPathReady: false, cars: [], playerCarIdx: 0 },
  proximity: { carLeftRight: 0 },
  flags: generateFlags('empty'),
};
```

```js
// default return (at the bottom of buildScenario), add flags:
return {
  standings,
  session: generateSession('Circuit de Spa-Francorchamps', 'Race', 2400, standings.length),
  fuel: generateFuel(),
  wind: generateWind(),
  inputs: generateInputs(),
  relative: generateRelative(standings, 0),
  trackmap: generateTrackmap(standings),
  proximity: { carLeftRight: rand(-0.3, 0.3) },
  flags: generateFlags(name),
};
```

(For the `extreme`, `minimal`, `deep-field`, `deep-field-multi` cases that fall through to the bottom `return`, the scenario name is already `name` so `generateFlags(name)` gives correct fixtures.)

- [ ] **Step 3: Add `flags` to `OVERLAY_CHANNELS`**

Find `OVERLAY_CHANNELS` around line 321 and add:

```js
const OVERLAY_CHANNELS = {
  standings:    ['standings', 'session'],
  // …existing entries…
  raceduration: ['session', 'standings'],
  flags:        ['flags'],
  drivercard:   ['standings'],
  // …rest unchanged…
};
```

- [ ] **Step 4: Register the overlay size in `overlays.spec.js`**

Find `OVERLAY_SIZES` around line 9 and add:

```js
const OVERLAY_SIZES = {
  standings:    { w: 900, h: 800 },
  // …existing entries…
  raceduration: { w: 280, h: 80 },
  flags:        { w: 180, h: 130 },
  drivercard:   { w: 300, h: 180 },
  // …rest unchanged…
};
```

- [ ] **Step 5: Teach `waitForRender` how to detect the flag body**

Find `waitForRender` around line 58 and append `.flag-body` to the selector list:

```js
async function waitForRender(page) {
  try {
    await page.locator('.overlay-panel :is(tr, .class-dot, .stat-value, canvas, table, .no-data, .fuel-grid, .time-display, .wind-info, .stat-row, .flag-body)').first().waitFor({ timeout: 3000 });
  } catch(e) {}
  await page.waitForTimeout(500);
}
```

- [ ] **Step 6: Run the Playwright tests**

Run:
```sh
cd bridge/tests && npx playwright test --config=playwright.config.js
```

Expected: PASS for all existing tests + the new matrix for `flags`. Approximate count goes from 496 → ~530 tests (6 scales × 3 scenarios × 2 headers × 1 overlay ≈ 36 new test cells).

If any new tests fail, inspect the failure — the most likely issue is the `flags: ['flags']` channel entry missing from some scenario return object, or an incorrect selector. Fix inline and re-run until green.

- [ ] **Step 7: Commit**

```sh
git add bridge/tests/mock-data.js bridge/tests/overlays.spec.js
git commit -m "test(bridge): add flags overlay to playwright fixture"
```

---

## Task 8: Bump version, update CLAUDE.md, push

**Files:**
- Modify: `bridge/package.json`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Bump the bridge version**

Edit `bridge/package.json` — change `"version": "3.26.3",` to `"version": "3.26.4",`.

- [ ] **Step 2: Add a one-line entry to CLAUDE.md describing the new overlay**

Find the overlay list in CLAUDE.md (around line 144, the existing `weather.html` line). Add a new line after the weather entry:

```
    ├── weather.html       # Weather — animated sun/rain/clouds/fog, temps, humidity, wind, sky condition
    ├── flags.html         # Flags — animated waving SVG for green/yellow/blue/white/black/checkered with priority ladder + blue throttle
    ├── chat.html          # Streaming chat — Twitch channel overlay
```

Also find the "Key Architecture" section with the `Bridge Incident Counters` bullet (around line 207) and add a new bullet after it:

```
- **Bridge Flag Overlay (v3.26.4+):** `bridge/overlays/flags.html` — small draggable waving-SVG overlay for green/yellow/blue/white/black/checkered flags. State lives in `bridge/flagState.js` as a self-contained factory module (same pattern as `incidentTracker.js`), consumed by `telemetry.js` per poll and broadcast on a new `flags` WS channel. Priority ladder: **black > checkered > white > yellow > blue > green**. Minimum 3s on-screen dwell after iRacing clears a flag. Blue-flag cooldown: 15s after blue clears before it can re-trigger, preventing multi-class spam. Client-side `showBlue` toggle hides blue entirely for drivers who don't want it. Unit tests in `bridge/test-flagState.js` (24 tests) cover priority, dwell, and throttle. Run via `cd bridge && node --test test-incidentTracker.js test-sidebarState.js test-flagState.js` (67 tests total).
```

- [ ] **Step 3: Run the complete unit test suite one last time**

Run:
```sh
cd bridge && node --test test-incidentTracker.js test-sidebarState.js test-flagState.js
```

Expected: PASS — 67 tests total (28 incident + 15 sidebar + 24 flag).

- [ ] **Step 4: Commit and push**

```sh
git add bridge/package.json CLAUDE.md
git commit -m "v3.26.4: add bridge flag overlay (green/yellow/blue/white/black/checkered)"
git push origin main
```

Expected: push succeeds, GitHub Actions triggers the bridge build for v3.26.4 which publishes a new installer to GitHub Releases.

---

## Verification

After all tasks complete, verify manually in the bridge control panel:
- [ ] Launch the bridge app
- [ ] Sidebar → Race → **Flags** appears and is clickable
- [ ] Enable toggle creates the overlay window at default size
- [ ] Overlay is draggable via the header
- [ ] Position X / Position Y fields persist across restarts
- [ ] `showBlue = false` + an iRacing multi-class session → no blue alerts
- [ ] iRacing session with a yellow → overlay shows yellow fabric + "YELLOW" label
- [ ] Yellow clears → overlay stays visible ≥ 3 seconds then fades
- [ ] Black flag penalty → overlay shows black fabric with white label
- [ ] Crossing finish at race end → overlay shows checkered pattern
