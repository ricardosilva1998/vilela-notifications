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
