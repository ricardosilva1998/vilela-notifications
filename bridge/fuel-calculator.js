'use strict';

class FuelCalculator {
  constructor() {
    this.reset();
  }

  reset() {
    this.lastLapFuel = null;
    this.fuelPerLap = [];
    this.currentLap = 0;
    this.fuelAtLapStart = null;
  }

  update(telemetry) {
    const lap = telemetry.Lap || 0;
    const fuel = telemetry.FuelLevel || 0;

    // Detect new lap
    if (lap > this.currentLap && this.currentLap > 0) {
      if (this.fuelAtLapStart !== null) {
        const used = this.fuelAtLapStart - fuel;
        if (used > 0) {
          this.fuelPerLap.push(used);
          if (this.fuelPerLap.length > 5) this.fuelPerLap.shift(); // rolling avg of 5
        }
      }
      this.fuelAtLapStart = fuel;
    }

    if (this.currentLap === 0 || this.fuelAtLapStart === null) {
      this.fuelAtLapStart = fuel;
    }

    this.currentLap = lap;
    this.lastFuel = fuel;
    this.lapsRemaining = telemetry.SessionLapsRemainEx || telemetry.SessionLapsRemain || 0;
  }

  getData() {
    const avgPerLap = this.fuelPerLap.length > 0
      ? this.fuelPerLap.reduce((a, b) => a + b, 0) / this.fuelPerLap.length
      : 0;
    const lapsOfFuel = avgPerLap > 0 ? this.lastFuel / avgPerLap : 0;
    const fuelToFinish = avgPerLap > 0 ? this.lapsRemaining * avgPerLap : 0;
    const fuelToAdd = Math.max(0, fuelToFinish - (this.lastFuel || 0));

    return {
      fuelLevel: this.lastFuel || 0,
      fuelPerLap: avgPerLap,
      lapsOfFuel,
      lapsRemaining: this.lapsRemaining,
      fuelToFinish,
      fuelToAdd,
    };
  }
}

module.exports = FuelCalculator;
