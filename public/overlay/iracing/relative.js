'use strict';
const root = document.getElementById('overlay-root');
const carsAhead = parseInt(getSetting('carsAhead', '5'));
const carsBehind = parseInt(getSetting('carsBehind', '5'));

root.innerHTML = `
<div class="overlay-panel" style="width:${getSetting('width', '300')}px;">
  <div class="overlay-header">
    <span>RELATIVE</span>
    <span id="connection-status"><span class="status-dot waiting"></span> Connecting</span>
  </div>
  <div class="overlay-body" id="relative-body"></div>
</div>`;

const prevGaps = {};

onData('relative', data => {
  const body = document.getElementById('relative-body');
  if (!data || !data.length) return;

  // data: array of { carIdx, position, carNumber, driverName, classColor, gap, lapsDown, lapping, isPlayer, inPit }
  // gap is relative time in seconds (negative = ahead, positive = behind)
  const playerIdx = data.findIndex(d => d.isPlayer);
  if (playerIdx < 0) return;

  const ahead = data.slice(Math.max(0, playerIdx - carsAhead), playerIdx);
  const player = data[playerIdx];
  const behind = data.slice(playerIdx + 1, playerIdx + 1 + carsBehind);
  const rows = [...ahead, player, ...behind];

  body.innerHTML = rows.map(d => {
    const isPlayer = d.isPlayer;
    let gapClass = 'relative-gap';
    let gapText = '--';

    if (isPlayer) {
      gapText = '—';
      gapClass += ' player-gap';
    } else {
      const prev = prevGaps[d.carIdx];
      const curr = d.gap;
      if (curr !== undefined && curr !== null) {
        const sign = curr < 0 ? '-' : '+';
        gapText = sign + Math.abs(curr).toFixed(1) + 's';
        if (prev !== undefined) {
          const closing = Math.abs(curr) < Math.abs(prev);
          gapClass += curr < 0
            ? (closing ? ' closing' : ' separating')  // car ahead: closing gap = good
            : (closing ? ' closing' : ' separating'); // car behind
        }
      }
      prevGaps[d.carIdx] = curr;
    }

    let rowClass = 'relative-row';
    if (isPlayer) rowClass += ' player';
    if (d.lapsDown) rowClass += ' lapped';
    if (d.lapping) rowClass += ' lapping';

    return `<div class="${rowClass}">
      <span class="relative-pos">${d.position || ''}</span>
      <span class="relative-car" style="color:${d.classColor || '#fff'}">${d.carNumber || ''}</span>
      <span class="relative-name">${d.driverName || ''}</span>
      ${d.inPit ? '<span class="pit-indicator" style="font-size:9px;margin-right:2px">PIT</span>' : ''}
      <span class="${gapClass}">${gapText}</span>
    </div>`;
  }).join('');
});

connectBridge(['relative']);
