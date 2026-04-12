# Incident Counter — Design Spec

**Date:** 2026-04-12
**Component:** `bridge/incidentTracker.js` + `bridge/overlays/raceduration.html`
**Goal:** Strategy-focused counters for offtracks, penalties, and slow laps with attributed time loss.

## Problem

During a race, the player can't easily tell how much time their mistakes are actually costing them. iRacing exposes incident counts and lap times, but the strategist needs three distinct numbers in one glance:

1. How many incident-flagged off-tracks have I had?
2. How many official iRacing penalties have hit me?
3. How many laps have been "slow" (whatever the cause)?
4. **How much time have I lost** to each, vs. my clean pace?

This spec adds those counters to the existing `raceduration` overlay. Counters survive Practice → Qualifying transitions and reset to zero when the player enters a Race session.

## Requirements

### Functional

- Track three independent counters per session: **offtracks**, **penalties**, **slow laps**.
- For each counter, expose **count** and **time lost** (seconds).
- Time-lost numbers must sum to the player's actual lap-time loss vs. clean pace — no double counting.
- Display in a footer block inside the existing `raceduration.html` overlay.
- A control-panel checkbox toggles visibility (default `true`).
- Counters carry over across Practice ↔ Qualifying transitions.
- Counters reset to zero on entry into a Race session.
- Counters persist across temporary garage entries within the same session and across WS reconnects.

### Non-functional

- Detection logic must live in a self-contained module (`bridge/incidentTracker.js`) — no telemetry-specific imports, pure state machine.
- Detection runs on the existing telemetry tick (~30 Hz). No new SDK polls beyond what `telemetry.js` already reads.
- Renderer must update in place (`textContent` only). No `innerHTML` rebuilds, no FLIP animations, no per-tick `auto-resize-height` IPC thrash.
- The block hides itself when `data.incidents` is missing (older Bridge / disabled by control panel).

## Architecture

### Module: `bridge/incidentTracker.js`

Self-contained state machine. No `electron`, no `@emiliosp/node-iracing-sdk`, no `fs`. Pure functions over an internal state object.

**Public API:**

```js
init()                              // create empty state, called once at telemetry connect
tick(snapshot)                      // called each telemetry poll
                                    // snapshot = {
                                    //   trackSurface,        // PlayerTrackSurface int
                                    //   incidentCount,       // PlayerCarMyIncidentCount int
                                    //   sessionFlags,        // CarIdxSessionFlags[playerCarIdx] bitfield
                                    //   speed,               // m/s
                                    //   onPitRoad,           // bool
                                    //   lapDistPct,          // 0..1
                                    //   currentLap,          // int
                                    //   tNow,                // Date.now()
                                    // }
onLapComplete(lapNum, lapTime, isValid)
                                    // called when telemetry.js detects lap completion
onSessionChange(newSessionType)     // 'Practice' | 'Qualifying' | 'Race' | 'Lone Qualifying' | etc.
                                    // resets when transitioning into a Race-typed session
getState()                          // → { offtracks: {count, timeLost},
                                    //     penalties: {count, timeLost},
                                    //     slowLaps:  {count, timeLost} }
reset()                             // wipe state (used internally + by onSessionChange)
```

### Integration into `telemetry.js`

- `init()` is called from the existing iRacing-connect block.
- `tick(snapshot)` is called once per telemetry poll, immediately after the existing `PlayerTrackSurface` read at line 1622. The snapshot is built from values telemetry.js already reads — no new SDK calls.
- `onLapComplete(...)` is called from the existing lap-completion block (where the per-lap recorder logs the lap time).
- `onSessionChange(...)` is called from the existing session-num-changed block (where standings/persistedDrivers/etc. are cleared).
- `getState()` is called once per `raceduration` channel broadcast and embedded in the channel payload as `data.incidents`.

### Data flow

```
iRacing SDK → telemetry.js poll loop
                ↓ (snapshot)
        incidentTracker.tick()
                ↓ (state update)
        incidentTracker.getState()
                ↓ (embedded in raceduration channel)
        broadcastToChannel('raceduration', { ...existing, incidents: {...} })
                ↓ (WebSocket)
        raceduration.html handler
                ↓ (textContent updates)
        UI footer block
```

No new WS channel. No new IPC. The single coupling point is the `raceduration` channel payload schema.

## Detection logic

### Offtracks (incident-flagged off-tracks)

A 3-second rolling window of "track-surface was off" timestamps.

