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
      lastIncidentCount: null,     // PlayerCarMyIncidentCount last tick
      lastSessionFlags: 0,         // CarIdxSessionFlags[playerCarIdx] last tick
      firstTick: true,             // true until first tick completes (seeds lastSessionFlags)

      // Per-lap accumulators (reset by onLapComplete)
      thisLapHadOfftrack: false,
      thisLapHadPenalty: false,
      onPitRoadDuringLap: false,

      // Lap state
      cleanLaps: [],               // last 5 valid clean lap times (seconds)
      lastLapCompletedAt: 0,            // tNow of last completed lap (for soft-restart heuristic)

      // Session state
      currentSessionType: null,    // 'Practice' | 'Qualifying' | 'Race' | etc.

      // Stalled detection
      stalledSince: 0,             // tNow when speed dropped below 1 m/s; 0 = sentinel (not stalled)
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

  function median(arr) {
    if (arr.length === 0) return 0;
    const sorted = arr.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  const CLEAN_LAP_BUFFER_SIZE = 5;
  const SLOW_LAP_MIN_LOSS_SEC = 2.0;
  const SLOW_LAP_REL_THRESHOLD = 0.05;
  const SLOW_LAP_ATTRIBUTION_FLOOR = 0.3;

  const PENALTY_BITS = [
    { bit: 0x10000,  type: 'black'   },
    { bit: 0x100000, type: 'repair'  },
    { bit: 0x80000,  type: 'furled'  },
  ];

  function tick(snapshot) {
    // Any positive change in PlayerCarMyIncidentCount is counted as an incident
    // event. The previous approach gated on a 3-second trackSurface=0 window, but
    // at 10Hz polling a brief 4-wheel-off can slip entirely between polls so the
    // surface is never sampled as 0 — the event then silently dropped.
    if (state.lastIncidentCount === null) {
      state.lastIncidentCount = snapshot.incidentCount;
    } else {
      if (snapshot.incidentCount > state.lastIncidentCount) {
        state.offtracks.count += 1;
        state.thisLapHadOfftrack = true;
      }
      state.lastIncidentCount = snapshot.incidentCount;
    }

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

    // Latch onPitRoad for the current lap; consumed by onLapComplete()
    if (snapshot.onPitRoad) {
      state.onPitRoadDuringLap = true;
    }
  }

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
    state.lastLapCompletedAt = Date.now();
  }
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

  init();

  return { init, tick, onLapComplete, onSessionChange, getState, reset };
}

module.exports = { createIncidentTracker };
