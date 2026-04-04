'use strict';

class RelativeCalculator {
  constructor() {
    this.playerCarIdx = 0;
  }

  calculate(telemetry, playerCarIdx) {
    this.playerCarIdx = playerCarIdx;
    // Relative calculation requires CarIdxEstTime telemetry
    // This will be implemented when testing with actual iRacing data
    return [];
  }
}

module.exports = RelativeCalculator;
