# Incident Counter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-session offtrack/penalty/slow-lap counters with attributed time loss to the Atleta Bridge race-duration overlay.

**Architecture:** Self-contained `bridge/incidentTracker.js` factory module (zero electron / iRacing imports, pure state machine). `bridge/telemetry.js` builds a snapshot per poll, calls `tick()`, calls `onLapComplete()` from the existing lap-detection block, calls `onSessionChange()` from the existing session-num block, and embeds `getState()` into the existing `session` WS channel payload as `data.incidents`. `bridge/overlays/raceduration.html` adds a footer block that reads `data.incidents` from its existing `onData('session', ...)` handler.

**Tech Stack:** Plain CommonJS Node 20+, Node built-in `node:test` + `node:assert` (no new dev deps), existing iRacing SDK reads (no new SDK calls), existing WebSocket channel.

**Spec:** `docs/superpowers/specs/2026-04-12-offtrack-counter-design.md`

---

## File Structure

| Path | Action | Purpose |
|---|---|---|
| `bridge/incidentTracker.js` | **Create** | Factory module: `createIncidentTracker()` returns a fresh state machine with `init/tick/onLapComplete/onSessionChange/getState/reset`. |
| `bridge/test-incidentTracker.js` | **Create** | `node:test` suite covering offtrack detection, penalty bit transitions, slow-lap detection, time-loss attribution, session-change reset, in/out lap exclusion. |
| `bridge/telemetry.js` | **Modify** | Five call sites: import the module, instantiate at connect, call `tick()` per poll, call `onLapComplete()` from the existing lap-completion block, call `onSessionChange()` from the existing session-num block, embed `getState()` in the `session` channel payload. |
| `bridge/overlays/raceduration.html` | **Modify** | Add `<div class="incidents-block">` markup, CSS, and a `renderIncidents()` call from the existing `onData('session', ...)` handler. |
| `bridge/control-panel.html` | **Modify** | Add an `Incident counters` checkbox to the raceduration tab, default `true`. |
| `bridge/main.js` | **Modify** | Pass the new setting through to telemetry on settings update (existing pattern). |
| `bridge/package.json` | **Modify** | Bump version `3.22.5` → `3.23.0`. |

The whole thing is one feature in one logical area. No file is touched that isn't strictly required.

---

## Task 1: Skeleton — factory + state shape + init/reset/getState tests

**Files:**
- Create: `bridge/incidentTracker.js`
- Create: `bridge/test-incidentTracker.js`

- [ ] **Step 1: Write the failing test**

Create `bridge/test-incidentTracker.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createIncidentTracker } = require('./incidentTracker');

test('starts with zero counts and zero loss', () => {
  const t = createIncidentTracker();
  t.init();
  const s = t.getState();
  assert.equal(s.offtracks.count, 0);
  assert.equal(s.offtracks.timeLost, 0);
  assert.equal(s.penalties.count, 0);
  assert.equal(s.penalties.timeLost, 0);
  assert.equal(s.slowLaps.count, 0);
  assert.equal(s.slowLaps.timeLost, 0);
});

test('reset() returns state to zeros', () => {
  const t = createIncidentTracker();
  t.init();
  // Mutate via internal-ish path: feed a synthetic offtrack incident.
  // We can't do that yet — this test will be expanded once tick() exists.
  // For now just verify reset() is callable and idempotent.
  t.reset();
  const s = t.getState();
  assert.equal(s.offtracks.count, 0);
  assert.equal(s.penalties.count, 0);
  assert.equal(s.slowLaps.count, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```
cd bridge && node --test test-incidentTracker.js
```

Expected: `Cannot find module './incidentTracker'` (file doesn't exist yet).

- [ ] **Step 3: Create minimal `incidentTracker.js`**

Create `bridge/incidentTracker.js`:

```js
'use strict';

// Self-contained incident tracker — no electron, no iRacing SDK imports.
// All inputs come from telemetry.js via tick() / onLapComplete() / onSessionChange().
// Counts are independent (a lap can bump multiple). Time loss is attributed
// once per lap by priority: penalty > offtrack > slow lap.

function createIncidentTracker() {
  let state;

  function init() {
    state = {
      // Public counters
      offtracks: { count: 0, timeLost: 0 },
      penalties: { count: 0, timeLost: 0 },
      slowLaps:  { count: 0, timeLost: 0 },

      // Per-tick internal state
      offtrackWindow: [],          // [tNow, ...] of recent OffTrack timestamps (3s window)
      lastIncidentCount: null,     // PlayerCarMyIncidentCount last tick
      lastSessionFlags: 0,         // CarIdxSessionFlags[playerCarIdx] last tick

      // Per-lap accumulators (reset by onLapComplete)
      thisLapHadOfftrack: false,
      thisLapHadPenalty: false,
      onPitRoadDuringLap: false,

      // Lap state
      cleanLaps: [],               // last 5 valid clean lap times (seconds)
      lastLapTimeAt: 0,            // tNow of last completed lap (for soft-restart heuristic)

      // Session state
      currentSessionType: null,    // 'Practice' | 'Qualifying' | 'Race' | etc.

      // Stalled detection
      stalledSince: 0,             // tNow when speed dropped below 1 m/s, 0 if moving
    };
  }

  function reset() {
    init();
  }

  function getState() {
    return {
      offtracks: { count: state.offtracks.count, timeLost: round1(state.offtracks.timeLost) },
      penalties: { count: state.penalties.count, timeLost: round1(state.penalties.timeLost) },
      slowLaps:  { count: state.slowLaps.count,  timeLost: round1(state.slowLaps.timeLost) },
    };
  }

  function round1(n) { return Math.round(n * 10) / 10; }

  // Stub methods — fleshed out in later tasks
  function tick(_snapshot) {}
  function onLapComplete(_lapNum, _lapTime, _isValid) {}
  function onSessionChange(_newSessionType) {}

  init();

  return { init, tick, onLapComplete, onSessionChange, getState, reset };
}

module.exports = { createIncidentTracker };
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```
cd bridge && node --test test-incidentTracker.js
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add bridge/incidentTracker.js bridge/test-incidentTracker.js
git commit -m "feat(bridge): incident tracker skeleton + getState/reset tests"
```

---

## Task 2: Offtrack detection (incident-flagged off-tracks)

