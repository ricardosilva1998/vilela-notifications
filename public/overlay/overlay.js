console.log('[Overlay] Script loaded, OVERLAY_TOKEN:', window.OVERLAY_TOKEN ? 'present' : 'MISSING');

const container = document.getElementById('notification-container');
let overlayConfig = {};
let overlayDesigns = {};
let serverVersion = null;
const queue = [];
let isPlaying = false;

// Load Google Fonts used by custom designs
const loadedFonts = new Set();
function loadDesignFonts(designs) {
  const FONT_MAP = {
    'Inter': 'Inter:wght@400;600;700;800',
    'Poppins': 'Poppins:wght@400;600;700;800',
    'Roboto Mono': 'Roboto+Mono:wght@400;700',
    'Press Start 2P': 'Press+Start+2P',
    'Outfit': 'Outfit:wght@400;600;700;800',
    'Permanent Marker': 'Permanent+Marker',
    'Bangers': 'Bangers',
  };
  const fontsNeeded = new Set();
  Object.values(designs).forEach(d => {
    [d.font_family, d.label_font_family, d.username_font_family, d.detail_font_family].forEach(f => {
      if (f && f !== 'System Default' && FONT_MAP[f] && !loadedFonts.has(f)) fontsNeeded.add(f);
    });
  });
  fontsNeeded.forEach(f => {
    loadedFonts.add(f);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${FONT_MAP[f]}&display=swap`;
    document.head.appendChild(link);
  });
}

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
      if (data.designs) {
        overlayDesigns = data.designs;
        loadDesignFonts(data.designs);
      }
      return;
    }

    if (data.type === 'config-update') {
      console.log('[Overlay] Design config updated from builder');
      if (data.designs) {
        overlayDesigns = data.designs;
        loadDesignFonts(data.designs);
      }
      return;
    }

    if (data.type === 'clear') {
      clearOverlay();
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

    // Gift sub dedup: when a gift sub event arrives (isGift flag),
    // suppress individual subscribe events that follow within 10 seconds
    // (Twitch sends both a giftsub event AND individual sub events for each recipient)
    if (data.isGift) {
      window._giftSubUntil = Date.now() + 10000;
    }
    if (data.type === 'subscription' && !data.isGift && window._giftSubUntil && Date.now() < window._giftSubUntil) {
      console.log('[Overlay] Suppressing individual sub (part of gift sub batch)');
      return;
    }

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

function clearOverlay() {
  queue.length = 0;
  isPlaying = false;
  stopCurrentSound();
  // Remove all alert cards and screen effects
  document.querySelectorAll('.alert-card, .screen-effect').forEach(e => e.remove());
  console.log('[Overlay] Queue cleared, all cards removed');
}

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
let currentAudio = null;

function stopCurrentSound() {
  if (currentAudio) {
    try {
      currentAudio.pause();
      currentAudio.currentTime = 0;
    } catch (e) {}
    currentAudio = null;
  }
}

function showNotification(event) {
  const typeConfig = overlayConfig[event.type] || {};
  const duration = (typeConfig.duration || 5) * 1000;

  // Stop any currently playing sound before starting new one
  stopCurrentSound();

  // Play notification sound — try custom mp3 first, fall back to synthesized
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const soundUrl = `/overlay/sounds/${event.type}.mp3`;
  const audio = new Audio(soundUrl);
  audio.volume = overlayConfig.volume || 0.8;
  currentAudio = audio;
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

    // Fade out and remove card
    card.style.transition = 'opacity 0.3s ease-in';
    card.style.opacity = '0';
    setTimeout(() => {
      card.remove();
      setTimeout(playNext, 500);
    }, 400);
  }, duration);
}

// ─── Build card HTML per event type ───────────────────────────
// Default side icons per event type
const DEFAULT_SIDE_ICONS = {
  subscription: '🏆', yt_member: '⭐',
};

function getSideIcon(eventType) {
  const design = overlayDesigns[eventType];
  if (design && design.card_side_icon) {
    return design.card_side_icon === 'none' ? null : design.card_side_icon;
  }
  return DEFAULT_SIDE_ICONS[eventType] || null;
}

function wrapWithSideIcons(icon, bodyHtml) {
  if (!icon) return bodyHtml;
  return `<div class="cup-row"><span class="cup">${icon}</span><div class="card-inner">${bodyHtml}</div><span class="cup">${icon}</span></div>`;
}

function buildBannerContent(event) {
  const icon = getSideIcon(event.type);

  switch (event.type) {
    case 'follow': {
      const body = `<div class="event-label">New Pit Crew Member</div>
          <div class="username">${esc(event.data.username)}</div>
          <div class="detail">just joined the race 🏁</div>`;
      return `<div class="top-accent"></div>
        <div class="card-body">${wrapWithSideIcons(icon, body)}</div>
        <div class="car-track">
          <div class="race-line"></div>
          <div class="speed-dot fsd1"></div>
          <div class="speed-dot fsd2"></div>
          <div class="speed-dot fsd3"></div>
          <div class="track-car">🏎️</div>
        </div>`;
    }

    case 'subscription': {
      const d = event.data;
      const detail = d.months && d.months > 1
        ? `Subscribed for <b>${d.months} months</b> — Tier ${d.tier || '1'} 🥇`
        : d.message ? esc(d.message) : `Tier ${d.tier || '1'} subscriber! 🥇`;
      const body = `<div class="event-label">Podium Finish</div>
          <div class="username">${esc(d.username)}</div>
          <div class="detail">${detail}</div>`;
      return `<div class="top-accent"></div>
        <div class="card-body">${wrapWithSideIcons(icon, body)}</div>
        <div class="car-track">
          <div class="race-line"></div>
          <div class="track-car">🏎️</div>
        </div>`;
    }

    case 'bits': {
      const body = `<div class="event-label">Nitro Boost</div>
          <div class="username">${esc(event.data.username)}</div>
          <div class="detail">fueled up <b>${event.data.amount} bits</b> of nitro! 🔥</div>`;
      return `<div class="top-accent"></div>
        <div class="card-body">${wrapWithSideIcons(icon, body)}</div>
        <div class="car-track">
          <div class="race-line"></div>
          <div class="track-car">🏎️</div>
        </div>`;
    }

    case 'donation': {
      const body = `<div class="event-label">Sponsor Alert</div>
          <div class="username">${esc(event.data.username)}</div>
          <div class="detail">sponsored the team with <b>$${event.data.amount}</b> 💸</div>`;
      return `<div class="top-accent"></div>
        <div class="card-body">${wrapWithSideIcons(icon, body)}</div>
        <div class="car-track">
          <div class="race-line"></div>
          <div class="speed-dot dsd1"></div>
          <div class="speed-dot dsd2"></div>
          <div class="speed-dot dsd3"></div>
          <div class="track-car donation-car">🏎️</div>
        </div>`;
    }

    case 'raid': {
      const viewers = event.data.viewers || '??';
      const body = `<div class="event-label">Incoming Raid</div>
          <div class="username">${esc(event.data.username)}</div>
          <div class="detail">raiding with <b>${viewers} viewers</b>! 🏁</div>`;
      return `<div class="top-accent"></div>
        <div class="card-body">${wrapWithSideIcons(icon, body)}</div>
        <div class="car-track">
          <div class="race-line"></div>
          <div class="track-car">🏎️</div>
        </div>`;
    }

    case 'yt_superchat': {
      const body = `<div class="event-label">Super Chat</div>
          <div class="username">${esc(event.data.username)}</div>
          <div class="detail">sent <b>${esc(event.data.amount)}</b>${event.data.message ? ' — ' + esc(event.data.message) : ''} 🔥</div>`;
      return `<div class="top-accent"></div>
        <div class="card-body">${wrapWithSideIcons(icon, body)}</div>
        <div class="car-track">
          <div class="race-line"></div>
          <div class="track-car">🏎️</div>
        </div>`;
    }

    case 'yt_member': {
      const d = event.data;
      const body = `<div class="event-label">New Member</div>
          <div class="username">${esc(d.username)}</div>
          <div class="detail">just became a <b>${esc(d.level || 'member')}</b>! 🥇</div>`;
      return `<div class="top-accent"></div>
        <div class="card-body">${wrapWithSideIcons(icon, body)}</div>`;
    }

    case 'yt_giftmember': {
      const body = `<div class="event-label">Gift Alert</div>
          <div class="username">${esc(event.data.username)}</div>
          <div class="detail">gifted <b>${event.data.amount} memberships</b>! 🎁</div>`;
      return `<div class="top-accent"></div>
        <div class="card-body">${wrapWithSideIcons(icon, body)}</div>
        <div class="car-track">
          <div class="race-line"></div>
          <div class="track-car">🏎️</div>
        </div>`;
    }

    default: return '';
  }
}

// ─── Full-screen effects ───────────────────────────────────────
function spawnEffects(type) {
  document.querySelectorAll('.screen-effect').forEach(e => e.remove());

  const design = overlayDesigns[type] || {};
  const speed = design.animation_speed || 1.0;
  const amount = design.effect_amount || 1.0;
  const size = design.effect_size || 1.0;
  const dir = design.effect_direction || 'down';

  // Use custom screen_effect if set, otherwise default per event type
  let effect = design.screen_effect || 'default';
  if (effect === 'default') {
    const defaults = {
      follow: 'tiremarks', subscription: 'confetti', yt_member: 'confetti',
      bits: 'gold', yt_superchat: 'gold',
      donation: 'money', yt_giftmember: 'money',
      raid: 'robots',
    };
    effect = defaults[type] || 'none';
  }
  if (effect === 'none') return;

  switch (effect) {
    case 'tiremarks':  spawnTireMarks(speed, amount, size, dir);           break;
    case 'confetti':   spawnConfettiAndFlashes(speed, amount, size, dir);  break;
    case 'gold':       spawnGoldRain(speed, amount, size, dir);            break;
    case 'money':      spawnMoneyRain(speed, amount, size, dir);           break;
    case 'robots':     spawnRobots(speed, amount, size, dir);              break;
  }
}

function getSpawnPos(dir) {
  if (dir === 'down') return `left:${Math.random()*100}vw;top:-40px;bottom:auto;`;
  if (dir === 'up') return `left:${Math.random()*100}vw;bottom:-40px;top:auto;`;
  if (dir === 'left') return `top:${Math.random()*100}vh;right:-40px;left:auto;`;
  if (dir === 'right') return `top:${Math.random()*100}vh;left:-40px;right:auto;`;
  return `left:${Math.random()*100}vw;top:-40px;bottom:auto;`;
}

function getFallAnim(dir) {
  if (dir === 'up') return 'confFallUp';
  if (dir === 'left') return 'confFallLeft';
  if (dir === 'right') return 'confFallRight';
  return 'confFall';
}

function spawnTireMarks(speed, amount, size, dir) {
  const count = Math.round(2 * amount);
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = `screen-effect tire-mark tire-mark-${(i % 2) + 1}`;
    el.style.animationDuration = `${3.5 / speed}s`;
    container.appendChild(el);
  }

  const sparkCount = Math.round(12 * amount);
  for (let i = 0; i < sparkCount; i++) {
    const sp = document.createElement('div');
    sp.className = 'screen-effect tire-spark';
    sp.style.width = `${4 * size}px`;
    sp.style.height = `${4 * size}px`;
    sp.style.left = `${Math.random() * 100}vw`;
    sp.style.top  = `${35 + Math.random() * 20}vh`;
    const angle = Math.random() * 360;
    const dist  = (20 + Math.random() * 60) * size;
    sp.style.setProperty('--sx', `${Math.cos(angle * Math.PI / 180) * dist}px`);
    sp.style.setProperty('--sy', `${Math.sin(angle * Math.PI / 180) * dist}px`);
    sp.style.animationDelay    = `${Math.random() * 0.4}s`;
    sp.style.animationDuration = `${(0.5 + Math.random() * 0.4) / speed}s`;
    container.appendChild(sp);
  }
}

function spawnConfettiAndFlashes(speed, amount, size, dir) {
  const colors = ['#ff4444','#00ff88','#f7c948','#4285f4','#ff88cc','#ffffff','#bf00ff','#00ccff'];
  const count = Math.round(60 * amount);
  const fallAnim = getFallAnim(dir);

  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'screen-effect confetti';
    el.style.cssText = getSpawnPos(dir);
    el.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    el.style.width           = `${(6 + Math.random() * 8) * size}px`;
    el.style.height          = `${(8 + Math.random() * 10) * size}px`;
    el.style.animationName     = fallAnim;
    el.style.animationDelay    = `${Math.random() * 1.5}s`;
    el.style.animationDuration = `${(2 + Math.random() * 2) / speed}s`;
    container.appendChild(el);
  }

  const flashCount = Math.round(5 * amount);
  for (let i = 0; i < flashCount; i++) {
    const fl = document.createElement('div');
    fl.className = 'screen-effect cam-flash';
    fl.style.setProperty('--fx', `${15 + Math.random() * 70}%`);
    fl.style.setProperty('--fy', `${20 + Math.random() * 50}%`);
    fl.style.animationDelay = `${i * (0.5 / speed)}s`;
    container.appendChild(fl);
  }
}

function spawnGoldRain(speed, amount, size, dir) {
  const items = ['🪙','💎','⭐','🏆','✨','💰','🥇'];
  const count = Math.round(35 * amount);
  const fallAnim = getFallAnim(dir);
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className   = 'screen-effect gold-item';
    el.textContent = items[Math.floor(Math.random() * items.length)];
    el.style.cssText = getSpawnPos(dir);
    el.style.fontSize          = `${24 * size}px`;
    el.style.animationName     = fallAnim;
    el.style.animationDelay    = `${Math.random() * 2}s`;
    el.style.animationDuration = `${(1.5 + Math.random() * 2) / speed}s`;
    container.appendChild(el);
  }
}

function spawnMoneyRain(speed, amount, size, dir) {
  const items = ['💵','💰','💲','🪙','💸','💎'];
  const count = Math.round(30 * amount);
  const fallAnim = getFallAnim(dir);
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className   = 'screen-effect money-item';
    el.textContent = items[Math.floor(Math.random() * items.length)];
    el.style.cssText = getSpawnPos(dir);
    el.style.fontSize          = `${22 * size}px`;
    el.style.animationName     = fallAnim;
    el.style.animationDelay    = `${Math.random() * 2}s`;
    el.style.animationDuration = `${(1.5 + Math.random() * 2) / speed}s`;
    container.appendChild(el);
  }
}

function spawnRobots(speed, amount, size, dir) {
  const count = Math.round(30 * amount);
  const fallAnim = getFallAnim(dir);
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className   = 'screen-effect robot';
    el.textContent = '🤖';
    el.style.cssText = getSpawnPos(dir);
    el.style.fontSize          = `${26 * size}px`;
    el.style.animationName     = fallAnim;
    el.style.animationDelay    = `${Math.random() * 2.5}s`;
    el.style.animationDuration = `${(1.5 + Math.random() * 2) / speed}s`;
    container.appendChild(el);
  }

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

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return [r,g,b];
}

function hexToRgba(hex, alpha) {
  const [r,g,b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ─── Bottom bar animation builder ──────────────────────────────
// Full-card animations are overlaid on the card; bottom-track animations stay in .car-track
const FULL_CARD_ANIMS = new Set(['flames','sparkles','lightning','neonSweep','pulse']);

function buildBottomAnimation(track, type, speed, accent, card) {
  const [ar,ag,ab] = hexToRgb(accent);
  const dur = (2.8 / speed);

  // Remove any previous full-card overlay
  if (card) card.querySelectorAll('.card-anim-overlay').forEach(e => e.remove());

  // Full-card animations — keep track visible for consistent height, overlay on the card
  if (FULL_CARD_ANIMS.has(type) && card) {
    track.innerHTML = '';
    track.style.display = '';
    const overlay = document.createElement('div');
    overlay.className = 'card-anim-overlay';

    if (type === 'flames') {
      let h = '';
      // Full-width flame layers covering left to right
      for (let i = 0; i < 25; i++) {
        const x = (i / 25) * 100 - 5 + Math.random() * 10;
        const w = 20 + Math.random() * 20;
        const ht = 50 + Math.random() * 40;
        const d = (0.5 + Math.random() * 0.7) / speed;
        const delay = Math.random() * 1;
        const hue = Math.floor(Math.random() * 45);
        h += `<div style="position:absolute;bottom:-15%;left:${x}%;width:${w}%;height:${ht}%;border-radius:50% 50% 20% 20%;background:radial-gradient(ellipse at bottom, hsla(${hue},100%,55%,0.6), hsla(${hue+15},100%,45%,0.25) 50%, transparent 75%);filter:blur(4px);animation:flameRise ${d}s ease-in-out ${delay}s infinite;"></div>`;
      }
      // Full-width base glow
      h += `<div style="position:absolute;bottom:0;left:0;right:0;height:50%;background:linear-gradient(to top,rgba(255,60,0,0.5),rgba(255,120,0,0.2) 40%,transparent);animation:flameGlow ${1.5/speed}s ease-in-out infinite;"></div>`;
      // Inner glow layer
      h += `<div style="position:absolute;bottom:0;left:0;right:0;height:30%;background:linear-gradient(to top,rgba(255,200,0,0.3),transparent);animation:flameGlow ${1/speed}s ease-in-out 0.3s infinite;"></div>`;
      // Ember particles
      for (let i = 0; i < 12; i++) {
        const x = Math.random() * 100;
        const d = (1 + Math.random() * 1.5) / speed;
        const delay = Math.random() * 2;
        const sz = 2 + Math.random() * 2;
        h += `<div style="position:absolute;bottom:10%;left:${x}%;width:${sz}px;height:${sz}px;border-radius:50%;background:#ffaa00;box-shadow:0 0 ${sz*2}px #ff4400;animation:flameRise ${d}s ease-out ${delay}s infinite;opacity:0.8;"></div>`;
      }
      overlay.innerHTML = h;
    }
    else if (type === 'sparkles') {
      let h = '';
      const colors = ['#fff', accent, '#f7c948', '#ff88cc', '#00ffcc'];
      for (let i = 0; i < 20; i++) {
        const x = Math.random() * 100;
        const y = Math.random() * 100;
        const size = 2 + Math.random() * 4;
        const d = (1.5 + Math.random() * 2) / speed;
        const delay = Math.random() * 3;
        const sx = (Math.random() - 0.5) * 40;
        const sy = (Math.random() - 0.5) * 40;
        const c = colors[Math.floor(Math.random() * colors.length)];
        h += `<div style="position:absolute;left:${x}%;top:${y}%;width:${size}px;height:${size}px;border-radius:50%;background:${c};box-shadow:0 0 ${size*3}px ${c};--sx:${sx}px;--sy:${sy}px;animation:sparkFloat ${d}s ease-in-out ${delay}s infinite;"></div>`;
      }
      // Add star shapes
      for (let i = 0; i < 6; i++) {
        const x = 10 + Math.random() * 80;
        const y = 10 + Math.random() * 80;
        const d = (2 + Math.random() * 2) / speed;
        const delay = Math.random() * 3;
        const c = colors[Math.floor(Math.random() * colors.length)];
        h += `<div style="position:absolute;left:${x}%;top:${y}%;font-size:${8+Math.random()*10}px;--sx:${(Math.random()-0.5)*30}px;--sy:${(Math.random()-0.5)*30}px;animation:sparkFloat ${d}s ease-in-out ${delay}s infinite;filter:drop-shadow(0 0 3px ${c});">✦</div>`;
      }
      overlay.innerHTML = h;
    }
    else if (type === 'lightning') {
      let h = '';
      // SVG zigzag lightning bolts
      for (let i = 0; i < 5; i++) {
        const x = 5 + Math.random() * 90;
        const d = (1.5 + Math.random() * 2.5) / speed;
        const delay = Math.random() * 3;
        // Generate zigzag path
        let points = `M ${Math.random()*20+40} 0`;
        let py = 0;
        for (let s = 0; s < 6; s++) {
          py += 12 + Math.random() * 8;
          const px = 20 + Math.random() * 60;
          points += ` L ${px} ${py}`;
        }
        h += `<svg style="position:absolute;left:${x}%;top:0;width:40px;height:100%;animation:boltStrike ${d}s ease-out ${delay}s infinite;" viewBox="0 0 100 100" preserveAspectRatio="none">
          <path d="${points}" stroke="rgba(${ar},${ag},${ab},0.9)" stroke-width="2" fill="none" filter="url(#bolt-glow-${i})"/>
          <defs><filter id="bolt-glow-${i}"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
        </svg>`;
      }
      // Flash overlay
      h += `<div style="position:absolute;inset:0;background:rgba(${ar},${ag},${ab},0.05);animation:ecgPulse ${1.5/speed}s ease-in-out infinite;"></div>`;
      overlay.innerHTML = h;
    }
    else if (type === 'neonSweep') {
      let h = '';
      // Main sweep beam
      h += `<div style="position:absolute;top:0;bottom:0;width:30%;background:linear-gradient(90deg,transparent,rgba(${ar},${ag},${ab},0.15),rgba(${ar},${ag},${ab},0.3),rgba(${ar},${ag},${ab},0.15),transparent);animation:neonSweepFull ${2.5/speed}s linear infinite;"></div>`;
      // Secondary thin sweep
      h += `<div style="position:absolute;top:0;bottom:0;width:10%;background:linear-gradient(90deg,transparent,rgba(${ar},${ag},${ab},0.1),transparent);animation:neonSweepFull ${3/speed}s linear ${0.8/speed}s infinite;"></div>`;
      // Border glow pulse
      h += `<div style="position:absolute;inset:0;border:1px solid rgba(${ar},${ag},${ab},0.2);border-radius:inherit;animation:ecgPulse ${2/speed}s ease-in-out infinite;"></div>`;
      overlay.innerHTML = h;
    }
    else if (type === 'pulse') {
      // ECG heartbeat line sweeping across
      let h = '';
      // Background line
      h += `<div style="position:absolute;top:50%;left:0;right:0;height:1px;background:rgba(${ar},${ag},${ab},0.15);transform:translateY(-50%);"></div>`;
      // SVG ECG waveform
      const ecgPath = 'M 0 50 L 15 50 L 18 50 L 20 30 L 22 70 L 24 20 L 26 80 L 28 45 L 32 50 L 50 50 L 53 50 L 55 35 L 57 65 L 59 50 L 75 50 L 100 50';
      for (let i = 0; i < 2; i++) {
        const d = (3 + i * 0.5) / speed;
        const delay = i * (1.5 / speed);
        h += `<svg style="position:absolute;top:20%;height:60%;width:50%;animation:ecgSweep ${d}s linear ${delay}s infinite;" viewBox="0 0 100 100" preserveAspectRatio="none">
          <path d="${ecgPath}" stroke="rgba(${ar},${ag},${ab},0.8)" stroke-width="2" fill="none"/>
        </svg>`;
      }
      // Glowing dot at peak
      h += `<div style="position:absolute;top:50%;left:50%;width:4px;height:4px;border-radius:50%;background:rgba(${ar},${ag},${ab},0.8);box-shadow:0 0 8px rgba(${ar},${ag},${ab},0.6);transform:translate(-50%,-50%);animation:ecgPulse ${1/speed}s ease-in-out infinite;"></div>`;
      overlay.innerHTML = h;
    }

    card.style.position = card.style.position || 'relative';
    card.appendChild(overlay);
    return;
  }

  // Bottom-track animations
  track.style.display = '';
  track.innerHTML = '';

  switch (type) {
    case 'zoomLR':
      track.innerHTML = '<div class="race-line"></div><div class="track-car" style="animation:carZoomLR '+dur+'s linear infinite">🏎️</div>';
      break;
    case 'zoomRL':
      track.innerHTML = '<div class="race-line"></div><div class="track-car" style="transform:translateY(-50%);animation:carZoomRL '+dur+'s linear infinite">🏎️</div>';
      break;
    case 'checkered': {
      let cells = '';
      const rows = 4, cols = 40;
      const cellH = Math.floor(44 / rows);
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
          cells += `<div style="width:${cellH}px;height:${cellH}px;background:${(r+c)%2===0?'rgba(255,255,255,0.85)':'rgba(0,0,0,0.85)'}"></div>`;
      track.innerHTML = `<div style="position:absolute;inset:0;overflow:hidden;"><div style="position:absolute;top:0;bottom:0;width:${cols*cellH}px;display:flex;flex-wrap:wrap;animation:checkerScroll ${3/speed}s linear infinite;">${cells}</div></div>`;
      break;
    }
    case 'equalizer': {
      let html = '<div style="position:absolute;bottom:0;left:0;right:0;height:100%;display:flex;align-items:flex-end;justify-content:center;gap:2px;padding:3px 8px;">';
      for (let i = 0; i < 24; i++) {
        const d = (0.4 + Math.random() * 0.6) / speed;
        html += `<div style="flex:1;height:${20+Math.random()*60}%;background:rgba(${ar},${ag},${ab},0.7);border-radius:2px 2px 0 0;animation:eqBounce ${d}s ease-in-out ${Math.random()*0.5}s infinite;"></div>`;
      }
      html += '</div>';
      track.innerHTML = html;
      break;
    }
    default:
      track.innerHTML = '<div class="race-line"></div><div class="track-car" style="animation:carZoomLR '+dur+'s linear infinite">🏎️</div>';
  }
}

function applyCustomDesign(card, eventType) {
  const design = overlayDesigns[eventType];
  if (!design) return;

  // Background (with advanced theme)
  const bgOpacity = design.bg_opacity != null ? design.bg_opacity : 1.0;
  const gradDir = design.gradient_direction || '160deg';
  const [bgR,bgG,bgB] = hexToRgb(design.bg_color);
  const darkR = Math.round(bgR * 0.35), darkG = Math.round(bgG * 0.35), darkB = Math.round(bgB * 0.35);
  if (gradDir) {
    card.style.background = `linear-gradient(${gradDir}, rgba(${darkR},${darkG},${darkB},${bgOpacity}), rgba(${bgR},${bgG},${bgB},${bgOpacity}) 40%, rgba(${darkR},${darkG},${darkB},${bgOpacity}))`;
  } else {
    card.style.background = `rgba(${bgR},${bgG},${bgB},${bgOpacity})`;
  }

  // Border (with advanced theme)
  const borderThick = design.border_thickness != null ? design.border_thickness : 2;
  const borderOpacity = design.border_opacity != null ? design.border_opacity : 0.5;
  card.style.border = `${borderThick}px solid ${hexToRgba(design.border_color, borderOpacity)}`;
  card.style.borderRadius = (design.border_radius || 16) + 'px';
  card.style.width = (design.card_width || 420) + 'px';

  // Shadow & glow (with advanced theme)
  const glowIntensity = design.glow_intensity != null ? design.glow_intensity : 0.25;
  const shadowOpacity = design.shadow_opacity != null ? design.shadow_opacity : 0.6;
  const shadowBlur = design.shadow_blur != null ? design.shadow_blur : 32;
  const shadowSpread = design.shadow_spread != null ? design.shadow_spread : 0;
  if (glowIntensity > 0) {
    card.style.boxShadow = `0 ${Math.round(shadowBlur/4)}px ${shadowBlur}px ${shadowSpread}px ${hexToRgba(design.border_color, glowIntensity)}, 0 4px 24px rgba(0,0,0,${shadowOpacity})`;
  } else {
    card.style.boxShadow = `0 4px ${shadowBlur}px ${shadowSpread}px rgba(0,0,0,${shadowOpacity})`;
  }

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

  // Text alignment
  const cardBody = card.querySelector('.card-body');
  if (cardBody && design.text_align) {
    cardBody.style.textAlign = design.text_align;
  }

  // Event label — per-text styling with fallbacks
  const labelEl = card.querySelector('.event-label');
  if (labelEl) {
    labelEl.style.color = design.label_color || design.accent_color;
    if (design.event_label) labelEl.textContent = design.event_label;
    if (design.label_font_size) labelEl.style.fontSize = design.label_font_size + 'px';
    if (design.label_font_weight) labelEl.style.fontWeight = design.label_font_weight;
    const labelFont = design.label_font_family || design.font_family;
    if (labelFont && labelFont !== 'System Default') labelEl.style.fontFamily = labelFont;
  }

  // Detail text — per-text styling with fallbacks
  const detailEl = card.querySelector('.detail');
  if (detailEl) {
    if (design.detail_text) detailEl.innerHTML = design.detail_text;
    detailEl.style.color = design.detail_color || design.text_color || '#ffffff';
    if (design.detail_font_size) detailEl.style.fontSize = design.detail_font_size + 'px';
    if (design.detail_font_weight) detailEl.style.fontWeight = design.detail_font_weight;
    const detailFont = design.detail_font_family || design.font_family;
    if (detailFont && detailFont !== 'System Default') detailEl.style.fontFamily = detailFont;
  }

  // Username — per-text styling with fallbacks
  const usernameEl = card.querySelector('.username');
  if (usernameEl) {
    usernameEl.style.color = design.username_color || design.text_color || '#ffffff';
    if (design.username_size) usernameEl.style.fontSize = design.username_size + 'px';
    if (design.username_font_weight) usernameEl.style.fontWeight = design.username_font_weight;
    const usernameFont = design.username_font_family || design.font_family;
    if (usernameFont && usernameFont !== 'System Default') usernameEl.style.fontFamily = usernameFont;
  }

  // Legacy fallback: apply font_family to whole card if no per-element fonts
  if (design.font_family && design.font_family !== 'System Default' &&
      !design.label_font_family && !design.username_font_family && !design.detail_font_family) {
    card.style.fontFamily = design.font_family;
  }

  // Bottom bar animation
  const track = card.querySelector('.car-track');
  if (track) {
    track.style.background = hexToRgba(design.accent_color, 0.06);
    const bottomAnim = design.car_animation || 'zoomLR';
    const speed = design.animation_speed || 1.0;
    const accent = design.accent_color || '#8888cc';

    if (bottomAnim === 'none') {
      track.innerHTML = '';
      track.style.display = '';
    } else {
      buildBottomAnimation(track, bottomAnim, speed, accent, card);
    }
  }

  // Entrance animation
  if (design.entrance_animation && design.entrance_animation !== 'slideDown' && !design.card_custom_x) {
    card.classList.remove('entering');
    const speed = design.animation_speed || 1.0;
    card.style.animation = `${design.entrance_animation} ${0.4 / speed}s ease-out forwards`;
  }
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
