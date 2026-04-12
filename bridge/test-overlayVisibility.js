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
