'use strict';

// Self-contained flag state tracker — no electron, no iRacing SDK imports.
// Consumed by telemetry.js via tick() and broadcast on the 'flags' WS channel.
// Priority ladder + blue-flag throttle + minimum-dwell state machine.

function createFlagState() {
  let state;

  function init() {
    state = {
      displayed: null,          // currently-shown flag key or null
      displayedSince: 0,        // tNow when displayed became non-null
      lastRawBits: 0,
      blueWasPresented: false,  // was blue actually shown (not suppressed) in the previous tick
      blueAbsentSince: 0,       // tNow when the current continuous blue absence began (0 = blue present OR never presented)
      blueCooldownUntil: 0,     // tNow after which blue is allowed to re-trigger
    };
  }

  function reset() {
    init();
  }

  const MIN_DWELL_MS = 3000;
  const BLUE_COOLDOWN_MS = 15000;
  const BLUE_DROPOUT_GRACE_MS = 300;  // absorb brief SDK polling dropouts before committing to a cooldown

  // iRacing irsdk_Flags bits (subset we care about)
  const BIT_CHECKERED = 0x1;
  const BIT_WHITE     = 0x2;
  const BIT_GREEN     = 0x4 | 0x400;                    // green | greenHeld
  const BIT_YELLOW    = 0x8 | 0x100 | 0x4000 | 0x8000;  // yellow | yellowWaving | caution | cautionWaving
  const BIT_BLUE      = 0x20;
  const BIT_BLACK     = 0x10000;

  // Lower number = higher priority
  const PRIORITY = { black: 1, checkered: 2, white: 3, yellow: 4, blue: 5, green: 6 };

  function activeFlagKeysFromBits(rawBits) {
    const keys = [];
    if ((rawBits & BIT_BLACK)     !== 0) keys.push('black');
    if ((rawBits & BIT_CHECKERED) !== 0) keys.push('checkered');
    if ((rawBits & BIT_WHITE)     !== 0) keys.push('white');
    if ((rawBits & BIT_YELLOW)    !== 0) keys.push('yellow');
    if ((rawBits & BIT_BLUE)      !== 0) keys.push('blue');
    if ((rawBits & BIT_GREEN)     !== 0) keys.push('green');
    return keys;
  }

  function highestPriority(keys) {
    if (keys.length === 0) return null;
    let best = keys[0];
    let bestP = PRIORITY[best];
    for (let i = 1; i < keys.length; i++) {
      const p = PRIORITY[keys[i]];
      if (p < bestP) { best = keys[i]; bestP = p; }
    }
    return best;
  }

  function tick(snapshot) {
    const tNow = snapshot.tNow;
    const rawBits = snapshot.rawBits | 0;

    const active = activeFlagKeysFromBits(rawBits);
    const hasBlue = active.indexOf('blue') !== -1;

    // Blue-flag throttle with dropout debounce. A single-tick absence at 10Hz
    // is not enough to conclude iRacing cleared blue — we wait BLUE_DROPOUT_GRACE_MS
    // of continuous absence before committing. Otherwise a brief SDK polling race
    // would trigger a 15-second blackout while blue is still being shown.
    if (state.blueWasPresented && !hasBlue) {
      if (state.blueAbsentSince === 0) state.blueAbsentSince = tNow;
      if (tNow - state.blueAbsentSince >= BLUE_DROPOUT_GRACE_MS) {
        // Confirmed clear — cooldown window starts from when the absence began,
        // so the 15-second suppression measures real elapsed time.
        state.blueCooldownUntil = state.blueAbsentSince + BLUE_COOLDOWN_MS;
        state.blueWasPresented = false;
        state.blueAbsentSince = 0;
      }
    } else if (hasBlue) {
      // Blue is present — clear any pending absence tracking and, if we're
      // past the cooldown window, start tracking a new presentation.
      state.blueAbsentSince = 0;
      if (!state.blueWasPresented && tNow >= state.blueCooldownUntil) {
        state.blueWasPresented = true;
      }
    }

    const inCooldown = tNow < state.blueCooldownUntil;
    const filtered = (inCooldown && hasBlue)
      ? active.filter((k) => k !== 'blue')
      : active;

    const candidate = highestPriority(filtered);

    if (candidate !== null && candidate !== state.displayed) {
      // Minimum-dwell floor: respect the 3-second display time before switching
      // to a LOWER-priority flag. Higher-priority flags (e.g. black over yellow)
      // override the dwell because they're urgent.
      const candP = PRIORITY[candidate];
      const dispP = state.displayed !== null ? PRIORITY[state.displayed] : Infinity;
      const dwellExpired = state.displayed === null
        || (tNow - state.displayedSince >= MIN_DWELL_MS);
      if (candP < dispP || dwellExpired) {
        state.displayed = candidate;
        state.displayedSince = tNow;
      }
    } else if (candidate === null && state.displayed !== null) {
      if (tNow - state.displayedSince >= MIN_DWELL_MS) {
        state.displayed = null;
        state.displayedSince = 0;
      }
    }

    state.lastRawBits = rawBits;
  }

  function getState() {
    return {
      activeFlag: state.displayed,
      since: state.displayed !== null ? state.displayedSince : null,
      rawBits: state.lastRawBits,
    };
  }

  init();

  return { init, tick, getState, reset };
}

module.exports = { createFlagState };
