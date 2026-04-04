'use strict';
const root = document.getElementById('overlay-root');
const size = parseInt(getSetting('size', '120'));

root.innerHTML = `
<div class="overlay-panel wind-panel" style="width:${size}px;height:${size}px;border-radius:50%;display:flex;align-items:center;justify-content:center;position:relative;">
  <svg id="wind-compass" width="${size}" height="${size}" viewBox="0 0 120 120">
    <circle cx="60" cy="60" r="56" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
    <text x="60" y="16" text-anchor="middle" fill="rgba(255,255,255,0.3)" font-size="9" font-family="Outfit" font-weight="700">N</text>
    <text x="60" y="112" text-anchor="middle" fill="rgba(255,255,255,0.3)" font-size="9" font-family="Outfit" font-weight="700">S</text>
    <text x="10" y="63" text-anchor="middle" fill="rgba(255,255,255,0.3)" font-size="9" font-family="Outfit" font-weight="700">W</text>
    <text x="110" y="63" text-anchor="middle" fill="rgba(255,255,255,0.3)" font-size="9" font-family="Outfit" font-weight="700">E</text>
    <g id="wind-arrow" transform="rotate(0,60,60)">
      <polygon points="60,18 54,45 60,40 66,45" fill="#8888cc" opacity="0.9"/>
      <line x1="60" y1="40" x2="60" y2="85" stroke="#8888cc" stroke-width="2" opacity="0.5"/>
    </g>
    <text id="wind-speed" x="60" y="65" text-anchor="middle" fill="#fff" font-size="14" font-family="JetBrains Mono" font-weight="700">--</text>
    <text id="wind-unit" x="60" y="78" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="8" font-family="Outfit" font-weight="600">km/h</text>
  </svg>
  <div id="connection-status" style="position:absolute;bottom:4px;left:50%;transform:translateX(-50%);font-size:8px;"></div>
</div>`;

onData('wind', d => {
  const arrow = document.getElementById('wind-arrow');
  const speedEl = document.getElementById('wind-speed');
  const panel = document.querySelector('.wind-panel');

  // Wind direction relative to car heading
  const relAngle = ((d.windDirection - (d.carHeading || 0)) + 360) % 360;
  arrow.setAttribute('transform', `rotate(${relAngle},60,60)`);

  // Speed — convert m/s to km/h
  const speedKmh = ((d.windSpeed || 0) * 3.6).toFixed(0);
  speedEl.textContent = speedKmh;

  // Background tint: headwind (front ±45°) = red, tailwind (back ±45°) = green, crosswind = yellow
  if (relAngle < 45 || relAngle > 315) {
    panel.style.background = 'rgba(240,68,56,0.1)';   // headwind
    arrow.querySelector('polygon').setAttribute('fill', '#f04438');
  } else if (relAngle > 135 && relAngle < 225) {
    panel.style.background = 'rgba(62,207,142,0.1)';  // tailwind
    arrow.querySelector('polygon').setAttribute('fill', '#3ecf8e');
  } else {
    panel.style.background = 'rgba(247,144,9,0.08)';  // crosswind
    arrow.querySelector('polygon').setAttribute('fill', '#f79009');
  }
});

connectBridge(['wind']);
