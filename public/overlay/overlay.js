console.log('[Overlay] Script loaded, OVERLAY_TOKEN:', window.OVERLAY_TOKEN ? 'present' : 'MISSING');

const container = document.getElementById('notification-container');
let overlayConfig = {};
let overlayDesigns = {};
let serverVersion = null;
const queue = [];
let isPlaying = false;

// Synthesized notification sounds using Web Audio API
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// Racing-themed sound synthesis
function createNoise(duration, vol) {
  const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate * duration, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1);
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  const gain = audioCtx.createGain();
  gain.gain.value = vol;
  source.connect(gain);
  return { source, gain };
}

function engineRev(startFreq, endFreq, duration, vol) {
  const masterVol = (overlayConfig.volume || 0.8) * vol;
  const t = audioCtx.currentTime;

  // Engine oscillator (sawtooth for gritty engine sound)
  const osc1 = audioCtx.createOscillator();
  osc1.type = 'sawtooth';
  osc1.frequency.setValueAtTime(startFreq, t);
  osc1.frequency.exponentialRampToValueAtTime(endFreq, t + duration * 0.7);
  osc1.frequency.exponentialRampToValueAtTime(endFreq * 0.8, t + duration);

  // Sub-harmonic for rumble
  const osc2 = audioCtx.createOscillator();
  osc2.type = 'sawtooth';
  osc2.frequency.setValueAtTime(startFreq / 2, t);
  osc2.frequency.exponentialRampToValueAtTime(endFreq / 2, t + duration * 0.7);
  osc2.frequency.exponentialRampToValueAtTime(endFreq * 0.4, t + duration);

  // Distortion for engine grit
  const distortion = audioCtx.createWaveShaper();
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = (i * 2) / 256 - 1;
    curve[i] = (Math.PI + 3.4) * x / (Math.PI + 3.4 * Math.abs(x));
  }
  distortion.curve = curve;

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(masterVol, t);
  gain.gain.setValueAtTime(masterVol, t + duration * 0.8);
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

  osc1.connect(distortion);
  osc2.connect(distortion);
  distortion.connect(gain);
  gain.connect(audioCtx.destination);

  osc1.start(t); osc1.stop(t + duration);
  osc2.start(t); osc2.stop(t + duration);
}

function turboBlowoff(vol) {
  const masterVol = (overlayConfig.volume || 0.8) * vol;
  const t = audioCtx.currentTime;

  // Turbo spool (rising whine)
  const spool = audioCtx.createOscillator();
  spool.type = 'sine';
  spool.frequency.setValueAtTime(2000, t);
  spool.frequency.exponentialRampToValueAtTime(6000, t + 0.3);

  const spoolGain = audioCtx.createGain();
  spoolGain.gain.setValueAtTime(masterVol * 0.3, t);
  spoolGain.gain.setValueAtTime(masterVol * 0.3, t + 0.25);
  spoolGain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);

  spool.connect(spoolGain);
  spoolGain.connect(audioCtx.destination);
  spool.start(t); spool.stop(t + 0.35);

  // Blow-off valve (filtered noise burst)
  const { source: noise, gain: noiseGain } = createNoise(0.25, masterVol * 0.4);
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(4000, t + 0.3);
  filter.frequency.exponentialRampToValueAtTime(800, t + 0.55);
  filter.Q.value = 2;

  noiseGain.disconnect();
  noise.connect(noiseGain);
  noiseGain.connect(filter);

  const noiseEnv = audioCtx.createGain();
  noiseEnv.gain.setValueAtTime(masterVol * 0.5, t + 0.3);
  noiseEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
  filter.connect(noiseEnv);
  noiseEnv.connect(audioCtx.destination);

  noise.start(t + 0.3); noise.stop(t + 0.55);
}

function tireScreech(vol) {
  const masterVol = (overlayConfig.volume || 0.8) * vol;
  const t = audioCtx.currentTime;
  const { source: noise, gain: noiseGain } = createNoise(0.3, masterVol * 0.3);
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.setValueAtTime(3000, t);
  filter.frequency.exponentialRampToValueAtTime(6000, t + 0.15);
  filter.frequency.exponentialRampToValueAtTime(2000, t + 0.3);
  filter.Q.value = 8;

  noiseGain.disconnect();
  noise.connect(noiseGain);
  noiseGain.connect(filter);

  const env = audioCtx.createGain();
  env.gain.setValueAtTime(masterVol * 0.35, t);
  env.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  filter.connect(env);
  env.connect(audioCtx.destination);

  noise.start(t); noise.stop(t + 0.3);
}