**Files:**
- Modify: `bridge/incidentTracker.js`
- Modify: `bridge/test-incidentTracker.js`

- [ ] **Step 1: Append offtrack tests**

Append to `bridge/test-incidentTracker.js`:

```js
test('offtrack: increments when incidentCount jumps after a recent OffTrack', () => {
  const t = createIncidentTracker();
  t.init();
  // First tick seeds lastIncidentCount, no event.
  t.tick({ trackSurface: 0, incidentCount: 0, sessionFlags: 0, speed: 30, onPitRoad: false, lapDistPct: 0.1, currentLap: 2, tNow: 1000 });
  // Player goes offtrack at 1100ms (still in window).
  t.tick({ trackSurface: 0, incidentCount: 0, sessionFlags: 0, speed: 30, onPitRoad: false, lapDistPct: 0.12, currentLap: 2, tNow: 1100 });
  // 200ms later iRacing tags an incident.
  t.tick({ trackSurface: 3, incidentCount: 1, sessionFlags: 0, speed: 30, onPitRoad: false, lapDistPct: 0.13, currentLap: 2, tNow: 1300 });
  assert.equal(t.getState().offtracks.count, 1);
});

test('offtrack: ignores incident jumps with no recent OffTrack window', () => {
  const t = createIncidentTracker();
  t.init();
  t.tick({ trackSurface: 3, incidentCount: 0, sessionFlags: 0, speed: 30, onPitRoad: false, lapDistPct: 0.1, currentLap: 2, tNow: 1000 });
  t.tick({ trackSurface: 3, incidentCount: 1, sessionFlags: 0, speed: 30, onPitRoad: false, lapDistPct: 0.12, currentLap: 2, tNow: 1100 });
  assert.equal(t.getState().offtracks.count, 0);
});

test('offtrack: window expires after 3 seconds', () => {
  const t = createIncidentTracker();
  t.init();
  t.tick({ trackSurface: 0, incidentCount: 0, sessionFlags: 0, speed: 30, onPitRoad: false, lapDistPct: 0.1, currentLap: 2, tNow: 1000 });
  // 4 seconds later — window has expired.
  t.tick({ trackSurface: 3, incidentCount: 1, sessionFlags: 0, speed: 30, onPitRoad: false, lapDistPct: 0.5, currentLap: 2, tNow: 5100 });
  assert.equal(t.getState().offtracks.count, 0);
});

test('offtrack: first tick seeds lastIncidentCount without firing', () => {
  const t = createIncidentTracker();
  t.init();
  // Player's safety rating already at incidentCount=12 when telemetry connects.
  t.tick({ trackSurface: 0, incidentCount: 12, sessionFlags: 0, speed: 30, onPitRoad: false, lapDistPct: 0.1, currentLap: 2, tNow: 1000 });
  assert.equal(t.getState().offtracks.count, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```
cd bridge && node --test test-incidentTracker.js
```

Expected: 4 new tests fail (`tick()` is currently a stub).

- [ ] **Step 3: Implement offtrack detection in `tick()`**

In `bridge/incidentTracker.js`, replace the `tick()` stub with:

```js
const OFFTRACK_WINDOW_MS = 3000;

function tick(snapshot) {
  const tNow = snapshot.tNow;

  // Slide the offtrack window forward
  while (state.offtrackWindow.length && state.offtrackWindow[0] < tNow - OFFTRACK_WINDOW_MS) {
    state.offtrackWindow.shift();
  }
  if (snapshot.trackSurface === 0) {
    state.offtrackWindow.push(tNow);
  }

  // Incident count edge detection
  if (state.lastIncidentCount === null) {
    state.lastIncidentCount = snapshot.incidentCount;
  } else if (snapshot.incidentCount > state.lastIncidentCount) {
    if (state.offtrackWindow.length > 0) {
      state.offtracks.count += 1;
      state.thisLapHadOfftrack = true;
    }
    state.lastIncidentCount = snapshot.incidentCount;
  }
}
```

The `OFFTRACK_WINDOW_MS` constant goes at the top of the file, just inside `createIncidentTracker` (so it's still per-instance configurable later if needed).

- [ ] **Step 4: Run tests to verify they pass**

Run:
```
cd bridge && node --test test-incidentTracker.js
```

Expected: 6 tests pass (2 from Task 1 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add bridge/incidentTracker.js bridge/test-incidentTracker.js
git commit -m "feat(bridge): incident tracker — offtrack detection via incident-count + 3s window"
```

---

## Task 3: Penalty bit transition detection

**Files:**
- Modify: `bridge/incidentTracker.js`
- Modify: `bridge/test-incidentTracker.js`

- [ ] **Step 1: Append penalty tests**

Append to `bridge/test-incidentTracker.js`:

