// Scene overlay — Starting Soon, BRB, Ending screens
let serverVersion = null;
let evtSource = null;
let reconnectTimer = null;
let currentOverlays = {};
let countdownInterval = null;

function connectSSE() {
  if (evtSource) { evtSource.close(); evtSource = null; }

  evtSource = new EventSource(`/overlay/scenes/events/${window.OVERLAY_TOKEN}`);

  evtSource.onmessage = (e) => {
    const data = JSON.parse(e.data);

    if (data.type === 'config') {
      if (serverVersion && data.serverVersion && data.serverVersion !== serverVersion) {
        location.reload();
        return;
      }
      serverVersion = data.serverVersion;
      if (data.overlays) {
        for (const overlay of data.overlays) {
          currentOverlays[overlay.id] = overlay;
          if (overlay.is_active || overlay.always_on) {
            renderScene(overlay);
          }
        }
      }
      return;
    }

    if (data.type === 'scene-toggle') {
      const overlay = data.overlay;
      currentOverlays[overlay.id] = overlay;
      if (overlay.is_active) {
        renderScene(overlay);
      } else {
        removeScene(overlay.id);
      }
    }

    if (data.type === 'scene-remove') {
      removeScene(data.overlayId);
    }
  };

  evtSource.onerror = () => {
    evtSource.close();
    evtSource = null;
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connectSSE(); }, 5000);
    }
  };
}

function renderScene(overlay) {
  const container = document.getElementById('scene-container');
  removeScene(overlay.id);

  const config = typeof overlay.config === 'string' ? JSON.parse(overlay.config) : overlay.config;
  const el = document.createElement('div');
  el.id = `scene-${overlay.id}`;
  el.className = 'scene-overlay';
  el.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;z-index:10;animation:fadeIn 0.5s ease;';

  // Background
  if (config.bgImage) {
    el.style.backgroundImage = `url(${config.bgImage})`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
  } else if (config.bgType === 'gradient') {
    el.style.background = `linear-gradient(135deg, ${config.bgColor1 || '#1a1a3e'}, ${config.bgColor2 || '#2d1b69'})`;
  } else {
    el.style.backgroundColor = config.bgColor || config.bgColor1 || '#1a1a3e';
  }

  if (config.font && config.font !== 'System Default') {
    el.style.fontFamily = config.font;
  }

  if (overlay.template === 'centered-text') {
    renderCenteredText(el, config);
  } else if (overlay.template === 'split-layout') {
    renderSplitLayout(el, config);
  } else if (overlay.template === 'full-image') {
    renderFullImage(el, config);
  }

  container.appendChild(el);

  if (config.showCountdown && config.countdownMinutes > 0) {
    startCountdown(el, config.countdownMinutes);
  }
}

function renderCenteredText(el, config) {
  const heading = document.createElement('div');
  heading.textContent = config.heading || '';
  heading.style.cssText = `font-size:4rem;font-weight:700;color:${config.textColor || '#fff'};letter-spacing:3px;text-align:center;`;
  el.appendChild(heading);

  if (config.subtext) {
    const sub = document.createElement('div');
    sub.textContent = config.subtext;
    sub.style.cssText = `font-size:1.5rem;color:${config.textColor || '#fff'};opacity:0.8;margin-top:0.5rem;text-align:center;`;
    el.appendChild(sub);
  }

  if (config.showCountdown) {
    const timer = document.createElement('div');
    timer.className = 'countdown-timer';
    timer.style.cssText = `font-size:2.5rem;color:${config.textColor || '#fff'};margin-top:1.5rem;font-weight:600;`;
    el.appendChild(timer);
  }
}

function renderSplitLayout(el, config) {
  el.style.flexDirection = 'row';
  el.style.justifyContent = 'center';
  el.style.gap = '3rem';
  el.style.padding = '2rem';

  const imgSide = config.imageSide || 'left';

  const imgDiv = document.createElement('div');
  imgDiv.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;max-width:45%;';
  if (config.image) {
    const img = document.createElement('img');
    img.src = config.image;
    img.style.cssText = 'max-width:100%;max-height:80vh;object-fit:contain;border-radius:12px;';
    imgDiv.appendChild(img);
  }

  const textDiv = document.createElement('div');
  textDiv.style.cssText = `flex:1;display:flex;flex-direction:column;justify-content:center;align-items:${imgSide === 'left' ? 'flex-start' : 'flex-end'};max-width:45%;`;

  const heading = document.createElement('div');
  heading.textContent = config.heading || '';
  heading.style.cssText = `font-size:3.5rem;font-weight:700;color:${config.textColor || '#fff'};`;
  textDiv.appendChild(heading);

  if (config.subtext) {
    const sub = document.createElement('div');
    sub.textContent = config.subtext;
    sub.style.cssText = `font-size:1.3rem;color:${config.textColor || '#fff'};opacity:0.8;margin-top:0.5rem;`;
    textDiv.appendChild(sub);
  }

  if (config.showCountdown) {
    const timer = document.createElement('div');
    timer.className = 'countdown-timer';
    timer.style.cssText = `font-size:2rem;color:${config.textColor || '#fff'};margin-top:1rem;font-weight:600;`;
    textDiv.appendChild(timer);
  }

  if (imgSide === 'left') {
    el.appendChild(imgDiv);
    el.appendChild(textDiv);
  } else {
    el.appendChild(textDiv);
    el.appendChild(imgDiv);
  }
}

function renderFullImage(el, config) {
  if (config.image) {
    el.style.backgroundImage = `url(${config.image})`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
  }

  if (config.overlayText) {
    const text = document.createElement('div');
    text.textContent = config.overlayText;
    const pos = config.textPosition || 'center';
    let alignSelf = 'center';
    if (pos === 'top') alignSelf = 'flex-start';
    if (pos === 'bottom') alignSelf = 'flex-end';
    text.style.cssText = `font-size:3rem;font-weight:700;color:${config.textColor || '#fff'};text-shadow:0 2px 8px rgba(0,0,0,0.7);align-self:${alignSelf};padding:2rem;`;
    el.appendChild(text);
  }
}

function startCountdown(el, minutes) {
  if (countdownInterval) clearInterval(countdownInterval);
  let remaining = minutes * 60;
  const timerEl = el.querySelector('.countdown-timer');
  if (!timerEl) return;

  function update() {
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    timerEl.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    remaining--;
  }

  update();
  countdownInterval = setInterval(update, 1000);
}

function removeScene(overlayId) {
  const existing = document.getElementById(`scene-${overlayId}`);
  if (existing) {
    existing.style.animation = 'fadeOut 0.5s ease';
    setTimeout(() => existing.remove(), 500);
  }
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

connectSSE();