const soundEffects = {
  // Follow: tire screech + short engine rev
  follow: () => {
    tireScreech(0.3);
    setTimeout(() => engineRev(80, 200, 0.4, 0.2), 200);
  },
  // Subscription: turbo spool + blow-off valve + engine rev
  subscription: () => {
    engineRev(60, 180, 0.6, 0.15);
    turboBlowoff(0.25);
  },
  // Bits: rapid engine revs (nitro boost)
  bits: () => {
    engineRev(100, 400, 0.15, 0.2);
    setTimeout(() => engineRev(200, 600, 0.15, 0.25), 120);
    setTimeout(() => engineRev(300, 800, 0.2, 0.3), 240);
  },
  // Donation: engine start + rev up
  donation: () => {
    engineRev(40, 60, 0.3, 0.15);
    setTimeout(() => engineRev(60, 300, 0.5, 0.25), 250);
  },
  // Raid: multiple engines approaching
  raid: () => {
    engineRev(50, 150, 0.6, 0.12);
    setTimeout(() => engineRev(60, 180, 0.5, 0.15), 100);
    setTimeout(() => engineRev(70, 200, 0.5, 0.18), 200);
    setTimeout(() => tireScreech(0.2), 500);
  },
  // YouTube Super Chat: engine rev + turbo
  yt_superchat: () => {
    engineRev(80, 250, 0.5, 0.2);
    setTimeout(() => turboBlowoff(0.2), 300);
  },
  // YouTube Member: smooth engine purr + rev
  yt_member: () => {
    engineRev(50, 150, 0.6, 0.15);
  },
  // YouTube Gift: double rev burst
  yt_giftmember: () => {
    engineRev(80, 300, 0.3, 0.2);
    setTimeout(() => engineRev(100, 400, 0.3, 0.25), 250);
  },
};

// Connect to SSE with robust reconnection for OBS browser source
let evtSource = null;
let reconnectTimer = null;

function connectSSE() {
  if (evtSource) {
    evtSource.close();
    evtSource = null;
  }

  const sseUrl = `/overlay/events/${window.OVERLAY_TOKEN}`;
  console.log('[Overlay] Connecting SSE to:', sseUrl);
  evtSource = new EventSource(sseUrl);

  evtSource.onopen = () => {
    console.log('[Overlay] SSE connection established');
  };

  evtSource.onmessage = (e) => {
    console.log('[Overlay] SSE message received:', e.data.substring(0, 100));
    const data = JSON.parse(e.data);

    if (data.type === 'config') {
      // If server restarted (deploy), reload to get fresh JS/CSS
      if (serverVersion && data.serverVersion && data.serverVersion !== serverVersion) {
        console.log('Server restarted, reloading overlay...');
        location.reload();
        return;
      }
      serverVersion = data.serverVersion;
      overlayConfig = data.config;
      if (data.designs) overlayDesigns = data.designs;
      return;
    }

    if (data.type === 'timed') {
      console.log('[Overlay] Timed notification received:', data.data);
      showTimedNotification(data.data);
      return;
    }

    // Sponsor events handled by separate /overlay/sponsors/:token page
    if (data.type === 'sponsor') return;

    // Check if event type is enabled
    const eventType = data.type;
    const typeConfig = overlayConfig[eventType];
    if (typeConfig && !typeConfig.enabled) return;

    queue.push(data);
    if (!isPlaying) playNext();
  };

  evtSource.onerror = () => {
    console.log('SSE connection lost, will retry...');
    evtSource.close();
    evtSource = null;
    // Retry after 5s — handles deploy downtime
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectSSE();
      }, 5000);
    }
  };
}

connectSSE();

function playNext() {
  if (queue.length === 0) { isPlaying = false; return; }
  isPlaying = true;
  const event = queue.shift();
  showNotification(event);
}

// ─── Card class mapping ────────────────────────────────────────
function getCardClass(type) {
  const map = {
    follow:        'follow-card',
    subscription:  'sub-card',
    bits:          'bits-card',
    donation:      'donation-card',
    raid:          'raid-card',
    yt_superchat:  'yt-superchat-card',
    yt_member:     'yt-member-card',
    yt_giftmember: 'yt-giftmember-card',
    timed:         'timed-card',
  };
  return map[type] || 'follow-card';
}

