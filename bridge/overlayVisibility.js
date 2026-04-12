'use strict';

// Pure helpers for overlay visibility per mode.
// No electron/SDK imports — unit-testable with node:test.

const MODES = ['notRunning', 'garage', 'onTrack'];

function deriveMode(status) {
  if (!status || !status.iracing) return 'notRunning';
  return status.inGarage ? 'garage' : 'onTrack';
}

function isOverlayVisibleInMode(visibility, overlayId, mode) {
  const entry = visibility && visibility[overlayId];
  if (!entry) return true;
  return entry[mode] !== false;
}

function buildDefaultVisibility(overlayIds, legacyAutoHide) {
  // legacyAutoHide === true  → hide when not running (previous default)
  // legacyAutoHide === false → show in all three modes
  // legacyAutoHide === undefined → treat as true (first-install default)
  const hideWhenNotRunning = legacyAutoHide !== false;
  const out = {};
  for (const id of overlayIds) {
    out[id] = {
      notRunning: !hideWhenNotRunning,
      garage: true,
      onTrack: true,
    };
  }
  return out;
}

function toggleVisibility(visibility, overlayId, mode, value) {
  if (!MODES.includes(mode)) throw new Error('unknown mode: ' + mode);
  const next = { ...(visibility || {}) };
  const entry = next[overlayId] ? { ...next[overlayId] } : { notRunning: true, garage: true, onTrack: true };
  entry[mode] = !!value;
  next[overlayId] = entry;
  return next;
}

module.exports = {
  MODES,
  deriveMode,
  isOverlayVisibleInMode,
  buildDefaultVisibility,
  toggleVisibility,
};