```
on every tick:
  if trackSurface == 0 (OffTrack):
    push tNow to offtrackWindow
  prune offtrackWindow entries older than tNow - 3000ms

  if incidentCount > lastIncidentCount:
    delta = incidentCount - lastIncidentCount
    if offtrackWindow not empty:
      offtracks.count += 1     # one offtrack event regardless of x1/x2/x4 weight
      thisLapHadOfftrack = true
    lastIncidentCount = incidentCount
```

The 3-second window covers the "drove off, recovered, then iRacing tagged the incident a beat later" lag.

False-positive note: a contact incident that happens while the player is also briefly off-track (e.g. T-bone in the gravel) gets bucketed as offtrack. Acceptable for v1 — both are still incidents the strategist cares about.

### Penalties (real iRacing-issued)

Edge-triggered on `CarIdxSessionFlags[playerCarIdx]` bit transitions.

Watched bits (from `irsdk_Flags`):
- `0x10000`  — `irsdk_black` (black flag)
- `0x100000` — `irsdk_repair` (meatball / damage)
- `0x80000`  — `irsdk_furled` (move-over / blue, when waved at the player)

```
on every tick:
  for each watched bit:
    wasSet = (lastSessionFlags & bit) != 0
    nowSet = (sessionFlags & bit) != 0
    if not wasSet and nowSet:
      penalties.count += 1
      penaltyActive = { type: bitName, since: tNow, sinceLap: currentLap }
      thisLapHadPenalty = true
    if wasSet and not nowSet and penaltyActive:
      # discharge time used later for time-lost attribution
      penaltyActive = null
  lastSessionFlags = sessionFlags
```

A penalty that spans two laps causes both laps' losses to be attributed to the penalty bucket.

### Slow laps

Computed at `onLapComplete(...)`, never per-tick.

A rolling buffer of the **last 5 valid clean laps**. "Clean" means: not first lap of session, not an in-lap (entered pit road during the lap), not an out-lap (started on pit road), no offtrack-flagged this lap, no penalty active during this lap, `isValid == true`.

**In/out-lap detection** runs in `tick()`: maintain an `onPitRoadDuringLap` boolean per current lap, set to `true` whenever `snapshot.onPitRoad == true`, reset to `false` after `onLapComplete` consumes it. The lap is treated as in/out if the flag was ever true.

**Median definition**: with the buffer holding fewer than 5 laps, sort the buffer and take the middle value (odd count) or the mean of the two middle values (even count). Standard `(a+b)/2` median, computed inline — no library dependency.

```
on lap complete:
  isCleanLap = isValid and not isOutLap and not isInLap
               and not thisLapHadOfftrack
               and not thisLapHadPenalty
               and lapNum >= 2

  if isCleanLap:
    push lapTime to cleanLaps (capped at 5, FIFO)

  cleanMedian = median(cleanLaps)
  lapLoss = lapTime - cleanMedian   # only meaningful if cleanLaps.length >= 2

  if cleanLaps.length >= 2 and lapLoss > 0.3:
    # Attribute the loss using priority penalty > offtrack > slowLap
    if thisLapHadPenalty:
      penalties.timeLost += lapLoss
    elif thisLapHadOfftrack:
      offtracks.timeLost += lapLoss
    elif lapLoss >= max(2.0, cleanMedian * 0.05):
      slowLaps.count += 1
      slowLaps.timeLost += lapLoss

  reset thisLapHadOfftrack, thisLapHadPenalty
```

The slow-lap threshold is `max(2.0s, cleanMedian * 5%)` — 2 seconds absolute floor for short tracks, 5% relative for long ones.

### Time accounting (no double counting)

- **Counts are independent.** A lap can bump `offtracks.count` (during the tick) AND `penalties.count` (during the tick) — both are real events.
- **Time loss is attributed once per lap**, by priority **penalty > offtrack > slow lap**. The three `timeLost` numbers sum to the actual time the player has lost vs. clean pace.

The strategist reads it as: "Penalties cost me 8 s, offtracks cost me 5 s, plain bad laps cost me 3 s — 16 s total on the table this stint."

## Reset triggers