// ─── Show notification ─────────────────────────────────────────
function showNotification(event) {
  const typeConfig = overlayConfig[event.type] || {};
  const duration = (typeConfig.duration || 5) * 1000;

  // Play notification sound — try custom mp3 first, fall back to synthesized
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const soundUrl = `/overlay/sounds/${event.type}.mp3`;
  const audio = new Audio(soundUrl);
  audio.volume = overlayConfig.volume || 0.8;
  audio.play().then(() => {
    // Custom sound played successfully
  }).catch(() => {
    // No custom sound file, use synthesized
    const playSound = soundEffects[event.type];
    if (playSound) playSound();
  });

  // Build card
  const cardClass = getCardClass(event.type);
  const isSubLike = event.type === 'subscription' || event.type === 'yt_member';
  const card = document.createElement('div');
  card.className = `alert-card ${cardClass}${isSubLike ? ' sub-shake' : ''} entering`;
  card.innerHTML = buildBannerContent(event);
  container.appendChild(card);

  // Apply custom overlay design if available
  applyCustomDesign(card, event.type);

  // Spawn full-screen effects
  spawnEffects(event.type);

  // Dismiss after duration
  setTimeout(() => {
    // Clean up screen effects
    document.querySelectorAll('.screen-effect').forEach(e => {
      e.style.animation = 'none';
      e.style.opacity = '0';
      setTimeout(() => e.remove(), 100);
    });

    if (card._customPosition) {
      // Custom-positioned cards use fade out (no CSS animation)
      card.style.transition = 'opacity 0.3s ease-in';
      card.style.opacity = '0';
      setTimeout(() => { card.remove(); setTimeout(playNext, 500); }, 350);
    } else {
      card.classList.remove('entering');
      card.classList.add('dismissing');
      card.addEventListener('animationend', () => {
        card.remove();
        setTimeout(playNext, 500);
      }, { once: true });
    }
  }, duration);
}

