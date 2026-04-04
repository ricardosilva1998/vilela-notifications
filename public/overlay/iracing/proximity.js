'use strict';
const root = document.getElementById('overlay-root');
const size = parseInt(getSetting('size', '140'));

root.innerHTML = `
<div class="overlay-panel proximity-panel" style="width:${size}px;padding:12px;display:flex;align-items:center;justify-content:center;">
  <svg width="${size - 24}" height="${(size - 24) * 1.8}" viewBox="0 0 80 140">
    <!-- Left indicator -->
    <rect id="prox-left" x="0" y="20" width="15" height="100" rx="4" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
    <!-- Car body -->
    <rect x="20" y="10" width="40" height="120" rx="8" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
    <!-- Windscreen -->
    <rect x="25" y="5" width="30" height="20" rx="6" fill="rgba(255,255,255,0.05)"/>
    <!-- Rear bumper -->
    <rect x="25" y="115" width="30" height="20" rx="6" fill="rgba(255,255,255,0.05)"/>
    <!-- Front wheels -->
    <rect x="17" y="22" width="6" height="16" rx="3" fill="rgba(255,255,255,0.12)"/>
    <rect x="57" y="22" width="6" height="16" rx="3" fill="rgba(255,255,255,0.12)"/>
    <!-- Rear wheels -->
    <rect x="17" y="102" width="6" height="16" rx="3" fill="rgba(255,255,255,0.12)"/>
    <rect x="57" y="102" width="6" height="16" rx="3" fill="rgba(255,255,255,0.12)"/>
    <!-- Right indicator -->
    <rect id="prox-right" x="65" y="20" width="15" height="100" rx="4" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
    <!-- Direction arrow -->
    <polygon points="40,25 35,40 45,40" fill="rgba(255,255,255,0.2)"/>
  </svg>
  <div id="connection-status" style="position:absolute;bottom:4px;font-size:8px;"></div>
</div>`;

onData('proximity', d => {
  const left = document.getElementById('prox-left');
  const right = document.getElementById('prox-right');

  // carLeftRight: 0=clear, 1=car left, 2=car right, 3=both sides
  const hasLeft = d.carLeftRight === 1 || d.carLeftRight === 3;
  const hasRight = d.carLeftRight === 2 || d.carLeftRight === 3;

  left.setAttribute('fill', hasLeft ? 'rgba(247,144,9,0.6)' : 'rgba(255,255,255,0.05)');
  left.setAttribute('stroke', hasLeft ? '#f79009' : 'rgba(255,255,255,0.1)');
  right.setAttribute('fill', hasRight ? 'rgba(247,144,9,0.6)' : 'rgba(255,255,255,0.05)');
  right.setAttribute('stroke', hasRight ? '#f79009' : 'rgba(255,255,255,0.1)');
});

connectBridge(['proximity']);
