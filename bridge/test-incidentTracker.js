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
