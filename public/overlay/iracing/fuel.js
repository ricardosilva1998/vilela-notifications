'use strict';
const root = document.getElementById('overlay-root');
root.innerHTML = `
<div class="overlay-panel" style="width:${getSetting('width', '240')}px;">
  <div class="overlay-header">
    <span>FUEL</span>
    <span id="connection-status"><span class="status-dot waiting"></span></span>
  </div>
  <div class="overlay-body" style="padding:8px 12px;">
    <div class="fuel-grid" id="fuel-grid">
      <div class="fuel-item">
        <div class="fuel-label">Fuel</div>
        <div class="fuel-val" id="f-level">--</div>
        <div class="fuel-bar-wrap"><div class="fuel-bar" id="f-bar" style="width:0%"></div></div>
      </div>
      <div class="fuel-item">
        <div class="fuel-label">Avg/Lap</div>
        <div class="fuel-val" id="f-avg">--</div>
      </div>
      <div class="fuel-item">
        <div class="fuel-label">Laps Left</div>
        <div class="fuel-val" id="f-laps-fuel">--</div>
      </div>
      <div class="fuel-item">
        <div class="fuel-label">Race Laps</div>
        <div class="fuel-val" id="f-laps-race">--</div>
      </div>
      <div class="fuel-item">
        <div class="fuel-label">To Finish</div>
        <div class="fuel-val" id="f-needed">--</div>
      </div>
      <div class="fuel-item">
        <div class="fuel-label">Add on Pit</div>
        <div class="fuel-val" id="f-add">--</div>
      </div>
    </div>
  </div>
</div>`;

onData('fuel', d => {
  const unit = getSetting('unit', 'L');

  // Fuel level
  document.getElementById('f-level').textContent = d.fuelLevel.toFixed(1) + unit;

  // Fuel bar (relative to tank capacity)
  const bar = document.getElementById('f-bar');
  if (d.fuelCapacity && d.fuelCapacity > 0) {
    const pct = Math.min(100, (d.fuelLevel / d.fuelCapacity) * 100);
    bar.style.width = pct + '%';
    bar.style.background = pct > 30 ? '#3ecf8e' : pct > 10 ? '#f79009' : '#f04438';
  }

  // Avg per lap
  document.getElementById('f-avg').textContent = d.fuelPerLap ? d.fuelPerLap.toFixed(2) + unit : '--';

  // Laps of fuel remaining
  const lapsOfFuel = d.fuelPerLap && d.fuelPerLap > 0 ? (d.fuelLevel / d.fuelPerLap) : 0;
  const lapsEl = document.getElementById('f-laps-fuel');
  lapsEl.textContent = d.fuelPerLap ? lapsOfFuel.toFixed(1) : '--';
  lapsEl.className = 'fuel-val ' + (lapsOfFuel > 3 ? 'text-success' : lapsOfFuel > 1 ? 'text-warning' : 'text-danger');

  // Race laps remaining
  document.getElementById('f-laps-race').textContent = d.lapsRemaining !== undefined ? d.lapsRemaining : '--';

  // Fuel needed to finish
  document.getElementById('f-needed').textContent = d.fuelToFinish ? d.fuelToFinish.toFixed(1) + unit : '--';

  // Fuel to add at next pit stop
  const add = d.fuelToAdd !== undefined ? Math.max(0, d.fuelToAdd).toFixed(1) : '0.0';
  const addEl = document.getElementById('f-add');
  addEl.textContent = add + unit;
  addEl.className = 'fuel-val ' + (parseFloat(add) > 0 ? 'text-warning' : 'text-success');
});

connectBridge(['session', 'fuel']);
