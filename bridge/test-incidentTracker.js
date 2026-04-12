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
  assert.equal(s.offtracks.timeLost, 0);
  assert.equal(s.penalties.count, 0);
  assert.equal(s.penalties.timeLost, 0);
  assert.equal(s.slowLaps.count, 0);
  assert.equal(s.slowLaps.timeLost, 0);
});

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

test('offtrack: count decreasing then re-rising still detects later increment', () => {
  const t = createIncidentTracker();
  t.init();
  // Seed at count=5
  t.tick({ trackSurface: 3, incidentCount: 5, sessionFlags: 0, speed: 30, onPitRoad: false, lapDistPct: 0.1, currentLap: 2, tNow: 1000 });
  // Anomaly: count drops to 3 — must update internal lastIncidentCount, no event
  t.tick({ trackSurface: 3, incidentCount: 3, sessionFlags: 0, speed: 30, onPitRoad: false, lapDistPct: 0.2, currentLap: 2, tNow: 1100 });
  assert.equal(t.getState().offtracks.count, 0);
  // Player goes offtrack
  t.tick({ trackSurface: 0, incidentCount: 3, sessionFlags: 0, speed: 30, onPitRoad: false, lapDistPct: 0.3, currentLap: 2, tNow: 1200 });
  // Count rises to 4 — must fire (would be missed if lastIncidentCount were stuck at 5)
  t.tick({ trackSurface: 3, incidentCount: 4, sessionFlags: 0, speed: 30, onPitRoad: false, lapDistPct: 0.4, currentLap: 2, tNow: 1300 });
  assert.equal(t.getState().offtracks.count, 1);
});

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
  t.onLapComplete(4, 95.0, true);  // +5.0, above max(2.0, 90*0.05=4.5) threshold
  assert.equal(t.getState().slowLaps.count, 1);
  assert.equal(t.getState().slowLaps.timeLost, 5.0);
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
  // Seed two clean 90.0s laps
  t.onLapComplete(2, 90.0, true);
  t.onLapComplete(3, 90.0, true);
  // Slow lap of +5.123s — above the 4.5s threshold, should be counted
  t.onLapComplete(4, 95.123, true);
  const lost = t.getState().slowLaps.timeLost;
  // Verify rounding to 1 decimal place
  assert.equal(lost, Math.round(lost * 10) / 10);
  // And that it's the expected rounded value (+5.123 → 5.1)
  assert.equal(lost, 5.1);
});
