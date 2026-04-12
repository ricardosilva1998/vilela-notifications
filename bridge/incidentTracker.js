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