```js
// iRacing flag bits
const FLAG_BLACK   = 0x10000;
const FLAG_REPAIR  = 0x100000;  // meatball
const FLAG_FURLED  = 0x80000;   // move-over

test('penalty: increments on transition into black flag', () => {
  const t = createIncidentTracker();
  t.init();
  t.tick({ trackSurface: 3, incidentCount: 0, sessionFlags: 0,           speed: 30, onPitRoad: false, lapDistPct: 0.1, currentLap: 2, tNow: 1000 });
  t.tick({ trackSurface: 3, incidentCount: 0, sessionFlags: FLAG_BLACK,  speed: 30, onPitRoad: false, lapDistPct: 0.2, currentLap: 2, tNow: 1100 });
  assert.equal(t.getState().penalties.count, 1);
});

test('penalty: only fires once per continuous flag activation', () => {
  const t = createIncidentTracker();
  t.init();
  t.tick({ trackSurface: 3, incidentCount: 0, sessionFlags: 0,           speed: 30, onPitRoad: false, lapDistPct: 0.1, currentLap: 2, tNow: 1000 });
  t.tick({ trackSurface: 3, incidentCount: 0, sessionFlags: FLAG_BLACK,  speed: 30, onPitRoad: false, lapDistPct: 0.2, currentLap: 2, tNow: 1100 });
  t.tick({ trackSurface: 3, incidentCount: 0, sessionFlags: FLAG_BLACK,  speed: 30, onPitRoad: false, lapDistPct: 0.3, currentLap: 2, tNow: 1200 });
  t.tick({ trackSurface: 3, incidentCount: 0, sessionFlags: FLAG_BLACK,  speed: 30, onPitRoad: false, lapDistPct: 0.4, currentLap: 2, tNow: 1300 });
  assert.equal(t.getState().penalties.count, 1);
});

test('penalty: fires again after flag clears and re-arms', () => {
  const t = createIncidentTracker();
  t.init();
  t.tick({ trackSurface: 3, incidentCount: 0, sessionFlags: 0,           speed: 30, onPitRoad: false, lapDistPct: 0.1, currentLap: 2, tNow: 1000 });
  t.tick({ trackSurface: 3, incidentCount: 0, sessionFlags: FLAG_BLACK,  speed: 30, onPitRoad: false, lapDistPct: 0.2, currentLap: 2, tNow: 1100 });
  t.tick({ trackSurface: 3, incidentCount: 0, sessionFlags: 0,           speed: 30, onPitRoad: false, lapDistPct: 0.3, currentLap: 2, tNow: 1200 });
  t.tick({ trackSurface: 3, incidentCount: 0, sessionFlags: FLAG_REPAIR, speed: 30, onPitRoad: false, lapDistPct: 0.4, currentLap: 2, tNow: 1300 });
  assert.equal(t.getState().penalties.count, 2);
});

test('penalty: transition into multiple bits at once counts as one event per bit', () => {
  const t = createIncidentTracker();
  t.init();
  t.tick({ trackSurface: 3, incidentCount: 0, sessionFlags: 0, speed: 30, onPitRoad: false, lapDistPct: 0.1, currentLap: 2, tNow: 1000 });
  t.tick({ trackSurface: 3, incidentCount: 0, sessionFlags: FLAG_BLACK | FLAG_REPAIR, speed: 30, onPitRoad: false, lapDistPct: 0.2, currentLap: 2, tNow: 1100 });
  assert.equal(t.getState().penalties.count, 2);
});

test('penalty: first tick seeds lastSessionFlags without firing', () => {
  const t = createIncidentTracker();
  t.init();
  t.tick({ trackSurface: 3, incidentCount: 0, sessionFlags: FLAG_BLACK, speed: 30, onPitRoad: false, lapDistPct: 0.1, currentLap: 2, tNow: 1000 });
  assert.equal(t.getState().penalties.count, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```
cd bridge && node --test test-incidentTracker.js
```

Expected: 5 new penalty tests fail.

- [ ] **Step 3: Implement penalty detection in `tick()`**

In `bridge/incidentTracker.js`, add the watched bits constant near the top of the file (right after `OFFTRACK_WINDOW_MS`):

```js
const PENALTY_BITS = [
  { bit: 0x10000,  type: 'black'   },
  { bit: 0x100000, type: 'repair'  },
  { bit: 0x80000,  type: 'furled'  },
];
```

And add `firstTick` tracking. In `init()`, add `firstTick: true` to the state object. Then extend `tick()` after the offtrack block:

```js
// Penalty bit transitions (edge-triggered)
if (state.firstTick) {
  state.lastSessionFlags = snapshot.sessionFlags;
  state.firstTick = false;
} else {
  for (const { bit } of PENALTY_BITS) {
    const wasSet = (state.lastSessionFlags & bit) !== 0;
    const nowSet = (snapshot.sessionFlags & bit) !== 0;
    if (!wasSet && nowSet) {
      state.penalties.count += 1;
      state.thisLapHadPenalty = true;
    }
  }
  state.lastSessionFlags = snapshot.sessionFlags;
}
```

Note: the offtrack `lastIncidentCount === null` seed handles the first-tick case for offtracks. Keep that logic — don't unify with `firstTick`. (They're conceptually separate: incident-count seeding ignores the value, flag-bit seeding ignores transitions.)

- [ ] **Step 4: Run tests to verify they pass**

Run:
```
cd bridge && node --test test-incidentTracker.js
```

Expected: 11 tests pass total.

- [ ] **Step 5: Commit**

```bash
git add bridge/incidentTracker.js bridge/test-incidentTracker.js
git commit -m "feat(bridge): incident tracker — penalty bit transition detection (black/repair/furled)"
```

---

## Task 4: Pit-road in/out lap tracking

**Files:**
- Modify: `bridge/incidentTracker.js`
- Modify: `bridge/test-incidentTracker.js`

- [ ] **Step 1: Append pit-road tests**

Append to `bridge/test-incidentTracker.js`:

```js
test('pit road: onPitRoadDuringLap latches across the lap', () => {
  const t = createIncidentTracker();
  t.init();
  t.tick({ trackSurface: 3, incidentCount: 0, sessionFlags: 0, speed: 30, onPitRoad: false, lapDistPct: 0.1, currentLap: 2, tNow: 1000 });
  t.tick({ trackSurface: 3, incidentCount: 0, sessionFlags: 0, speed: 5,  onPitRoad: true,  lapDistPct: 0.2, currentLap: 2, tNow: 1100 });
  t.tick({ trackSurface: 3, incidentCount: 0, sessionFlags: 0, speed: 30, onPitRoad: false, lapDistPct: 0.3, currentLap: 2, tNow: 1200 });
  // Latch is internal; we observe it via slow-lap exclusion in Task 5,
  // but for this task we just verify it doesn't crash.
  assert.equal(t.getState().offtracks.count, 0);
});
```

- [ ] **Step 2: Run test to verify it passes (no new behavior yet)**

Run:
```
cd bridge && node --test test-incidentTracker.js
```

Expected: 12 tests pass (the new test currently passes by accident — the latch isn't observable yet).

- [ ] **Step 3: Add the latch into `tick()`**

In `bridge/incidentTracker.js`, append to the end of `tick()`:

```js
// Latch onPitRoad for the current lap; consumed by onLapComplete()
if (snapshot.onPitRoad) {
  state.onPitRoadDuringLap = true;
}
```

- [ ] **Step 4: Run tests to verify they still pass**

Run:
```
cd bridge && node --test test-incidentTracker.js
```

Expected: 12 tests pass.

- [ ] **Step 5: Commit**

```bash
git add bridge/incidentTracker.js bridge/test-incidentTracker.js
git commit -m "feat(bridge): incident tracker — latch onPitRoad per lap for in/out detection"
```

---

## Task 5: Slow-lap detection + median + clean-lap buffer

**Files:**
- Modify: `bridge/incidentTracker.js`
- Modify: `bridge/test-incidentTracker.js`

- [ ] **Step 1: Append slow-lap tests**

Append to `bridge/test-incidentTracker.js`:

```js
test('slow lap: needs at least 2 clean laps in median before firing', () => {
  const t = createIncidentTracker();
  t.init();
  // First clean lap — no median yet
  t.onLapComplete(2, 90.0, true);
  // Second clean lap — median is now available (90.0 + 90.0)/2 = 90.0
  t.onLapComplete(3, 90.0, true);
  // Third lap is +5s — should fire
  t.onLapComplete(4, 95.0, true);
  assert.equal(t.getState().slowLaps.count, 1);
});

