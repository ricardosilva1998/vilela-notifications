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
      blueCooldownUntil: 0,     // tNow after which blue is allowed to re-trigger
    };
  }

  function reset() {
    init();
  }

  const MIN_DWELL_MS = 3000;
  const BLUE_COOLDOWN_MS = 15000;

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

    // Blue-flag throttle. Edge-triggered cooldown start when blue clears
    // (blueWasPresented: true → false).
    const hasBlue = active.indexOf('blue') !== -1;
    if (state.blueWasPresented && !hasBlue) {
      state.blueCooldownUntil = tNow + BLUE_COOLDOWN_MS;
    }
    const inCooldown = tNow < state.blueCooldownUntil;
    const filtered = (inCooldown && hasBlue)
      ? active.filter((k) => k !== 'blue')
      : active;
    const blueShownThisTick = filtered.indexOf('blue') !== -1;

    const candidate = highestPriority(filtered);

    if (candidate !== null && candidate !== state.displayed) {
      state.displayed = candidate;
      state.displayedSince = tNow;
    } else if (candidate === null && state.displayed !== null) {
      if (tNow - state.displayedSince >= MIN_DWELL_MS) {
        state.displayed = null;
        state.displayedSince = 0;
      }
    }

    state.blueWasPresented = blueShownThisTick;
    state.lastRawBits = rawBits;
  }

  function getState() {
    return {
      activeFlag: state.displayed,
      since: state.displayed ? state.displayedSince : null,
      rawBits: state.lastRawBits,
    };
  }

  init();

  return { init, tick, getState, reset };
}

module.exports = { createFlagState };
