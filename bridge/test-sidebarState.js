'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  pushRecent,
  toggleFavorite,
  pruneStaleIds,
  isFavorite,
} = require('./sidebarState');

test('pushRecent: adds to empty list', () => {
  assert.deepEqual(pushRecent([], 'fuel'), ['fuel']);
});

test('pushRecent: prepends to front', () => {
  assert.deepEqual(pushRecent(['standings'], 'fuel'), ['fuel', 'standings']);
});

test('pushRecent: dedupes existing entry by moving to front', () => {
  assert.deepEqual(
    pushRecent(['standings', 'fuel', 'weather'], 'fuel'),
    ['fuel', 'standings', 'weather']
  );
});

test('pushRecent: caps at default max=5', () => {
  const result = pushRecent(['a', 'b', 'c', 'd', 'e'], 'f');
  assert.equal(result.length, 5);
  assert.deepEqual(result, ['f', 'a', 'b', 'c', 'd']);
});

test('pushRecent: respects custom max', () => {
  assert.deepEqual(pushRecent(['a', 'b'], 'c', 2), ['c', 'a']);
});

test('pushRecent: ignores empty/null id', () => {
  assert.deepEqual(pushRecent(['a'], null), ['a']);
  assert.deepEqual(pushRecent(['a'], ''), ['a']);
});

test('pushRecent: does not mutate the input array', () => {
  const original = ['a', 'b'];
  pushRecent(original, 'c');
  assert.deepEqual(original, ['a', 'b']);
});

test('toggleFavorite: adds new favorite', () => {
  assert.deepEqual(toggleFavorite([], 'fuel'), ['fuel']);
});

test('toggleFavorite: removes existing favorite', () => {
  assert.deepEqual(toggleFavorite(['fuel'], 'fuel'), []);
});

test('toggleFavorite: preserves order when adding (newest at end)', () => {
  assert.deepEqual(
    toggleFavorite(['standings', 'fuel'], 'weather'),
    ['standings', 'fuel', 'weather']
  );
});

test('toggleFavorite: removes from middle without disturbing others', () => {
  assert.deepEqual(
    toggleFavorite(['standings', 'fuel', 'weather'], 'fuel'),
    ['standings', 'weather']
  );
});

test('pruneStaleIds: keeps only valid ids', () => {
  assert.deepEqual(
    pruneStaleIds(['standings', 'old1', 'fuel', 'old2'], ['standings', 'fuel', 'weather']),
    ['standings', 'fuel']
  );
});

test('pruneStaleIds: preserves order', () => {
  assert.deepEqual(
    pruneStaleIds(['fuel', 'standings'], ['standings', 'fuel', 'weather']),
    ['fuel', 'standings']
  );
});

test('isFavorite: returns true for present id', () => {
  assert.equal(isFavorite(['fuel', 'standings'], 'fuel'), true);
});

test('isFavorite: returns false for absent id', () => {
  assert.equal(isFavorite(['fuel'], 'standings'), false);
});