test('slow lap: time loss attributed = lap - median', () => {
  const t = createIncidentTracker();
  t.init();
  t.onLapComplete(2, 90.0, true);
  t.onLapComplete(3, 90.0, true);
  t.onLapComplete(4, 93.0, true);  // +3.0
  assert.equal(t.getState().slowLaps.count, 1);
  assert.equal(t.getState().slowLaps.timeLost, 3.0);
});

test('slow lap: lap within threshold is NOT counted', () => {
  const t = createIncidentTracker();
  t.init();
  t.onLapComplete(2, 90.0, true);
  t.onLapComplete(3, 90.0, true);
  // +1.5s loss — below max(2.0, 90*5%=4.5) threshold
  t.onLapComplete(4, 91.5, true);
  assert.equal(t.getState().slowLaps.count, 0);
  assert.equal(t.getState().slowLaps.timeLost, 0);
});

test('slow lap: in/out laps excluded from median and not counted', () => {
  const t = createIncidentTracker();
  t.init();
  t.onLapComplete(2, 90.0, true);
  t.onLapComplete(3, 90.0, true);
  // Pit-in lap: latch pit-road during this lap via tick()
  t.tick({ trackSurface: 3, incidentCount: 0, sessionFlags: 0, speed: 30, onPitRoad: false, lapDistPct: 0.5, currentLap: 4, tNow: 1000 });
  t.tick({ trackSurface: 3, incidentCount: 0, sessionFlags: 0, speed: 5,  onPitRoad: true,  lapDistPct: 0.95, currentLap: 4, tNow: 2000 });
  t.onLapComplete(4, 120.0, true);  // huge loss but in-lap — must NOT count
  assert.equal(t.getState().slowLaps.count, 0);
  assert.equal(t.getState().slowLaps.timeLost, 0);
});

test('slow lap: invalid lap excluded from median but still counted as slow', () => {
  const t = createIncidentTracker();
  t.init();
  t.onLapComplete(2, 90.0, true);
  t.onLapComplete(3, 90.0, true);
  // Cut lap, isValid=false, big loss — excluded from median but DOES count as slow
  t.onLapComplete(4, 95.0, false);
  assert.equal(t.getState().slowLaps.count, 1);
  assert.equal(t.getState().slowLaps.timeLost, 5.0);
  // Verify median isn't polluted: next lap with same time wouldn't be slow
  t.onLapComplete(5, 90.0, true);
  assert.equal(t.getState().slowLaps.count, 1);
});

