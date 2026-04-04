'use strict';
const root = document.getElementById('overlay-root');
const maxRows = parseInt(getSetting('maxRows', '15'));

root.innerHTML = `
<div class="overlay-panel" style="width:${getSetting('width','340')}px;">
  <div class="overlay-header">
    <span>STANDINGS</span>
    <span id="connection-status"><span class="status-dot waiting"></span> Connecting</span>
  </div>
  <div class="overlay-body">
    <table class="overlay-table">
      <thead><tr><th>P</th><th>#</th><th>Driver</th><th>Int</th><th>Last</th><th>Best</th><th></th></tr></thead>
      <tbody id="standings-body"></tbody>
    </table>
  </div>
</div>`;

let playerCarIdx = -1;
onData('session', d => { if (d.playerCarIdx !== undefined) playerCarIdx = d.playerCarIdx; });

onData('standings', data => {
  const tbody = document.getElementById('standings-body');
  if (!data || !data.length) return;
  const playerPos = data.findIndex(d => d.carIdx === playerCarIdx);
  let startIdx = 0;
  if (data.length > maxRows && playerPos >= 0)
    startIdx = Math.max(0, Math.min(playerPos - Math.floor(maxRows / 2), data.length - maxRows));
  const visible = data.slice(startIdx, startIdx + maxRows);
  tbody.innerHTML = visible.map(d => {
    const isPlayer = d.carIdx === playerCarIdx;
    return `<tr class="${isPlayer ? 'player-row' : ''} ${!d.onLeadLap ? 'lapped' : ''}">
      <td class="mono" style="font-weight:700">${d.position}</td>
      <td style="color:${d.classColor || '#fff'};font-weight:600">${d.carNumber || ''}</td>
      <td>${d.driverName || ''}</td>
      <td class="mono" style="font-size:11px">${d.interval || ''}</td>
      <td class="mono" style="font-size:11px">${d.lastLap || ''}</td>
      <td class="mono" style="font-size:11px">${d.bestLap || ''}</td>
      <td>${d.inPit ? '<span class="pit-indicator">PIT</span>' : ''}</td>
    </tr>`;
  }).join('');
});

connectBridge(['session', 'standings']);