- **Reset to zero** when transitioning into a Race-typed session (previous wasn't Race, new one is).
- **Carry over** for any other transition: P→Q, Q→P, P→P, Q→Q.
- **Don't reset** on temporary garage entries within the same session number.
- **Don't reset** on Bridge WS reconnects — module state lives in main process.
- **Don't reset** on iRacing reconnect within the same session number.

`onSessionChange` is the only method that triggers a reset; the existing `telemetry.js` session-num-changed block calls it with the new session type pulled from `SessionInfo.Sessions[currentSessionNum].SessionType`.

## UI integration

### Markup (added to `raceduration.html`)

A single `<div class="incidents-block">` appended after the existing race-duration display block, separated by a thin top border that matches the overlay's existing dividers.

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

### Render (data handler, in `raceduration.html`)

```js
function renderIncidents(inc) {
  const block = document.getElementById('incidents-block');
  if (!inc) {
    block.style.display = 'none';
    return;
  }
  block.style.display = '';
  document.getElementById('inc-offtracks-count').textContent = formatCount(inc.offtracks.count);
  document.getElementById('inc-offtracks-loss').textContent = formatLoss(inc.offtracks.timeLost);
  document.getElementById('inc-penalties-count').textContent = formatCount(inc.penalties.count);
  document.getElementById('inc-penalties-loss').textContent = formatLoss(inc.penalties.timeLost);
  document.getElementById('inc-slowlaps-count').textContent = formatCount(inc.slowLaps.count);
  document.getElementById('inc-slowlaps-loss').textContent = formatLoss(inc.slowLaps.timeLost);
}

function formatCount(n) { return n > 99 ? '99+' : String(n); }
function formatLoss(secs) {
  if (secs < 60) return '−' + secs.toFixed(1) + 's';
  const m = Math.floor(secs / 60);
  const s = Math.round(secs - m * 60);
  return '−' + m + ':' + (s < 10 ? '0' : '') + s;
}
```

Called from the existing `raceduration` channel handler with `renderIncidents(data.incidents)`. No `innerHTML`, no per-row rebuild, no FLIP.

The overlay's existing `auto-resize-height` IPC handles the height delta when the block first appears.

### CSS (added to the overlay's existing style block)

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
  font-size: var(--row-font, 12px);
}
.incident-icon { font-size: 11px; }
.incident-label { color: rgba(255,255,255,0.5); }
.incident-count { font-weight: 700; color: #fff; min-width: 22px; text-align: right; }
.incident-loss { font-family: 'JetBrains Mono', monospace; color: rgba(255,255,255,0.7); min-width: 50px; text-align: right; }
```

### Control-panel toggle

New checkbox in the control-panel `raceduration` settings tab: `Incident counters` (default `true`). The setting is read in `telemetry.js` before embedding `data.incidents` — when off, the field is omitted entirely and the renderer hides the block on the next tick.

## Edge cases

| Scenario | Behavior |
|---|---|
| Out lap / in lap | Excluded from clean-lap median; never counted as a slow lap. Detected via `OnPitRoad == true` at any point during the lap. |
| First lap of session | Never counted. Median seeds at lap 2. |
| Towing (`PlayerTrackSurface == -1`) | Pause offtrack-window updates and penalty-flag transitions until back in world. |
| Stalled / parked car (`Speed < 1 m/s` for > 10 s) | Pause incident tracking. Resumes on movement. |
| iRacing session reconnect | Same session number → counters survive. Different session number → `onSessionChange` decides whether to reset. |
| Multi-class / spectator | Tracker only runs when player car index is valid and not spectator (existing telemetry.js filter). |
| Lap invalidated by iRacing for cutting (`isValid == false`) | Excluded from rolling median, but **still counted** as a slow lap if loss exceeds threshold. Cutting must not hide time loss. |
| Lap gap > 5 minutes (long pit / disconnect / pause) | Treat as soft restart: clear rolling median (so the median reflects current pace) but keep counters. |
| Penalty spans two laps | Both laps' losses go into `penalties.timeLost`. |
| Bridge WS reconnect (renderer side) | Module state survives in main process; renderer just re-reads next tick. |

## Out of scope

- Per-corner heat map of where time is being lost.
- Persistent history across Bridge restarts. Counters live for the session and die with the process.
- Tracking other drivers' incidents (only the player car).
- Differentiating x1 / x2 / x4 incident weights — `offtracks.count` is occurrences, not severity points.
- Sound or visual alert when an event fires.
- Exporting incident events to the server-side session recorder. (Possible follow-up.)

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| 3-second offtrack window misses a delayed iRacing incident tag | Width chosen empirically; widen to 5 s if false negatives observed. |
| Slow-lap threshold (2.0 s or 5%) is wrong for some tracks | Both bounds tunable in one place; can be exposed in control panel later. |
| Penalty bit transitions misfire on session start (flags initialized to 0) | First tick after `onSessionChange` only seeds `lastSessionFlags`; no events emitted. |
| State-machine complexity drifts telemetry.js further from a clean module | The whole thing is in `incidentTracker.js`. `telemetry.js` only adds 5 call sites and 1 settings read. |
| Renderer flicker if a lap is reclassified after attribution | Attribution is lap-final and never reclassified. |

## Versioning

- Bridge bumps to **3.23.0** (feature minor bump).
- Server unaffected.