test('slow lap: rolling median caps at 5 laps', () => {
  const t = createIncidentTracker();
  t.init();
  t.onLapComplete(2, 90.0, true);
  t.onLapComplete(3, 90.0, true);
  t.onLapComplete(4, 90.0, true);
  t.onLapComplete(5, 90.0, true);
  t.onLapComplete(6, 90.0, true);
  // Sixth clean lap evicts the first — median still 90.0
  t.onLapComplete(7, 90.0, true);
  // Now feed a much-slower lap; should fire on a clean median of 90.0
  t.onLapComplete(8, 96.0, true);
  assert.equal(t.getState().slowLaps.count, 1);
  assert.equal(t.getState().slowLaps.timeLost, 6.0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```
cd bridge && node --test test-incidentTracker.js
```

Expected: 6 new slow-lap tests fail (`onLapComplete()` is currently a stub).

- [ ] **Step 3: Implement `onLapComplete()` and helpers**

In `bridge/incidentTracker.js`, add a `median` helper near the top of the file, just inside the factory:

```js
function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
```

Replace the `onLapComplete` stub with:

```js
const CLEAN_LAP_BUFFER_SIZE = 5;
const SLOW_LAP_MIN_LOSS_SEC = 2.0;
const SLOW_LAP_REL_THRESHOLD = 0.05;
const SLOW_LAP_ATTRIBUTION_FLOOR = 0.3;

function onLapComplete(lapNum, lapTime, isValid) {
  const isInOrOutLap = state.onPitRoadDuringLap;
  const isCleanLap = isValid
    && !isInOrOutLap
    && !state.thisLapHadOfftrack
    && !state.thisLapHadPenalty
    && lapNum >= 2;

  if (isCleanLap) {
    state.cleanLaps.push(lapTime);
    if (state.cleanLaps.length > CLEAN_LAP_BUFFER_SIZE) state.cleanLaps.shift();
  }

  // Need at least 2 clean laps to compute a meaningful median
  if (state.cleanLaps.length >= 2 && !isInOrOutLap && lapNum >= 2) {
    const cleanMedian = median(state.cleanLaps);
    const lapLoss = lapTime - cleanMedian;
    if (lapLoss >= SLOW_LAP_ATTRIBUTION_FLOOR) {
      const slowThreshold = Math.max(SLOW_LAP_MIN_LOSS_SEC, cleanMedian * SLOW_LAP_REL_THRESHOLD);
      // Attribute loss using priority: penalty > offtrack > slow lap
      if (state.thisLapHadPenalty) {
        state.penalties.timeLost += lapLoss;
      } else if (state.thisLapHadOfftrack) {
        state.offtracks.timeLost += lapLoss;
      } else if (lapLoss >= slowThreshold) {
        state.slowLaps.count += 1;
        state.slowLaps.timeLost += lapLoss;
      }
    }
  }

  // Reset per-lap accumulators
  state.thisLapHadOfftrack = false;
  state.thisLapHadPenalty = false;
  state.onPitRoadDuringLap = false;
  state.lastLapTimeAt = Date.now();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```
cd bridge && node --test test-incidentTracker.js
```

Expected: 18 tests pass.

- [ ] **Step 5: Commit**

```bash
git add bridge/incidentTracker.js bridge/test-incidentTracker.js
git commit -m "feat(bridge): incident tracker — slow-lap detection + clean-lap median + attribution"
```

---

## Task 6: Time-loss attribution priority + count independence

**Files:**
- Modify: `bridge/test-incidentTracker.js`

- [ ] **Step 1: Append attribution tests**

Append to `bridge/test-incidentTracker.js`:

```js
test('attribution: penalty + offtrack on same lap → counts both, time → penalty bucket', () => {
  const t = createIncidentTracker();
  t.init();
  // Seed median with two clean 90.0s laps
  t.onLapComplete(2, 90.0, true);
  t.onLapComplete(3, 90.0, true);

  // Lap 4: trigger offtrack mid-lap
  t.tick({ trackSurface: 0, incidentCount: 5, sessionFlags: 0, speed: 30, onPitRoad: false, lapDistPct: 0.1, currentLap: 4, tNow: 1000 });
  t.tick({ trackSurface: 3, incidentCount: 6, sessionFlags: 0, speed: 30, onPitRoad: false, lapDistPct: 0.15, currentLap: 4, tNow: 1100 });
  // Then trigger black flag mid-lap
  t.tick({ trackSurface: 3, incidentCount: 6, sessionFlags: FLAG_BLACK, speed: 30, onPitRoad: false, lapDistPct: 0.5, currentLap: 4, tNow: 1500 });

  // Lap completes 8s slower than clean median
  t.onLapComplete(4, 98.0, true);

  const s = t.getState();
  assert.equal(s.offtracks.count, 1);                 // counted
  assert.equal(s.penalties.count, 1);                 // counted
  assert.equal(s.offtracks.timeLost, 0);              // NOT credited (penalty wins)
  assert.equal(s.penalties.timeLost, 8.0);            // credited
  assert.equal(s.slowLaps.count, 0);                  // not slow (other buckets won)
});

test('attribution: offtrack-only lap → time → offtrack bucket', () => {
  const t = createIncidentTracker();
  t.init();
  t.onLapComplete(2, 90.0, true);
  t.onLapComplete(3, 90.0, true);

  t.tick({ trackSurface: 0, incidentCount: 5, sessionFlags: 0, speed: 30, onPitRoad: false, lapDistPct: 0.1, currentLap: 4, tNow: 1000 });
  t.tick({ trackSurface: 3, incidentCount: 6, sessionFlags: 0, speed: 30, onPitRoad: false, lapDistPct: 0.15, currentLap: 4, tNow: 1100 });
  t.onLapComplete(4, 95.0, true);

  const s = t.getState();
  assert.equal(s.offtracks.count, 1);
  assert.equal(s.offtracks.timeLost, 5.0);
  assert.equal(s.slowLaps.count, 0);
  assert.equal(s.slowLaps.timeLost, 0);
});

test('attribution: small loss (< floor) is not attributed anywhere', () => {
  const t = createIncidentTracker();
  t.init();
  t.onLapComplete(2, 90.0, true);
  t.onLapComplete(3, 90.0, true);
  t.onLapComplete(4, 90.2, true);  // +0.2s, below 0.3 floor
  const s = t.getState();
  assert.equal(s.slowLaps.count, 0);
  assert.equal(s.slowLaps.timeLost, 0);
});

test('attribution: rounding to 0.1s in getState output', () => {
  const t = createIncidentTracker();
  t.init();
  t.onLapComplete(2, 90.0, true);
  t.onLapComplete(3, 90.0, true);
  t.onLapComplete(4, 92.345, true);  // +2.345s
  // slow-lap threshold = max(2.0, 90*0.05=4.5) = 4.5; lap loss 2.345 < 4.5 → NOT slow
  assert.equal(t.getState().slowLaps.count, 0);
  // Now a real slow lap
  t.onLapComplete(5, 95.123, true);  // +5.123s vs median (mix of 90,90,92.345)
  // We don't pin the exact value (median shifts) — just verify it's rounded to 1 decimal
  const lost = t.getState().slowLaps.timeLost;
  assert.equal(lost, Math.round(lost * 10) / 10);
});
```

- [ ] **Step 2: Run tests to verify they pass (Task 5 already implemented attribution)**

Run:
```
cd bridge && node --test test-incidentTracker.js
```

Expected: 22 tests pass.

If they don't all pass, the most likely cause is the attribution priority being wrong in `onLapComplete`. Re-check that the `if/else if/else if` ladder follows penalty > offtrack > slow.

- [ ] **Step 3: Commit**

```bash
git add bridge/test-incidentTracker.js
git commit -m "test(bridge): incident tracker — attribution priority + count independence"
```

---

## Task 7: Session-change reset (race entry only)

**Files:**
- Modify: `bridge/incidentTracker.js`
- Modify: `bridge/test-incidentTracker.js`

- [ ] **Step 1: Append session-change tests**

Append to `bridge/test-incidentTracker.js`:

```js
test('session change: P → Q carries over (no reset)', () => {
  const t = createIncidentTracker();
  t.init();
  t.onSessionChange('Practice');
  t.onLapComplete(2, 90.0, true);
  t.onLapComplete(3, 90.0, true);
  t.onLapComplete(4, 95.0, true);  // slow lap
  assert.equal(t.getState().slowLaps.count, 1);

  t.onSessionChange('Qualifying');
  assert.equal(t.getState().slowLaps.count, 1);  // carried over
});

test('session change: P → Race resets to zero', () => {
  const t = createIncidentTracker();
  t.init();
  t.onSessionChange('Practice');
  t.onLapComplete(2, 90.0, true);
  t.onLapComplete(3, 90.0, true);
  t.onLapComplete(4, 95.0, true);
  assert.equal(t.getState().slowLaps.count, 1);

  t.onSessionChange('Race');
  assert.equal(t.getState().slowLaps.count, 0);
  assert.equal(t.getState().slowLaps.timeLost, 0);
});

test('session change: Q → Race resets to zero', () => {
  const t = createIncidentTracker();
  t.init();
  t.onSessionChange('Qualifying');
  t.onLapComplete(2, 90.0, true);
  t.onLapComplete(3, 90.0, true);
  t.onLapComplete(4, 95.0, true);
  assert.equal(t.getState().slowLaps.count, 1);

  t.onSessionChange('Race');
  assert.equal(t.getState().slowLaps.count, 0);
});

test('session change: Race → Race (rejoin) does NOT reset', () => {
  const t = createIncidentTracker();
  t.init();
  t.onSessionChange('Race');
  t.onLapComplete(2, 90.0, true);
  t.onLapComplete(3, 90.0, true);
  t.onLapComplete(4, 95.0, true);
  assert.equal(t.getState().slowLaps.count, 1);

  // Rejoin same race session — should NOT reset
  t.onSessionChange('Race');
  assert.equal(t.getState().slowLaps.count, 1);
});

test('session change: first call sets currentSessionType without reset', () => {
  const t = createIncidentTracker();
  t.init();
  t.onLapComplete(2, 90.0, true);
  t.onLapComplete(3, 90.0, true);
  t.onLapComplete(4, 95.0, true);
  assert.equal(t.getState().slowLaps.count, 1);

  // First session-change call (telemetry just connected) — no reset
  t.onSessionChange('Practice');
  assert.equal(t.getState().slowLaps.count, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```
cd bridge && node --test test-incidentTracker.js
```

Expected: 5 new tests fail (`onSessionChange()` is currently a stub).

- [ ] **Step 3: Implement `onSessionChange()`**

In `bridge/incidentTracker.js`, replace the `onSessionChange` stub:

```js
function onSessionChange(newSessionType) {
  const isRace = (newSessionType || '').toLowerCase().includes('race');
  const wasRace = (state.currentSessionType || '').toLowerCase().includes('race');
  const isFirstCall = state.currentSessionType === null;

  if (!isFirstCall && isRace && !wasRace) {
    // Transitioning into a Race session — wipe counters
    const preserved = { currentSessionType: newSessionType };
    init();
    state.currentSessionType = preserved.currentSessionType;
    return;
  }

  state.currentSessionType = newSessionType;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```
cd bridge && node --test test-incidentTracker.js
```

Expected: 27 tests pass.

- [ ] **Step 5: Commit**

```bash
git add bridge/incidentTracker.js bridge/test-incidentTracker.js
git commit -m "feat(bridge): incident tracker — session-change reset on race entry only"
```

---

## Task 8: Wire incidentTracker into telemetry.js

**Files:**
- Modify: `bridge/telemetry.js`

This task has no automated test (telemetry.js is not unit-testable without a real iRacing connection). We rely on manual verification at the end.

- [ ] **Step 1: Add the require + instantiation**

In `bridge/telemetry.js`, near the other top-level requires (around the existing `require('./websocket')` line), add:

```js
const { createIncidentTracker } = require('./incidentTracker');
```

Then, alongside the other top-level state declarations (search for `let pitTracking` or similar long-lived state variables), add:

```js
const incidentTracker = createIncidentTracker();
```

- [ ] **Step 2: Wire the per-tick `tick()` call**

Find the existing line (around line 1622):

```js
        const trackSurface = ir.get(VARS.PLAYER_TRACK_SURFACE)?.[0] || 0;
```

Immediately after that line, add:

```js
        // Feed incident tracker — uses values telemetry already reads above
        try {
          incidentTracker.tick({
            trackSurface,
            incidentCount: ir.get(VARS.PLAYER_CAR_MY_INCIDENT_COUNT)?.[0] || 0,
            sessionFlags: (ir.get(VARS.CAR_IDX_SESSION_FLAGS)?.[playerCarIdx]) || 0,
            speed: playerSpeed,
            onPitRoad: !!(ir.get(VARS.CAR_IDX_ON_PIT_ROAD)?.[playerCarIdx]),
            lapDistPct: ir.get(VARS.LAP_DIST_PCT)?.[0] || 0,
            currentLap: currentLap || 0,
            tNow: Date.now(),
          });
        } catch (e) { /* never let the tracker take down the poll loop */ }
```

If any of the `VARS.*` constants in that snippet don't already exist in this file, add them to the `VARS` declaration block (search for `const VARS = ir.getVars()` or equivalent at the top of telemetry.js — the SDK exposes `PlayerCarMyIncidentCount`, `CarIdxSessionFlags`, `CarIdxOnPitRoad`, `LapDistPct` under those names; map them by uppercasing+snake-casing exactly as the existing entries do).

- [ ] **Step 3: Wire the lap-completion call**

Find the existing line where `sessionRecorder.onLapComplete({ ... })` is called (around line 1391). Immediately AFTER that call, add:

```js
        try {
          incidentTracker.onLapComplete(currentLap, lastLapTime, isValidLap);
        } catch (e) { /* tracker errors must not affect lap recording */ }
```

`isValidLap` is the same flag the session recorder uses — if the variable name in your code is different (e.g. `lapValid`), use that. Look right above the `sessionRecorder.onLapComplete` call to find the exact name.

- [ ] **Step 4: Wire the session-change call**

Find the existing session-change-detection block (search for the place where `persistedDrivers.clear()` or similar session-change cleanups happen, around line 700–730 — the block that runs when `sessionNum` differs from a previous tick's `sessionNum`).

Inside that block, add:

```js
        try {
          const newSessionType = ir.getSessionInfo('SessionInfo')?.Sessions?.[sessionNum]?.SessionType || '';
          incidentTracker.onSessionChange(newSessionType);
        } catch (e) { /* tracker errors must not affect session reset */ }
```

If the file already caches `sessionInfo` per tick, reuse that variable instead of re-parsing.

- [ ] **Step 5: Embed `getState()` in the `session` channel payload**

Find the `broadcastToChannel('session', { type: 'data', channel: 'session', data: { ... } })` call (around line 1039). In the data object, immediately after the existing `drivers: drivers.map(...)` block (right before the closing `}})`), add:

```js
          incidents: (() => { try { return incidentTracker.getState(); } catch (e) { return null; } })(),
```

- [ ] **Step 6: Smoke test — start Bridge, connect iRacing, run a practice session**

Run:
```
cd bridge && npm start
```

Manually:
1. Start iRacing, join a Practice session.
2. Open the race-duration overlay (control panel → Race Duration → Show).
3. Drive 2 clean laps.
4. Drive a 3rd lap intentionally going off-track (over white lines / into gravel) and triggering an incident point.
5. Verify the renderer side will receive the data — for now, open Bridge DevTools on the overlay window and inspect the last `session` channel message: `data.incidents` should be present with `offtracks.count >= 1`.

If `data.incidents` is missing or zero, check the bridge log at `~/atleta-bridge.log` for any tracker exceptions (the try/catch wrappers will surface them with `[Telemetry]` or similar).

- [ ] **Step 7: Commit**

```bash
git add bridge/telemetry.js
git commit -m "feat(bridge): wire incidentTracker into telemetry poll + session channel"
```

---

## Task 9: Add the UI footer block to raceduration.html

**Files:**
- Modify: `bridge/overlays/raceduration.html`

- [ ] **Step 1: Add the markup**

In `bridge/overlays/raceduration.html`, find the existing race-duration display block (the `<div>` containing `time-remain` and `laps-remain` IDs). Immediately AFTER that block's closing `</div>`, add:

```html
    <div class="incidents-block" id="incidents-block" style="display:none;">
      <div class="incident-row">
        <span class="incident-icon" style="color:#f7c948;">⚠</span>
        <span class="incident-label">Off-tracks</span>
        <span class="incident-count" id="inc-offtracks-count">0</span>
        <span class="incident-loss" id="inc-offtracks-loss">−0.0s</span>
      </div>
      <div class="incident-row">
        <span class="incident-icon" style="color:#f04438;">🚩</span>
        <span class="incident-label">Penalties</span>
        <span class="incident-count" id="inc-penalties-count">0</span>
        <span class="incident-loss" id="inc-penalties-loss">−0.0s</span>
      </div>
      <div class="incident-row">
        <span class="incident-icon" style="color:#8b8a9e;">↓</span>
        <span class="incident-label">Slow laps</span>
        <span class="incident-count" id="inc-slowlaps-count">0</span>
        <span class="incident-loss" id="inc-slowlaps-loss">−0.0s</span>
      </div>
    </div>
```

- [ ] **Step 2: Add the CSS**

In the same file, find the existing `<style>` block and append (just before the closing `</style>`):

```css
    .incidents-block {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid rgba(255,255,255,0.07);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .incident-row {
      display: grid;
      grid-template-columns: 16px 1fr auto auto;
      align-items: center;
      gap: 8px;
      font-size: 12px;
    }
    .incident-icon { font-size: 11px; line-height: 1; }
    .incident-label { color: rgba(255,255,255,0.5); }
    .incident-count { font-weight: 700; color: #fff; min-width: 22px; text-align: right; }
    .incident-loss { font-family: 'JetBrains Mono', monospace; color: rgba(255,255,255,0.7); min-width: 50px; text-align: right; }
```

- [ ] **Step 3: Visual smoke test (no JS yet)**

Run:
```
node bridge/tests/serve.js
```

Open the playground (`http://localhost:9400/playground.html` or whatever the test server prints) and verify the race-duration overlay still loads and the incidents block is hidden by default (`display:none`).

- [ ] **Step 4: Commit**

```bash
git add bridge/overlays/raceduration.html
git commit -m "feat(bridge): raceduration overlay — add incidents footer markup + CSS (hidden by default)"
```

---

## Task 10: Add the render handler that consumes data.incidents

**Files:**
- Modify: `bridge/overlays/raceduration.html`

- [ ] **Step 1: Add render helpers + call from session handler**

In `bridge/overlays/raceduration.html`, find the existing `onData('session', data => { ... })` block. Just BEFORE that block, add the render helpers:

```js
    function _formatIncidentCount(n) {
      return n > 99 ? '99+' : String(n);
    }

    function _formatIncidentLoss(secs) {
      if (secs == null || secs <= 0) return '−0.0s';
      if (secs < 60) return '−' + secs.toFixed(1) + 's';
      const m = Math.floor(secs / 60);
      const s = Math.round(secs - m * 60);
      return '−' + m + ':' + (s < 10 ? '0' : '') + s;
    }

    function renderIncidents(inc) {
      const block = document.getElementById('incidents-block');
      if (!block) return;
      if (!inc) {
        block.style.display = 'none';
        return;
      }
      block.style.display = '';
      document.getElementById('inc-offtracks-count').textContent = _formatIncidentCount(inc.offtracks.count);
      document.getElementById('inc-offtracks-loss').textContent  = _formatIncidentLoss(inc.offtracks.timeLost);
      document.getElementById('inc-penalties-count').textContent = _formatIncidentCount(inc.penalties.count);
      document.getElementById('inc-penalties-loss').textContent  = _formatIncidentLoss(inc.penalties.timeLost);
      document.getElementById('inc-slowlaps-count').textContent  = _formatIncidentCount(inc.slowLaps.count);
      document.getElementById('inc-slowlaps-loss').textContent   = _formatIncidentLoss(inc.slowLaps.timeLost);
    }
```

- [ ] **Step 2: Call it from the session handler**

In the same file, in the existing `onData('session', data => { ... })` block, add the following line just AFTER `if (!data) return;` and before any other logic in the handler:

```js
      renderIncidents(data.incidents);
```

- [ ] **Step 3: Manual end-to-end test**

Run:
```
cd bridge && npm start
```

Then drive a Practice session in iRacing, take 2 clean laps, then go off-track for an incident. The footer should appear with `Off-tracks: 1` and a small time-loss number (or 0.0s if the offtrack didn't actually slow the lap).

If the block stays hidden, open the overlay's DevTools (control panel → Logs → Reload Overlays may help) and check `console.log(data.incidents)` from the handler.

- [ ] **Step 4: Commit**

```bash
git add bridge/overlays/raceduration.html
git commit -m "feat(bridge): raceduration overlay — render incidents footer from session channel data"
```

---

## Task 11: Control-panel toggle for incident counters

**Files:**
- Modify: `bridge/control-panel.html`
- Modify: `bridge/main.js`
- Modify: `bridge/telemetry.js`

- [ ] **Step 1: Add the checkbox to the raceduration tab**

In `bridge/control-panel.html`, find the existing settings array for `raceduration` (search for `raceduration:` near the other overlay setting blocks). Append a new entry:

```js
        { key: 'showIncidents', label: 'Incident counters (off-tracks, penalties, slow laps)', type: 'checkbox', default: true },
```

It should sit alongside the other raceduration checkboxes (search for the existing `autoHide` entry in that section to find the right place).

- [ ] **Step 2: Pass the setting from main.js to telemetry**

In `bridge/main.js`, find where `raceduration` settings are pushed to telemetry (search for `setRaceDurationSettings` or wherever the existing raceduration settings are handled). If there's a settings-update IPC handler that forwards the raceduration sub-object, no change needed — the new key flows through automatically. If telemetry has a per-overlay settings setter, add `showIncidents` to the destructured fields.

If you can't find a clear forwarding path, expose a new helper in `bridge/telemetry.js`:

```js
function setIncidentCountersEnabled(enabled) {
  _showIncidents = !!enabled;
}
module.exports.setIncidentCountersEnabled = setIncidentCountersEnabled;
```

And call it from the existing settings-update handler in `main.js` whenever raceduration settings change:

```js
const { setIncidentCountersEnabled } = require('./telemetry');
setIncidentCountersEnabled(settings.raceduration?.showIncidents !== false);
```

- [ ] **Step 3: Gate the embed in telemetry.js**

In `bridge/telemetry.js`, near the other module-level settings flags (search for similar `let _showFoo` patterns), add:

```js
let _showIncidents = true;  // default — overridden by settings-update IPC
```

Then change the embed line added in Task 8, Step 5 from:

```js
          incidents: (() => { try { return incidentTracker.getState(); } catch (e) { return null; } })(),
```

to:

```js
          incidents: _showIncidents ? (() => { try { return incidentTracker.getState(); } catch (e) { return null; } })() : null,
```

When `_showIncidents` is `false`, the field is `null` and the renderer hides the block (renderIncidents already handles `null`).

- [ ] **Step 4: Manual test**

Start Bridge, open the control panel, untick `Incident counters` under the raceduration tab, click Save. The footer block should disappear from the overlay within one second (next session-channel tick). Re-tick the box and it should reappear.

- [ ] **Step 5: Commit**

```bash
git add bridge/control-panel.html bridge/main.js bridge/telemetry.js
git commit -m "feat(bridge): incident counters — control-panel toggle (default on)"
```

---

## Task 12: Bump bridge version + push release

**Files:**
- Modify: `bridge/package.json`

- [ ] **Step 1: Bump the version**

In `bridge/package.json`, change:

```json
  "version": "3.22.5",
```

to:

```json
  "version": "3.23.0",
```

- [ ] **Step 2: Commit**

```bash
git add bridge/package.json
git commit -m "v3.23.0: incident counters (off-tracks, penalties, slow laps) on race-duration overlay"
```

- [ ] **Step 3: Push to trigger the release build**

```bash
git push origin main
```

The existing `.github/workflows/build-bridge.yml` workflow fires on any push that touches `bridge/**` and publishes the new release to GitHub.

- [ ] **Step 4: Verify the release**

```bash
gh run list --workflow=build-bridge.yml --limit 1
```

When the run finishes, confirm the release exists:

```bash
gh release view v3.23.0
```

---

## Acceptance criteria

After all 12 tasks are complete:

- [ ] `cd bridge && node --test test-incidentTracker.js` — all 27 tests pass
- [ ] Bridge starts without console errors
- [ ] In a Practice session: drive 2 clean laps + 1 lap with an off-track incident → race-duration overlay shows `Off-tracks: 1` and a small time-loss
- [ ] Trigger a black flag in iRacing → `Penalties: 1` appears
- [ ] Drive a noticeably slow lap (no offtrack, no penalty) → `Slow laps: 1` appears with the loss attributed correctly
- [ ] On a lap with both an offtrack AND a penalty: counts increase for both, but time loss is only attributed to penalties
- [ ] Transition Practice → Qualifying: counters carry over
- [ ] Transition Practice → Race or Qualifying → Race: counters reset to zero
- [ ] Untick `Incident counters` in the control panel → footer disappears within 1s
- [ ] Re-tick → footer reappears
- [ ] GitHub release `v3.23.0` published with the new installer

---

## Self-review notes

Reviewed against the spec at `docs/superpowers/specs/2026-04-12-offtrack-counter-design.md`:

- ✅ All three counters (offtracks, penalties, slow laps) covered in Tasks 2, 3, 5
- ✅ 3-second offtrack window (Task 2) matches spec
- ✅ Penalty bits (`black 0x10000`, `repair 0x100000`, `furled 0x80000`) match spec
- ✅ Slow-lap threshold `max(2.0, median × 5%)` matches spec
- ✅ Attribution priority `penalty > offtrack > slow lap` covered in Task 5 + tested in Task 6
- ✅ Reset only on race entry (P→R, Q→R) — Task 7
- ✅ Carry over on P↔Q — Task 7
- ✅ Race rejoin doesn't reset — Task 7
- ✅ In/out lap exclusion via pit-road latch — Task 4 + Task 5
- ✅ First tick seeding (lastIncidentCount + lastSessionFlags) — Tasks 2 + 3
- ✅ UI footer with three rows + colored icons — Task 9
- ✅ `textContent` updates only (no innerHTML rebuilds) — Task 10
- ✅ Control-panel toggle, default on — Task 11
- ✅ Bridge version bump — Task 12
- ✅ Server unaffected — confirmed (no server files in the plan)

Type/method consistency:
- `createIncidentTracker()` returns `{ init, tick, onLapComplete, onSessionChange, getState, reset }` — same shape used in every task
- Snapshot keys (`trackSurface`, `incidentCount`, `sessionFlags`, `speed`, `onPitRoad`, `lapDistPct`, `currentLap`, `tNow`) are consistent across Tasks 2–8
- `state.thisLapHadOfftrack` / `state.thisLapHadPenalty` / `state.onPitRoadDuringLap` named consistently
- `state.cleanLaps` (not `cleanLapTimes`, not `medianBuffer`) — consistent

Out-of-scope items confirmed not in plan: per-corner heatmap, persistence across restarts, other-driver tracking, x1/x2/x4 weighting, sound/visual alerts, server-side recording integration.