// ─── Build card HTML per event type ───────────────────────────
function buildBannerContent(event) {
  switch (event.type) {
    case 'follow':
      return `<div class="top-accent"></div>
        <div class="card-body">
          <div class="event-label">New Pit Crew Member</div>
          <div class="username">${esc(event.data.username)}</div>
          <div class="detail">just joined the race 🏁</div>
        </div>
        <div class="car-track">
          <div class="race-line"></div>
          <div class="speed-dot fsd1"></div>
          <div class="speed-dot fsd2"></div>
          <div class="speed-dot fsd3"></div>
          <div class="track-car">🏎️</div>
        </div>`;

    case 'subscription': {
      const d = event.data;
      const detail = d.months && d.months > 1
        ? `Subscribed for <b>${d.months} months</b> — Tier ${d.tier || '1'} 🥇`
        : d.message ? esc(d.message) : `Tier ${d.tier || '1'} subscriber! 🥇`;
      return `<div class="top-accent"></div>
        <div class="card-body">
          <div class="cup-row">
            <span class="cup">🏆</span>
            <div class="card-inner">
              <div class="event-label">Podium Finish</div>
              <div class="username">${esc(d.username)}</div>
              <div class="detail">${detail}</div>
            </div>
            <span class="cup">🏆</span>
          </div>
        </div>`;
    }

    case 'bits':
      return `<div class="top-accent"></div>
        <div class="card-body">
          <div class="event-label">Nitro Boost</div>
          <div class="username">${esc(event.data.username)}</div>
          <div class="detail">fueled up <b>${event.data.amount} bits</b> of nitro! 🔥</div>
        </div>
        <div class="car-track">
          <div class="race-line"></div>
          <div class="track-car">🏎️</div>
        </div>`;

    case 'donation':
      return `<div class="top-accent"></div>
        <div class="card-body">
          <div class="event-label">Sponsor Alert</div>
          <div class="username">${esc(event.data.username)}</div>
          <div class="detail">sponsored the team with <b>$${event.data.amount}</b> 💸</div>
        </div>
        <div class="car-track">
          <div class="race-line"></div>
          <div class="speed-dot dsd1"></div>
          <div class="speed-dot dsd2"></div>
          <div class="speed-dot dsd3"></div>
          <div class="track-car donation-car">🏎️</div>
        </div>`;

    case 'raid': {
      const viewers = event.data.viewers || '??';
      const row1 = '<span class="person">👤</span><span class="person">🧑</span><span class="person">👨</span><span class="person">👩</span><span class="person">🧔</span><span class="person">👱</span><span class="person">🧑</span><span class="person">👤</span><span class="person">👨</span><span class="person">👩</span><span class="person">🧔</span><span class="person">👱</span><span class="person">🧑</span><span class="person">👤</span>';
      const row2 = '<span class="person">🧑</span><span class="person">👤</span><span class="person">👩</span><span class="person">🧔</span><span class="person">👨</span><span class="person">👱</span><span class="person">👤</span><span class="person">🧑</span><span class="person">👩</span><span class="person">👨</span><span class="person">🧔</span><span class="person">👱</span>';
      const row3 = '<span class="person">👤</span><span class="person">👨</span><span class="person">🧑</span><span class="person">👩</span><span class="person">👱</span><span class="person">🧔</span><span class="person">👤</span><span class="person">👨</span><span class="person">🧑</span><span class="person">👩</span>';
      return `<div class="top-accent"></div>
        <div class="card-body">
          <div class="event-label">Incoming Raid</div>
          <div class="username">${esc(event.data.username)}</div>
          <div class="detail">raiding with <b>${viewers} viewers</b>! 🏁</div>
        </div>
        <div class="crowd-section">
          <div class="crowd-row">${row1}</div>
          <div class="crowd-row">${row2}</div>
          <div class="crowd-row">${row3}</div>
          <div class="viewer-count">${viewers} VIEWERS INCOMING</div>
        </div>`;
    }

    case 'yt_superchat':
      return `<div class="top-accent"></div>
        <div class="card-body">
          <div class="event-label">Super Chat</div>
          <div class="username">${esc(event.data.username)}</div>
          <div class="detail">sent <b>${esc(event.data.amount)}</b>${event.data.message ? ' — ' + esc(event.data.message) : ''} 🔥</div>
        </div>
        <div class="car-track">
          <div class="race-line"></div>
          <div class="track-car">🏎️</div>
        </div>`;

    case 'yt_member': {
      const d = event.data;
      return `<div class="top-accent"></div>
        <div class="card-body">
          <div class="cup-row">
            <span class="cup">⭐</span>
            <div class="card-inner">
              <div class="event-label">New Member</div>
              <div class="username">${esc(d.username)}</div>
              <div class="detail">just became a <b>${esc(d.level || 'member')}</b>! 🥇</div>
            </div>
            <span class="cup">⭐</span>
          </div>
        </div>`;
    }

    case 'yt_giftmember':
      return `<div class="top-accent"></div>
        <div class="card-body">
          <div class="event-label">Gift Alert</div>
          <div class="username">${esc(event.data.username)}</div>
          <div class="detail">gifted <b>${event.data.amount} memberships</b>! 🎁</div>
        </div>
        <div class="car-track">
          <div class="race-line"></div>
          <div class="track-car">🏎️</div>
        </div>`;

    default: return '';
  }
}

// ─── Full-screen effects ───────────────────────────────────────
function spawnEffects(type) {
  // Remove any lingering effects from previous notification
  document.querySelectorAll('.screen-effect').forEach(e => e.remove());

  switch (type) {
    case 'follow':                         spawnTireMarks();           break;
    case 'subscription': case 'yt_member': spawnConfettiAndFlashes();  break;
    case 'bits':         case 'yt_superchat': spawnGoldRain();         break;
    case 'donation':     case 'yt_giftmember': spawnMoneyRain();       break;
    case 'raid':                           spawnRobots();              break;
  }
}

function spawnTireMarks() {
  // Two tire-mark streaks across the middle
  ['tire-mark-1', 'tire-mark-2'].forEach(cls => {
    const el = document.createElement('div');
    el.className = `screen-effect tire-mark ${cls}`;
    container.appendChild(el);
  });

  // 12 sparks scattered around the mid-screen area
  for (let i = 0; i < 12; i++) {
    const sp = document.createElement('div');
    sp.className = 'screen-effect tire-spark';
    const x = Math.random() * 100;
    const y = 35 + Math.random() * 20;
    sp.style.left = `${x}vw`;
    sp.style.top  = `${y}vh`;
    const angle = Math.random() * 360;
    const dist  = 20 + Math.random() * 60;
    const sx = Math.cos(angle * Math.PI / 180) * dist;
    const sy = Math.sin(angle * Math.PI / 180) * dist;
    sp.style.setProperty('--sx', `${sx}px`);
    sp.style.setProperty('--sy', `${sy}px`);
    sp.style.animationDelay    = `${Math.random() * 0.4}s`;
    sp.style.animationDuration = `${0.5 + Math.random() * 0.4}s`;
    container.appendChild(sp);
  }
}

