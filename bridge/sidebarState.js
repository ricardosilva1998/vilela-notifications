'use strict';

// Pure data helpers for the Bridge control-panel sidebar UI state.
// No DOM, no IPC, no Electron — testable with node:test.

const RECENT_MAX_DEFAULT = 5;

function pushRecent(recent, overlayId, max = RECENT_MAX_DEFAULT) {
  if (!overlayId) return recent.slice();
  const filtered = recent.filter((id) => id !== overlayId);
  filtered.unshift(overlayId);
  return filtered.slice(0, max);
}

function toggleFavorite(favorites, overlayId) {
  if (!overlayId) return favorites.slice();
  const idx = favorites.indexOf(overlayId);
  if (idx >= 0) {
    return favorites.filter((id) => id !== overlayId);
  }
  return [...favorites, overlayId];
}

function pruneStaleIds(arr, validIds) {
  const valid = new Set(validIds);
  return arr.filter((id) => valid.has(id));
}

function isFavorite(favorites, overlayId) {
  return favorites.indexOf(overlayId) !== -1;
}

module.exports = {
  pushRecent,
  toggleFavorite,
  pruneStaleIds,
  isFavorite,
  RECENT_MAX_DEFAULT,
};
