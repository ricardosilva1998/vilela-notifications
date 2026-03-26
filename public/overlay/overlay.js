const container = document.getElementById('notification-container');
let overlayConfig = {};
const queue = [];
let isPlaying = false;

// Connect to SSE
const evtSource = new EventSource(`/overlay/events/${window.OVERLAY_TOKEN}`);

evtSource.onmessage = (e) => {
  const data = JSON.parse(e.data);

  if (data.type === 'config') {
    overlayConfig = data.config;
    return;
  }

  // Check if event type is enabled
  const eventType = data.type;
  const typeConfig = overlayConfig[eventType];
  if (typeConfig && !typeConfig.enabled) return;

  queue.push(data);
  if (!isPlaying) playNext();
};

evtSource.onerror = () => {
  console.log('SSE connection lost, reconnecting...');
};

function playNext() {
  if (queue.length === 0) { isPlaying = false; return; }
  isPlaying = true;
  const event = queue.shift();
  showNotification(event);
}

function showNotification(event) {
  const typeConfig = overlayConfig[event.type] || {};
  const duration = (typeConfig.duration || 5) * 1000;

  // Play sound — uses default sound files from /overlay/sounds/{type}.mp3
  // Users can replace these files with custom sounds
  const soundMap = {
    follow: '/overlay/sounds/follow.mp3',
    subscription: '/overlay/sounds/sub.mp3',
    bits: '/overlay/sounds/bits.mp3',
    donation: '/overlay/sounds/donation.mp3',
    raid: '/overlay/sounds/raid.mp3',
    yt_superchat: '/overlay/sounds/yt_superchat.mp3',
    yt_member: '/overlay/sounds/yt_member.mp3',
    yt_giftmember: '/overlay/sounds/yt_giftmember.mp3',
  };
  const soundUrl = soundMap[event.type];
  if (soundUrl) {
    const audio = new Audio(soundUrl);
    audio.volume = overlayConfig.volume || 0.8;
    audio.play().catch(() => {}); // Fails silently if file doesn't exist
  }

  const banner = document.createElement('div');
  banner.className = `banner banner-${event.type} engine-idle`;
  banner.innerHTML = buildBannerContent(event);
  container.appendChild(banner);

  setTimeout(() => {
    banner.classList.add('dismissing');
    banner.addEventListener('animationend', () => {
      banner.remove();
      setTimeout(playNext, 500); // Gap between notifications
    });
  }, duration);
}

function buildBannerContent(event) {
  const checkers = '<div class="checker-top"></div><div class="checker-bottom"></div>';

  switch (event.type) {
    case 'follow':
      return `${checkers}
        <div class="follow-car">🏎️</div>
        <div class="banner-content"><div style="text-align:center">
          <div class="banner-title">New Pit Crew Member!</div>
          <div class="banner-name">${esc(event.data.username)}</div>
          <div class="banner-sub">just joined the race 🏁</div>
        </div></div>`;

    case 'subscription': {
      const d = event.data;
      const detail = d.months && d.months > 1
        ? `Subscribed for <span style="color:#00ff88;font-weight:bold">${d.months} months</span> — Tier ${d.tier || '1'}`
        : d.message ? esc(d.message) : `Tier ${d.tier || '1'} subscriber!`;
      return `${checkers}
        <div class="sub-car-left">🏎️</div>
        <div class="sub-car-right">🏎️</div>
        <div class="banner-content">
          <div class="banner-emoji">🏆</div>
          <div style="text-align:center">
            <div class="banner-title">Podium Finish!</div>
            <div class="banner-name">${esc(d.username)}</div>
            <div class="banner-sub">${detail}</div>
          </div>
          <div class="banner-emoji">🏆</div>
        </div>`;
    }

    case 'bits':
      return `${checkers}
        <div class="burnout-car-right">🏎️</div>
        <div class="fire-single fire-behind-right">🔥</div>
        <div class="burnout-car-left">🏎️</div>
        <div class="fire-single fire-behind-left">🔥</div>
        <div class="tire-smoke ts-1">💨</div><div class="tire-smoke ts-2">💨</div>
        <div class="tire-smoke ts-3">💨</div><div class="tire-smoke ts-4">💨</div>
        <div class="banner-content"><div style="text-align:center">
          <div class="banner-title">Nitro Boost!</div>
          <div class="banner-name">${esc(event.data.username)}</div>
          <div class="banner-sub">fueled up <span style="color:#f7c948;font-weight:bold">${event.data.amount} bits</span> of nitro! 🔥</div>
        </div></div>`;

    case 'donation':
      return `${checkers}
        <div class="sponsor-car">🏎️</div>
        <div class="speed-line sl-1"></div><div class="speed-line sl-2"></div>
        <div class="speed-line sl-3"></div><div class="speed-line sl-4"></div>
        <div class="banner-content">
          <div class="banner-emoji">🛞</div>
          <div style="text-align:center">
            <div class="banner-title">Sponsor Alert!</div>
            <div class="banner-name">${esc(event.data.username)}</div>
            <div class="banner-sub">sponsored the team with <span style="color:#bf00ff;font-weight:bold">$${event.data.amount}</span> 💸</div>
          </div>
          <div class="banner-emoji">🛞</div>
        </div>`;

    case 'raid':
      return `${checkers}
    <div class="raid-car-1">🏎️</div>
    <div class="raid-car-2">🏎️</div>
    <div class="raid-car-3">🏎️</div>
    <div class="banner-content"><div style="text-align:center">
      <div class="banner-title">Incoming Raid!</div>
      <div class="banner-name">${esc(event.data.username)}</div>
      <div class="banner-sub">raiding with <span style="color:#ff4444;font-weight:bold">${event.data.viewers} viewers</span>! 🏁</div>
    </div></div>`;

    case 'yt_superchat':
      return `${checkers}
        <div class="follow-car">🏎️</div>
        <div class="banner-content"><div style="text-align:center">
          <div class="banner-title">Super Chat!</div>
          <div class="banner-name">${esc(event.data.username)}</div>
          <div class="banner-sub">sent <span style="color:#ff4444;font-weight:bold">${esc(event.data.amount)}</span>${event.data.message ? ' — ' + esc(event.data.message) : ''}</div>
        </div></div>`;

    case 'yt_member':
      return `${checkers}
        <div class="sub-car-left">🏎️</div>
        <div class="sub-car-right">🏎️</div>
        <div class="banner-content">
          <div class="banner-emoji">⭐</div>
          <div style="text-align:center">
            <div class="banner-title">New Member!</div>
            <div class="banner-name">${esc(event.data.username)}</div>
            <div class="banner-sub">just became a ${esc(event.data.level || 'member')}!</div>
          </div>
          <div class="banner-emoji">⭐</div>
        </div>`;

    case 'yt_giftmember':
      return `${checkers}
        <div class="burnout-car-right">🏎️</div>
        <div class="fire-single fire-behind-right">🔥</div>
        <div class="burnout-car-left">🏎️</div>
        <div class="fire-single fire-behind-left">🔥</div>
        <div class="banner-content"><div style="text-align:center">
          <div class="banner-title">Gift Alert!</div>
          <div class="banner-name">${esc(event.data.username)}</div>
          <div class="banner-sub">gifted <span style="color:#4285f4;font-weight:bold">${event.data.amount} memberships</span>!</div>
        </div></div>`;

    default: return '';
  }
}

function esc(text) {
  const d = document.createElement('div');
  d.textContent = text || '';
  return d.innerHTML;
}