function spawnConfettiAndFlashes() {
  const colors = ['#ff4444','#00ff88','#f7c948','#4285f4','#ff88cc','#ffffff','#bf00ff','#00ccff'];

  // 60 confetti pieces
  for (let i = 0; i < 60; i++) {
    const el = document.createElement('div');
    el.className = 'screen-effect confetti';
    el.style.left            = `${Math.random() * 100}vw`;
    el.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    el.style.width           = `${6 + Math.random() * 8}px`;
    el.style.height          = `${8 + Math.random() * 10}px`;
    el.style.animationDelay    = `${Math.random() * 1.5}s`;
    el.style.animationDuration = `${2 + Math.random() * 2}s`;
    container.appendChild(el);
  }

  // 5 camera flashes at random positions
  for (let i = 0; i < 5; i++) {
    const fl = document.createElement('div');
    fl.className = 'screen-effect cam-flash';
    fl.style.setProperty('--fx', `${15 + Math.random() * 70}%`);
    fl.style.setProperty('--fy', `${20 + Math.random() * 50}%`);
    fl.style.animationDelay = `${i * 0.5}s`;
    container.appendChild(fl);
  }
}

function spawnGoldRain() {
  const items = ['🪙','💎','⭐','🏆','✨','💰','🥇'];
  for (let i = 0; i < 35; i++) {
    const el = document.createElement('div');
    el.className   = 'screen-effect gold-item';
    el.textContent = items[Math.floor(Math.random() * items.length)];
    el.style.left            = `${Math.random() * 100}vw`;
    el.style.animationDelay    = `${Math.random() * 2}s`;
    el.style.animationDuration = `${1.5 + Math.random() * 2}s`;
    container.appendChild(el);
  }
}

function spawnMoneyRain() {
  const items = ['💵','💰','💲','🪙','💸','💎'];
  for (let i = 0; i < 30; i++) {
    const el = document.createElement('div');
    el.className   = 'screen-effect money-item';
    el.textContent = items[Math.floor(Math.random() * items.length)];
    el.style.left            = `${Math.random() * 100}vw`;
    el.style.animationDelay    = `${Math.random() * 2}s`;
    el.style.animationDuration = `${1.5 + Math.random() * 2}s`;
    container.appendChild(el);
  }
}

function spawnRobots() {
  // 30 falling robots
  for (let i = 0; i < 30; i++) {
    const el = document.createElement('div');
    el.className   = 'screen-effect robot';
    el.textContent = '🤖';
    el.style.left            = `${Math.random() * 100}vw`;
    el.style.animationDelay    = `${Math.random() * 2.5}s`;
    el.style.animationDuration = `${1.5 + Math.random() * 2}s`;
    container.appendChild(el);
  }

  // Red edge glow
  const glow = document.createElement('div');
  glow.className = 'screen-effect edge-glow';
  container.appendChild(glow);
}

