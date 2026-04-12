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

  const OFFTRACK_WINDOW_MS = 3000;

  const PENALTY_BITS = [
    { bit: 0x10000,  type: 'black'   },
    { bit: 0x100000, type: 'repair'  },
    { bit: 0x80000,  type: 'furled'  },
  ];

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
    } else {
      if (snapshot.incidentCount > state.lastIncidentCount && state.offtrackWindow.length > 0) {
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

  function onLapComplete(_lapNum, _lapTime, _isValid) {}
  function onSessionChange(_newSessionType) {}

  init();

  return { init, tick, onLapComplete, onSessionChange, getState, reset };
}

module.exports = { createIncidentTracker };