// ─── Custom design application ─────────────────────────────────
function darken(hex, factor) {
  if (!factor) factor = 0.35;
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgb(${Math.round(r*factor)},${Math.round(g*factor)},${Math.round(b*factor)})`;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function applyCustomDesign(card, eventType) {
  const design = overlayDesigns[eventType];
  if (!design) return;

  // Background
  const dark = darken(design.bg_color);
  card.style.background = `linear-gradient(160deg, ${dark}, ${design.bg_color} 40%, ${dark})`;

  // Border & shadow
  card.style.borderColor = hexToRgba(design.border_color, 0.5);
  card.style.boxShadow = `0 8px 32px ${hexToRgba(design.border_color, 0.25)}, 0 4px 24px rgba(0,0,0,0.6)`;
  card.style.borderRadius = (design.border_radius || 16) + 'px';
  card.style.width = (design.card_width || 420) + 'px';

  // Position — use custom x/y if dragged, otherwise grid position
  card.style.position = 'absolute';
  if (design.card_custom_x != null && design.card_custom_y != null) {
    card.style.left = (design.card_custom_x * 100) + '%';
    card.style.top = (design.card_custom_y * 100) + '%';
    card.style.right = '';
    card.style.bottom = '';
    // Remove default CSS entering animation since it uses translateX(-50%)
    card.classList.remove('entering');
    card.style.opacity = '0';
    card.style.transform = 'none';
    // Fade in instead
    requestAnimationFrame(() => {
      card.style.transition = 'opacity 0.4s ease-out';
      card.style.opacity = '1';
    });
    // Override dismiss to use fade out
    card._customPosition = true;
  } else {
    const pos = design.card_position || 'top-center';
    const [vPos, hPos] = pos.split('-');
    if (vPos === 'top') { card.style.top = '16px'; card.style.bottom = ''; }
    else if (vPos === 'bot') { card.style.bottom = '16px'; card.style.top = ''; }
    else { card.style.top = '50%'; card.style.bottom = ''; }

    if (hPos === 'center' || !hPos) {
      card.style.left = '50%';
      card.style.right = '';
      card.style.transform = vPos === 'mid' ? 'translate(-50%,-50%)' : 'translateX(-50%)';
    } else if (hPos === 'left') {
      card.style.left = '16px';
      card.style.right = '';
      card.style.transform = vPos === 'mid' ? 'translateY(-50%)' : 'none';
    } else {
      card.style.right = '16px';
      card.style.left = '';
      card.style.transform = vPos === 'mid' ? 'translateY(-50%)' : 'none';
    }
  }

  // Top accent
  const accent = card.querySelector('.top-accent');
  if (accent) {
    const accentDark = darken(design.accent_color, 0.6);
    accent.style.background = `linear-gradient(90deg, ${accentDark}, ${design.accent_color}, ${accentDark})`;
    accent.style.borderRadius = (design.border_radius || 16) + 'px ' + (design.border_radius || 16) + 'px 0 0';
  }

  // Event label color & text
  const labelEl = card.querySelector('.event-label');
  if (labelEl) {
    labelEl.style.color = design.accent_color;
    if (design.event_label) labelEl.textContent = design.event_label;
  }

  // Detail text
  const detailEl = card.querySelector('.detail');
  if (detailEl && design.detail_text) {
    // Replace placeholder values in the template
    detailEl.innerHTML = design.detail_text;
  }

  // Font — apply to whole card so label/detail inherit it too
  if (design.font_family && design.font_family !== 'System Default') {
    card.style.fontFamily = design.font_family;
  }

  // Username color & size
  const usernameEl = card.querySelector('.username');
  if (usernameEl) {
    usernameEl.style.color = design.text_color || '#ffffff';
    if (design.username_size) usernameEl.style.fontSize = design.username_size + 'px';
  }

  // Car track accent
  const track = card.querySelector('.car-track');
  if (track) track.style.background = hexToRgba(design.accent_color, 0.06);
}

// ─── Utilities ─────────────────────────────────────────────────
function esc(text) {
  const d = document.createElement('div');
  d.textContent = text || '';
  return d.innerHTML;
}

// ─── Sponsor image banner ───────────────────────────────────────
function showSponsorImage(data) {
  console.log('[Overlay] showSponsorImage called:', data.name, 'duration:', data.displayDuration);
  // Remove any existing sponsor banners immediately (new one replaces old)
  document.querySelectorAll('.sponsor-banner').forEach(el => el.remove());

  const design = overlayDesigns['timed']; // Use timed design for position/size
  console.log('[Overlay] Timed design:', JSON.stringify(design ? { pos: design.card_position, cx: design.card_custom_x, cy: design.card_custom_y, w: design.card_width, anim: design.sponsor_animation } : 'NO DESIGN'));

  const banner = document.createElement('div');
  const sponsorAnim = (design && design.sponsor_animation) || 'fade';
  banner.className = 'sponsor-banner anim-' + sponsorAnim;

  // Apply width from design
  const bannerWidth = (design && design.card_width) ? design.card_width : 420;
  banner.style.width = bannerWidth + 'px';

  const img = document.createElement('img');
  img.src = data.imageUrl;
  img.alt = data.name || 'Sponsor';
  img.style.display = 'block';
  img.style.width = '100%';
  img.style.height = 'auto';
  const imgScale = data.imageScale != null ? data.imageScale : 1.0;
  if (imgScale < 1) {
    img.style.maxWidth = (imgScale * 100) + '%';
    img.style.margin = '0 auto'; // center scaled image
  }
  banner.appendChild(img);

  // Position — use custom x/y from drag if set, otherwise grid position
  if (design && design.card_custom_x != null && design.card_custom_y != null) {
    banner.style.left = (design.card_custom_x * 100) + '%';
    banner.style.top = (design.card_custom_y * 100) + '%';
  } else {
    const pos = design ? (design.card_position || 'bot-center') : 'bot-center';
    const [vPos, hPos] = pos.split('-');
    let transform = '';
    if (vPos === 'top') { banner.style.top = '16px'; banner.style.bottom = ''; }
    else if (vPos === 'bot') { banner.style.bottom = '16px'; banner.style.top = ''; }
    else { banner.style.top = '50%'; transform += 'translateY(-50%) '; }

    if (hPos === 'center' || !hPos) {
      banner.style.left = '50%';
      banner.style.right = '';
      transform += 'translateX(-50%)';
    } else if (hPos === 'left') {
      banner.style.left = '16px';
      banner.style.right = '';
    } else {
      banner.style.right = '16px';
      banner.style.left = '';
    }
    if (transform) banner.style.transform = transform.trim();
  }

  document.getElementById('timed-container').appendChild(banner);
  console.log('[Overlay] Banner appended. Style:', banner.style.cssText);
  console.log('[Overlay] Banner rect:', JSON.stringify(banner.getBoundingClientRect()));
  img.onload = () => {
    console.log('[Overlay] Image loaded:', img.naturalWidth, 'x', img.naturalHeight);
    console.log('[Overlay] Banner rect after load:', JSON.stringify(banner.getBoundingClientRect()));
  };
  img.onerror = () => console.error('[Overlay] Image FAILED to load:', data.imageUrl);

  // Auto-hide before next image arrives (fade out 2s before displayDuration)
  if (data.displayDuration) {
    const hideAfter = Math.max(2000, (data.displayDuration * 1000) - 2000);
    setTimeout(() => {
      banner.classList.add('dismissing');
      setTimeout(() => banner.remove(), 400);
    }, hideAfter);
  }
}

// ─── Timed notification banner ─────────────────────────────────
function showTimedNotification(data) {
  // Check for custom design from overlay builder
  const design = overlayDesigns['timed'];

  let timedContainer = document.getElementById('timed-container');
  if (!timedContainer) {
    timedContainer = document.createElement('div');
    timedContainer.id = 'timed-container';
    document.body.appendChild(timedContainer);
  }

  const banner = document.createElement('div');
  banner.className = 'timed-banner';

  // Apply design from builder if available, otherwise use notification colors
  const bgColor = design ? design.bg_color : (data.bgColor || '#1a1a2e');
  const textColor = design ? design.text_color : (data.textColor || '#ffffff');
  const accentColor = design ? design.accent_color : '#f79009';
  const borderRadius = design ? (design.border_radius || 12) : 12;
  const cardWidth = design ? (design.card_width || 500) : 500;

  banner.style.background = `linear-gradient(160deg, ${darken(bgColor)}, ${bgColor} 40%, ${darken(bgColor)})`;
  banner.style.color = textColor;
  banner.style.borderColor = hexToRgba(accentColor, 0.3);
  banner.style.boxShadow = `0 4px 20px ${hexToRgba(accentColor, 0.15)}`;
  banner.style.borderRadius = borderRadius + 'px';
  banner.style.maxWidth = cardWidth + 'px';

  // Position — use design position if available, otherwise notification position
  const pos = design ? (design.card_position || 'bot-center') : (data.position || 'bot-center');
  const [vPos, hPos] = pos.split('-');
  if (vPos === 'top') { banner.style.top = '16px'; }
  else if (vPos === 'bot') { banner.style.bottom = '16px'; }
  else { banner.style.top = '50%'; banner.style.transform = 'translateY(-50%)'; }

  if (hPos === 'center' || !hPos) { banner.style.left = '50%'; banner.style.transform = (banner.style.transform || '') + ' translateX(-50%)'; }
  else if (hPos === 'left') { banner.style.left = '16px'; }
  else { banner.style.right = '16px'; }

  banner.innerHTML = `
    ${data.name ? `<div class="timed-name">${esc(data.name)}</div>` : ''}
    <div class="timed-message">${esc(data.message)}</div>
  `;

  timedContainer.appendChild(banner);

  const duration = (data.duration || 8) * 1000;
  setTimeout(() => {
    banner.classList.add('dismissing');
    banner.addEventListener('animationend', () => banner.remove());
  }, duration);
}
