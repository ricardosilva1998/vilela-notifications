# Pitwall Full-Screen F1 Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `racing-pitwall.ejs` into a full-screen F1 TV broadcast-style telemetry dashboard with drag-and-drop panel customization.

**Architecture:** Single-file rewrite of the EJS template. No backend changes — the route handler in `src/routes/racing.js:45` still passes `team`, `members`, and `racingUser`. The template becomes a standalone HTML document (no header.ejs/footer.ejs) with inline styles, a timing bar, 9-panel CSS Grid layout, and vanilla JS for drag/resize/WebSocket.

**Tech Stack:** EJS template, CSS Grid, vanilla JS (drag-and-drop, resize, localStorage), WebSocket client, existing Bridge overlay iframes.

**Spec:** `docs/superpowers/specs/2026-04-11-pitwall-fullscreen-f1-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/views/racing-pitwall.ejs` | Rewrite | Full-screen pitwall page — HTML shell, CSS, timing bar, panel grid, drag/drop/resize, WebSocket client |

No other files created or modified.

---

### Task 1: Full-Screen HTML Shell + CSS Variables

**Files:**
- Modify: `src/views/racing-pitwall.ejs` (complete rewrite)

This task replaces the entire file with the standalone HTML document structure — `<head>`, fonts, CSS custom properties, base reset, and an empty `<body>` ready for content.

- [ ] **Step 1: Replace racing-pitwall.ejs with standalone HTML shell**

Replace the entire file content with:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pitwall — <%= team.team_name %> — Atleta</title>
  <link rel="icon" type="image/png" href="/app-icon/honest_graphic-running-athlete-9715727.png">
  <script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=DM+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-base: #0c0d14;
      --bg-surface: #141520;
      --bg-elevated: #1a1b2e;
      --bg-hover: #1f2037;
      --border: rgba(255,255,255,0.06);
      --border-focus: rgba(145,70,255,0.4);
      --text-primary: #e8e6f0;
      --text-secondary: #8b8a9e;
      --text-muted: #5c5b6e;
      --accent: #9146ff;
      --accent-glow: rgba(145,70,255,0.15);
      --accent-hover: #a56bff;
      --success: #3ecf8e;
      --success-bg: rgba(62,207,142,0.1);
      --danger: #f04438;
      --danger-bg: rgba(240,68,56,0.1);
      --warning: #f79009;
      --warning-bg: rgba(247,144,9,0.1);
      --font-display: 'Outfit', sans-serif;
      --font-body: 'DM Sans', sans-serif;
      --transition: 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      --timing-bar-h: 48px;
      --bottom-strip-h: 80px;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; }
    body {
      font-family: var(--font-body);
      background: var(--bg-base);
      color: var(--text-primary);
      -webkit-font-smoothing: antialiased;
    }
    h1,h2,h3,h4,h5,h6 { font-family: var(--font-display); letter-spacing: -0.02em; }
  </style>
</head>
<body>

</body>
</html>
```

- [ ] **Step 2: Verify the page loads**

Run the dev server (`npm run dev`) and navigate to `/racing/pitwall` (must be logged in with a team). Confirm you see a blank dark page with no errors in the console.

- [ ] **Step 3: Commit**

```bash
git add src/views/racing-pitwall.ejs
git commit -m "feat(pitwall): full-screen HTML shell with inline CSS variables"
```

---

### Task 2: Timing Bar

**Files:**
- Modify: `src/views/racing-pitwall.ejs`

Add the timing bar — back button, LIVE badge, driver info, session info, connection dot, driver avatar dots, and gear (edit mode) icon.

- [ ] **Step 1: Add timing bar CSS**

Inside the `<style>` block, after the body styles, add:

```css
/* Timing bar */
.timing-bar {
  position: fixed; top: 0; left: 0; right: 0;
  height: var(--timing-bar-h);
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border);
  display: flex; align-items: center;
  padding: 0 12px; gap: 8px;
  z-index: 100;
  font-family: 'DM Mono', 'SF Mono', 'Fira Code', monospace;
}
.timing-bar .back-btn {
  display: flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; border-radius: 6px;
  background: transparent; border: none; color: var(--text-muted);
  cursor: pointer; transition: all var(--transition);
}
.timing-bar .back-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.timing-bar .live-badge {
  background: #e10600; color: white;
  font-size: 10px; font-weight: 800;
  padding: 3px 8px; border-radius: 2px;
  letter-spacing: 0.5px;
  display: none;
}
.timing-bar .live-badge.active { display: inline-block; }
.timing-bar .driver-info {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px;
}
.timing-bar .driver-info .pos-badge {
  background: var(--accent); color: white;
  font-weight: 800; font-size: 11px;
  padding: 2px 8px; border-radius: 2px;
}
.timing-bar .driver-info .driver-name {
  color: var(--text-primary); font-weight: 700; font-size: 13px;
}
.timing-bar .driver-info .lap-time {
  color: var(--success); font-size: 12px;
}
.timing-bar .session-info {
  display: flex; align-items: center; gap: 8px;
  font-size: 11px; color: var(--text-muted);
}
.timing-bar .session-info span {
  background: var(--bg-elevated);
  padding: 3px 8px; border-radius: 2px;
}
.timing-bar .spacer { flex: 1; }
.timing-bar .ws-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--text-muted);
  transition: background var(--transition);
  flex-shrink: 0;
}
.timing-bar .driver-dots {
  display: flex; align-items: center; gap: 4px;
  margin-left: 8px;
}
.timing-bar .driver-dot {
  width: 28px; height: 28px; border-radius: 50%;
  background: var(--bg-elevated);
  border: 2px solid var(--text-muted);
  display: flex; align-items: center; justify-content: center;
  font-size: 9px; font-weight: 700; color: var(--text-muted);
  cursor: pointer; transition: all var(--transition);
  font-family: var(--font-display);
  position: relative;
}
.timing-bar .driver-dot.online { border-color: var(--success); color: var(--success); }
.timing-bar .driver-dot.selected { background: var(--accent); border-color: var(--accent); color: white; }
.timing-bar .driver-dot.self { opacity: 0.4; cursor: default; }
.timing-bar .driver-dot:not(.self):hover { transform: scale(1.1); }
.timing-bar .driver-dot .tooltip {
  display: none; position: absolute; bottom: -30px; left: 50%; transform: translateX(-50%);
  background: var(--bg-elevated); border: 1px solid var(--border);
  padding: 3px 8px; border-radius: 4px; font-size: 10px; color: var(--text-secondary);
  white-space: nowrap; pointer-events: none; z-index: 200;
}
.timing-bar .driver-dot:hover .tooltip { display: block; }
.timing-bar .edit-btn {
  display: flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; border-radius: 6px;
  background: transparent; border: none; color: var(--text-muted);
  cursor: pointer; transition: all var(--transition);
  margin-left: 4px;
}
.timing-bar .edit-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.timing-bar .edit-btn.active { color: var(--accent); background: var(--accent-glow); }
```

- [ ] **Step 2: Add timing bar HTML**

Inside `<body>`, add:

```html
<div class="timing-bar">
  <button class="back-btn" onclick="location.href='/racing/teams'" title="Back to teams">
    <i data-lucide="arrow-left" style="width:18px;height:18px;"></i>
  </button>
  <span id="live-badge" class="live-badge">LIVE</span>
  <div class="driver-info">
    <span id="pos-badge" class="pos-badge" style="display:none;"></span>
    <span id="driver-name" class="driver-name" style="color:var(--text-muted);">Select a driver</span>
    <span id="lap-time" class="lap-time"></span>
  </div>
  <div id="session-info" class="session-info"></div>
  <div class="spacer"></div>
  <div id="ws-dot" class="ws-dot" title="Connecting..."></div>
  <div class="driver-dots">
    <% members.forEach(function(m) { %>
      <div class="driver-dot<%= m.user_id === racingUser.id ? ' self' : '' %>"
           data-user-id="<%= m.user_id %>"
           data-name="<%= (m.display_name || m.username).replace(/"/g, '&quot;') %>"
           <% if (m.user_id !== racingUser.id) { %>onclick="selectDriver(<%= m.user_id %>, this.dataset.name)"<% } %>
           title="<%= m.display_name || m.username %>">
        <%= (m.display_name || m.username).substring(0, 2).toUpperCase() %>
        <span class="tooltip"><%= m.display_name || m.username %><%= m.user_id === racingUser.id ? ' (You)' : '' %></span>
      </div>
    <% }); %>
  </div>
  <button id="edit-btn" class="edit-btn" onclick="toggleEditMode()" title="Customize layout">
    <i data-lucide="settings" style="width:16px;height:16px;"></i>
  </button>
</div>
```

- [ ] **Step 3: Add Lucide icon initialization**

At the bottom of `<body>`, add:

```html
<script>lucide.createIcons();</script>
```

- [ ] **Step 4: Verify timing bar renders**

Refresh the page. Confirm the timing bar is visible at the top with the back arrow, "Select a driver" text, driver dots (initials), gear icon, and connection dot.

- [ ] **Step 5: Commit**

```bash
git add src/views/racing-pitwall.ejs
git commit -m "feat(pitwall): timing bar with driver dots, LIVE badge, and edit toggle"
```

---

### Task 3: Default Panel Grid Layout

**Files:**
- Modify: `src/views/racing-pitwall.ejs`

Add the 9-panel CSS Grid layout below the timing bar with placeholder content.

- [ ] **Step 1: Add panel grid CSS**

Inside the `<style>` block, add:

```css
/* Panel grid */
.pitwall-grid {
  position: fixed;
  top: var(--timing-bar-h);
  left: 0; right: 0;
  bottom: var(--bottom-strip-h);
  display: grid;
  grid-template-columns: 2.5fr 1fr 1fr 1.5fr;
  grid-template-rows: 1fr 1fr;
  gap: 1px;
  background: var(--border);
}
.pitwall-strip {
  position: fixed;
  bottom: 0; left: 0; right: 0;
  height: var(--bottom-strip-h);
  display: grid;
  grid-template-columns: 1fr 2.5fr;
  gap: 1px;
  background: var(--border);
}
.panel {
  background: var(--bg-base);
  position: relative;
  overflow: hidden;
  min-width: 0;
  min-height: 0;
}
.panel .panel-label {
  position: absolute; top: 6px; left: 8px;
  font-size: 9px; text-transform: uppercase;
  letter-spacing: 0.5px; color: var(--text-muted);
  font-weight: 600; z-index: 2;
  pointer-events: none;
}
.panel iframe {
  width: 100%; height: 100%;
  border: none; background: transparent;
  display: none;
}
.panel .placeholder {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  color: rgba(255,255,255,0.12); font-size: 12px;
}
/* Grid area assignments — default layout */
.panel[data-panel="standings"]    { grid-area: 1 / 1 / 3 / 2; }
.panel[data-panel="relative"]     { grid-area: 1 / 2 / 2 / 4; }
.panel[data-panel="fuel"]         { grid-area: 2 / 2 / 3 / 3; }
.panel[data-panel="raceduration"] { grid-area: 2 / 3 / 3 / 4; }
.panel[data-panel="trackmap"]     { grid-area: 1 / 4 / 2 / 5; }
.panel[data-panel="weather"]      { grid-area: 2 / 4 / 3 / 4; }
.panel[data-panel="wind"]         { grid-area: 2 / 4 / 3 / 5; }
/* Fix: weather and wind share right-bottom — use sub-grid or split column 4 */
```

**Note:** Weather and Wind need to sit side-by-side in the bottom-right. We need to split column 4 into two sub-columns for the bottom row. Revised approach — use a 6-column grid:

Replace the `.pitwall-grid` and grid area rules with:

```css
.pitwall-grid {
  position: fixed;
  top: var(--timing-bar-h);
  left: 0; right: 0;
  bottom: var(--bottom-strip-h);
  display: grid;
  grid-template-columns: 5fr 2fr 2fr 1.5fr 1.5fr;
  grid-template-rows: 3fr 2fr;
  gap: 1px;
  background: var(--border);
}
.panel[data-panel="standings"]    { grid-column: 1; grid-row: 1 / 3; }
.panel[data-panel="relative"]     { grid-column: 2 / 4; grid-row: 1; }
.panel[data-panel="fuel"]         { grid-column: 2; grid-row: 2; }
.panel[data-panel="raceduration"] { grid-column: 3; grid-row: 2; }
.panel[data-panel="trackmap"]     { grid-column: 4 / 6; grid-row: 1; }
.panel[data-panel="weather"]      { grid-column: 4; grid-row: 2; }
.panel[data-panel="wind"]         { grid-column: 5; grid-row: 2; }
```

- [ ] **Step 2: Add panel HTML**

After the timing bar `</div>`, add:

```html
<div class="pitwall-grid" id="pitwall-grid">
  <% var panels = [
    { id: 'standings', label: 'Standings' },
    { id: 'relative', label: 'Relative' },
    { id: 'fuel', label: 'Fuel' },
    { id: 'raceduration', label: 'Race Duration' },
    { id: 'trackmap', label: 'Track Map' },
    { id: 'weather', label: 'Weather' },
    { id: 'wind', label: 'Wind' },
  ]; panels.forEach(function(p) { %>
    <div class="panel" data-panel="<%= p.id %>">
      <div class="panel-label"><%= p.label %></div>
      <div class="placeholder" id="placeholder-<%= p.id %>">Waiting for driver...</div>
      <iframe id="iframe-<%= p.id %>" loading="lazy"></iframe>
    </div>
  <% }); %>
</div>

<div class="pitwall-strip" id="pitwall-strip">
  <div class="panel" data-panel="inputs">
    <div class="panel-label">Inputs</div>
    <div class="placeholder" id="placeholder-inputs">Waiting for driver...</div>
    <iframe id="iframe-inputs" loading="lazy"></iframe>
  </div>
  <div class="panel" data-panel="stintlaps">
    <div class="panel-label">Session Laps</div>
    <div class="placeholder" id="placeholder-stintlaps">Waiting for driver...</div>
    <iframe id="iframe-stintlaps" loading="lazy"></iframe>
  </div>
</div>
```

- [ ] **Step 3: Verify the grid renders**

Refresh the page. Confirm 7 panels in the main grid (Standings tall on left, Relative + Track Map top, Fuel + Duration + Weather + Wind bottom) and 2 panels in the bottom strip (Inputs left, Session Laps right). All should show "Waiting for driver..." text.

- [ ] **Step 4: Commit**

```bash
git add src/views/racing-pitwall.ejs
git commit -m "feat(pitwall): 9-panel CSS Grid layout with default F1 arrangement"
```

---

### Task 4: WebSocket Client + Driver Selection

**Files:**
- Modify: `src/views/racing-pitwall.ejs`

Port the WebSocket connection logic from the old template and wire up driver selection via timing bar dots.

- [ ] **Step 1: Add WebSocket + driver selection JS**

Before the `</body>` tag (after the Lucide script), add:

```html
<script>
(function() {
  var WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/pitwall';
  var OVERLAY_BASE = '/pitwall/overlays';
  var ALL_CHANNELS = ['standings', 'relative', 'fuel', 'wind', 'trackmap', 'inputs', 'session'];
  var OVERLAY_MAP = {
    standings: 'standings.html',
    relative: 'relative.html',
    fuel: 'fuel.html',
    inputs: 'inputs.html',
    trackmap: 'trackmap.html',
    weather: 'weather.html',
    wind: 'wind.html',
    stintlaps: 'stintlaps.html',
    raceduration: 'raceduration.html',
  };

  var ws = null;
  var reconnectTimer = null;
  var selectedDriverId = null;
  var onlineDrivers = new Set();

  function connect() {
    setStatus('connecting');
    ws = new WebSocket(WS_URL);

    ws.onopen = function() {
      setStatus('connected');
      if (selectedDriverId) {
        ws.send(JSON.stringify({ type: 'subscribe', channels: ALL_CHANNELS, driverId: selectedDriverId }));
      }
    };

    ws.onmessage = function(e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'auth-ok') {
        (msg.activeDrivers || []).forEach(function(d) { onlineDrivers.add(d.userId); });
        updateDriverDots();
      } else if (msg.type === 'driver-online') {
        onlineDrivers.add(msg.userId);
        updateDriverDots();
      } else if (msg.type === 'driver-offline') {
        onlineDrivers.delete(msg.userId);
        updateDriverDots();
      }
    };

    ws.onclose = function() {
      setStatus('disconnected');
      scheduleReconnect();
    };

    ws.onerror = function() { ws.close(); };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function() {
      reconnectTimer = null;
      connect();
    }, 3000);
  }

  function setStatus(state) {
    var dot = document.getElementById('ws-dot');
    if (state === 'connected') { dot.style.background = 'var(--success)'; dot.title = 'Connected'; }
    else if (state === 'connecting') { dot.style.background = 'var(--warning)'; dot.title = 'Connecting...'; }
    else if (state === 'disconnected') { dot.style.background = 'var(--text-muted)'; dot.title = 'Reconnecting...'; }
    else if (state === 'error') { dot.style.background = 'var(--danger)'; dot.title = 'Auth failed'; }
  }

  function updateDriverDots() {
    document.querySelectorAll('.driver-dot').forEach(function(el) {
      var uid = parseInt(el.dataset.userId);
      el.classList.toggle('online', onlineDrivers.has(uid));
    });
  }

  function loadOverlayIframes(driverId) {
    var wsParam = encodeURIComponent(WS_URL);
    for (var key in OVERLAY_MAP) {
      var iframe = document.getElementById('iframe-' + key);
      var placeholder = document.getElementById('placeholder-' + key);
      if (iframe) {
        iframe.src = OVERLAY_BASE + '/' + OVERLAY_MAP[key] + '?ws=' + wsParam + '&driver=' + driverId;
        iframe.style.display = 'block';
      }
      if (placeholder) placeholder.style.display = 'none';
    }
  }

  function clearOverlayIframes() {
    for (var key in OVERLAY_MAP) {
      var iframe = document.getElementById('iframe-' + key);
      var placeholder = document.getElementById('placeholder-' + key);
      if (iframe) { iframe.src = 'about:blank'; iframe.style.display = 'none'; }
      if (placeholder) placeholder.style.display = 'flex';
    }
  }

  window.selectDriver = function(userId, name) {
    if (selectedDriverId === userId) {
      // Deselect if clicking same driver
      window.deselectDriver();
      return;
    }
    selectedDriverId = userId;
    document.getElementById('driver-name').textContent = name;
    document.getElementById('driver-name').style.color = '';
    document.getElementById('live-badge').classList.add('active');

    // Highlight selected dot
    document.querySelectorAll('.driver-dot').forEach(function(el) {
      el.classList.toggle('selected', parseInt(el.dataset.userId) === userId);
    });

    loadOverlayIframes(userId);

    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'subscribe', channels: ALL_CHANNELS, driverId: userId }));
    }
  };

  window.deselectDriver = function() {
    selectedDriverId = null;
    document.getElementById('driver-name').textContent = 'Select a driver';
    document.getElementById('driver-name').style.color = 'var(--text-muted)';
    document.getElementById('live-badge').classList.remove('active');
    document.getElementById('pos-badge').style.display = 'none';
    document.getElementById('lap-time').textContent = '';
    document.getElementById('session-info').innerHTML = '';
    document.querySelectorAll('.driver-dot').forEach(function(el) {
      el.classList.remove('selected');
    });
    clearOverlayIframes();
  };

  // ESC key: back to teams (if not in edit mode)
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      if (document.body.classList.contains('edit-mode')) {
        toggleEditMode();
      } else {
        location.href = '/racing/teams';
      }
    }
  });

  // Placeholder for edit mode toggle (implemented in Task 5)
  window.toggleEditMode = function() {
    document.body.classList.toggle('edit-mode');
    document.getElementById('edit-btn').classList.toggle('active');
  };

  connect();
})();
</script>
```

- [ ] **Step 2: Verify driver selection works**

1. Open the pitwall page
2. Click a driver dot (must have a teammate with Bridge running, or just verify the dot highlights and iframes attempt to load)
3. Click the same dot again to deselect
4. Press ESC to verify it navigates back

- [ ] **Step 3: Commit**

```bash
git add src/views/racing-pitwall.ejs
git commit -m "feat(pitwall): WebSocket client + driver selection via timing bar dots"
```

---

### Task 5: Drag-and-Drop Panel Rearrangement

**Files:**
- Modify: `src/views/racing-pitwall.ejs`

Add edit mode with drag-to-swap panel rearrangement and a reset button.

- [ ] **Step 1: Add edit mode CSS**

Inside the `<style>` block, add:

```css
/* Edit mode */
body.edit-mode .panel {
  outline: 1px solid transparent;
  transition: outline var(--transition);
}
body.edit-mode .panel:hover {
  outline: 1px solid var(--accent);
}
body.edit-mode .panel .panel-label {
  cursor: grab; pointer-events: auto;
  background: rgba(145,70,255,0.15);
  padding: 2px 6px; border-radius: 3px;
  user-select: none;
}
body.edit-mode .panel .panel-label:active { cursor: grabbing; }
.drag-ghost {
  position: fixed; pointer-events: none; z-index: 999;
  background: rgba(145,70,255,0.2); border: 2px solid var(--accent);
  border-radius: 6px; display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; color: var(--accent);
  font-family: var(--font-display);
}
.panel.drag-over {
  outline: 2px solid var(--accent) !important;
  background: rgba(145,70,255,0.05);
}
.reset-layout-btn {
  position: fixed; bottom: calc(var(--bottom-strip-h) + 8px); right: 12px;
  background: var(--bg-elevated); border: 1px solid var(--border);
  color: var(--text-secondary); font-size: 11px; font-family: var(--font-body);
  padding: 6px 12px; border-radius: 6px; cursor: pointer;
  z-index: 101; display: none;
  transition: all var(--transition);
}
.reset-layout-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
body.edit-mode .reset-layout-btn { display: block; }
```

- [ ] **Step 2: Add reset button HTML**

After the pitwall-strip div, add:

```html
<button class="reset-layout-btn" onclick="resetLayout()">Reset layout</button>
```

- [ ] **Step 3: Add drag-and-drop JS**

Inside the `(function() { ... })()` script block, replace the `window.toggleEditMode` placeholder and add the full drag/drop + layout persistence logic. Add this code before `connect();`:

```javascript
  // ── Layout persistence ──────────────────────────────────────────
  var STORAGE_KEY = 'pitwall-layout-v1';
  var DEFAULT_GRID_PANELS = ['standings', 'relative', 'fuel', 'raceduration', 'trackmap', 'weather', 'wind'];
  var DEFAULT_STRIP_PANELS = ['inputs', 'stintlaps'];

  function getDefaultLayout() {
    return {
      grid: DEFAULT_GRID_PANELS.slice(),
      strip: DEFAULT_STRIP_PANELS.slice(),
      version: 1
    };
  }

  function loadLayout() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && saved.version === 1 && saved.grid && saved.strip) return saved;
    } catch(e) {}
    return getDefaultLayout();
  }

  function saveLayout(layout) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  }

  function applyLayout(layout) {
    var gridContainer = document.getElementById('pitwall-grid');
    var stripContainer = document.getElementById('pitwall-strip');
    // Re-order grid panels
    layout.grid.forEach(function(panelId) {
      var el = gridContainer.querySelector('[data-panel="' + panelId + '"]');
      if (el) gridContainer.appendChild(el);
    });
    // Re-order strip panels
    layout.strip.forEach(function(panelId) {
      var el = stripContainer.querySelector('[data-panel="' + panelId + '"]');
      if (el) stripContainer.appendChild(el);
    });
    // Update CSS grid-area based on position in DOM
    updateGridAreas();
  }

  // Map default CSS grid areas by position index in grid
  var GRID_AREAS = [
    'grid-column: 1; grid-row: 1 / 3;',      // slot 0: full-height left (standings)
    'grid-column: 2 / 4; grid-row: 1;',        // slot 1: top-middle span (relative)
    'grid-column: 2; grid-row: 2;',             // slot 2: bottom-middle-left (fuel)
    'grid-column: 3; grid-row: 2;',             // slot 3: bottom-middle-right (raceduration)
    'grid-column: 4 / 6; grid-row: 1;',        // slot 4: top-right span (trackmap)
    'grid-column: 4; grid-row: 2;',             // slot 5: bottom-right-left (weather)
    'grid-column: 5; grid-row: 2;',             // slot 6: bottom-right-right (wind)
  ];

  function updateGridAreas() {
    var gridPanels = document.getElementById('pitwall-grid').querySelectorAll('.panel');
    gridPanels.forEach(function(el, i) {
      if (GRID_AREAS[i]) el.style.cssText = GRID_AREAS[i];
    });
  }

  function getCurrentLayout() {
    var grid = [];
    document.getElementById('pitwall-grid').querySelectorAll('.panel').forEach(function(el) {
      grid.push(el.dataset.panel);
    });
    var strip = [];
    document.getElementById('pitwall-strip').querySelectorAll('.panel').forEach(function(el) {
      strip.push(el.dataset.panel);
    });
    return { grid: grid, strip: strip, version: 1 };
  }

  // Apply saved layout on load
  applyLayout(loadLayout());

  // ── Drag and drop ───────────────────────────────────────────────
  var dragSource = null;
  var dragGhost = null;

  document.addEventListener('mousedown', function(e) {
    if (!document.body.classList.contains('edit-mode')) return;
    var label = e.target.closest('.panel-label');
    if (!label) return;
    var panel = label.closest('.panel');
    if (!panel) return;
    e.preventDefault();
    dragSource = panel;

    // Create ghost
    dragGhost = document.createElement('div');
    dragGhost.className = 'drag-ghost';
    dragGhost.textContent = label.textContent;
    dragGhost.style.width = '120px';
    dragGhost.style.height = '40px';
    dragGhost.style.left = e.clientX - 60 + 'px';
    dragGhost.style.top = e.clientY - 20 + 'px';
    document.body.appendChild(dragGhost);

    panel.style.opacity = '0.4';
  });

  document.addEventListener('mousemove', function(e) {
    if (!dragGhost) return;
    dragGhost.style.left = e.clientX - 60 + 'px';
    dragGhost.style.top = e.clientY - 20 + 'px';

    // Highlight drop target
    document.querySelectorAll('.panel.drag-over').forEach(function(el) { el.classList.remove('drag-over'); });
    var target = document.elementFromPoint(e.clientX, e.clientY);
    if (target) {
      var targetPanel = target.closest('.panel');
      if (targetPanel && targetPanel !== dragSource) {
        targetPanel.classList.add('drag-over');
      }
    }
  });

  document.addEventListener('mouseup', function(e) {
    if (!dragGhost || !dragSource) {
      cleanupDrag();
      return;
    }

    document.querySelectorAll('.panel.drag-over').forEach(function(el) { el.classList.remove('drag-over'); });
    var target = document.elementFromPoint(e.clientX, e.clientY);
    var targetPanel = target ? target.closest('.panel') : null;

    if (targetPanel && targetPanel !== dragSource) {
      // Swap panels in the DOM
      var sourceParent = dragSource.parentNode;
      var targetParent = targetPanel.parentNode;

      if (sourceParent === targetParent) {
        // Same container — swap positions
        var sourceNext = dragSource.nextElementSibling;
        var targetNext = targetPanel.nextElementSibling;
        if (sourceNext === targetPanel) {
          sourceParent.insertBefore(targetPanel, dragSource);
        } else if (targetNext === dragSource) {
          sourceParent.insertBefore(dragSource, targetPanel);
        } else {
          sourceParent.insertBefore(dragSource, targetNext);
          sourceParent.insertBefore(targetPanel, sourceNext);
        }
      } else {
        // Different containers (grid <-> strip) — swap across
        var sourcePlaceholder = document.createComment('swap');
        sourceParent.insertBefore(sourcePlaceholder, dragSource);
        targetParent.insertBefore(dragSource, targetPanel);
        sourceParent.insertBefore(targetPanel, sourcePlaceholder);
        sourceParent.removeChild(sourcePlaceholder);
      }

      updateGridAreas();
      saveLayout(getCurrentLayout());
    }

    cleanupDrag();
  });

  function cleanupDrag() {
    if (dragGhost) { dragGhost.remove(); dragGhost = null; }
    if (dragSource) { dragSource.style.opacity = ''; dragSource = null; }
  }

  // ── Edit mode toggle ───────────────────────────────────────────
  window.toggleEditMode = function() {
    document.body.classList.toggle('edit-mode');
    document.getElementById('edit-btn').classList.toggle('active');
  };

  window.resetLayout = function() {
    localStorage.removeItem(STORAGE_KEY);
    applyLayout(getDefaultLayout());
  };
```

- [ ] **Step 4: Verify drag-and-drop works**

1. Click the gear icon — panels should get purple label highlights
2. Drag a panel label to another panel — they should swap
3. Refresh the page — swapped layout should persist
4. Click "Reset layout" — should return to defaults
5. Press ESC in edit mode — should exit edit mode, not navigate away

- [ ] **Step 5: Commit**

```bash
git add src/views/racing-pitwall.ejs
git commit -m "feat(pitwall): drag-and-drop panel rearrangement with localStorage persistence"
```

---

### Task 6: Panel Edge Resizing

**Files:**
- Modify: `src/views/racing-pitwall.ejs`

Add drag-to-resize on panel borders (column and row ratios).

- [ ] **Step 1: Add resize CSS**

Inside the `<style>` block, add:

```css
/* Resize handles */
.resize-handle {
  position: absolute; z-index: 50;
  background: transparent;
}
.resize-handle.col {
  width: 7px; top: 0; bottom: 0;
  cursor: col-resize;
  margin-left: -3px;
}
.resize-handle.row {
  height: 7px; left: 0; right: 0;
  cursor: row-resize;
  margin-top: -3px;
}
body.edit-mode .resize-handle:hover,
body.edit-mode .resize-handle.active {
  background: rgba(145,70,255,0.3);
}
```

- [ ] **Step 2: Add resize JS**

Inside the script block, after the drag-and-drop code and before `connect();`, add:

```javascript
  // ── Column/row resizing ─────────────────────────────────────────
  var STORAGE_RATIOS_KEY = 'pitwall-ratios-v1';

  var defaultRatios = {
    cols: [5, 2, 2, 1.5, 1.5],
    rows: [3, 2],
    stripCols: [1, 2.5],
  };

  function loadRatios() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_RATIOS_KEY));
      if (saved && saved.cols) return saved;
    } catch(e) {}
    return JSON.parse(JSON.stringify(defaultRatios));
  }

  function saveRatios(ratios) {
    localStorage.setItem(STORAGE_RATIOS_KEY, JSON.stringify(ratios));
  }

  function applyRatios(ratios) {
    var grid = document.getElementById('pitwall-grid');
    var strip = document.getElementById('pitwall-strip');
    grid.style.gridTemplateColumns = ratios.cols.map(function(r) { return r + 'fr'; }).join(' ');
    grid.style.gridTemplateRows = ratios.rows.map(function(r) { return r + 'fr'; }).join(' ');
    strip.style.gridTemplateColumns = ratios.stripCols.map(function(r) { return r + 'fr'; }).join(' ');
  }

  var currentRatios = loadRatios();
  applyRatios(currentRatios);

  // Resize via dragging grid gap areas
  var resizing = null;

  document.getElementById('pitwall-grid').addEventListener('mousedown', function(e) {
    if (!document.body.classList.contains('edit-mode')) return;
    // Detect if click is near a grid gap (between panels)
    var grid = document.getElementById('pitwall-grid');
    var rect = grid.getBoundingClientRect();
    var panels = grid.querySelectorAll('.panel');
    var edges = [];

    // Collect right edges of panels for column detection
    panels.forEach(function(p) {
      var pr = p.getBoundingClientRect();
      // Right edge
      if (Math.abs(e.clientX - pr.right) < 5 && e.clientY >= pr.top && e.clientY <= pr.bottom) {
        edges.push({ type: 'col', x: pr.right, panel: p });
      }
      // Bottom edge
      if (Math.abs(e.clientY - pr.bottom) < 5 && e.clientX >= pr.left && e.clientX <= pr.right) {
        edges.push({ type: 'row', y: pr.bottom, panel: p });
      }
    });

    if (edges.length === 0) return;
    var edge = edges[0];

    if (edge.type === 'col') {
      // Figure out which column boundary this is
      var colSizes = [];
      var totalW = rect.width;
      var sumFr = currentRatios.cols.reduce(function(a,b) { return a+b; }, 0);
      var acc = rect.left;
      var colIdx = -1;
      for (var i = 0; i < currentRatios.cols.length; i++) {
        acc += (currentRatios.cols[i] / sumFr) * totalW;
        if (Math.abs(e.clientX - acc) < 8) { colIdx = i; break; }
      }
      if (colIdx < 0 || colIdx >= currentRatios.cols.length - 1) return;

      e.preventDefault();
      resizing = { type: 'col', idx: colIdx, startX: e.clientX, startRatios: currentRatios.cols.slice() };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    } else {
      // Row boundary
      var totalH = rect.height;
      var sumFrR = currentRatios.rows.reduce(function(a,b) { return a+b; }, 0);
      var accR = rect.top;
      var rowIdx = -1;
      for (var j = 0; j < currentRatios.rows.length; j++) {
        accR += (currentRatios.rows[j] / sumFrR) * totalH;
        if (Math.abs(e.clientY - accR) < 8) { rowIdx = j; break; }
      }
      if (rowIdx < 0 || rowIdx >= currentRatios.rows.length - 1) return;

      e.preventDefault();
      resizing = { type: 'row', idx: rowIdx, startY: e.clientY, startRatios: currentRatios.rows.slice() };
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    }
  });

  document.addEventListener('mousemove', function(e) {
    if (!resizing) return;
    var grid = document.getElementById('pitwall-grid');
    var rect = grid.getBoundingClientRect();

    if (resizing.type === 'col') {
      var dx = e.clientX - resizing.startX;
      var totalW = rect.width;
      var sumFr = resizing.startRatios.reduce(function(a,b) { return a+b; }, 0);
      var frPerPx = sumFr / totalW;
      var delta = dx * frPerPx;
      var newLeft = resizing.startRatios[resizing.idx] + delta;
      var newRight = resizing.startRatios[resizing.idx + 1] - delta;
      // Min 0.5fr
      if (newLeft < 0.5 || newRight < 0.5) return;
      currentRatios.cols[resizing.idx] = Math.round(newLeft * 100) / 100;
      currentRatios.cols[resizing.idx + 1] = Math.round(newRight * 100) / 100;
      applyRatios(currentRatios);
    } else {
      var dy = e.clientY - resizing.startY;
      var totalH = rect.height;
      var sumFrR = resizing.startRatios.reduce(function(a,b) { return a+b; }, 0);
      var frPerPxR = sumFrR / totalH;
      var deltaR = dy * frPerPxR;
      var newTop = resizing.startRatios[resizing.idx] + deltaR;
      var newBottom = resizing.startRatios[resizing.idx + 1] - deltaR;
      if (newTop < 0.5 || newBottom < 0.5) return;
      currentRatios.rows[resizing.idx] = Math.round(newTop * 100) / 100;
      currentRatios.rows[resizing.idx + 1] = Math.round(newBottom * 100) / 100;
      applyRatios(currentRatios);
    }
  });

  document.addEventListener('mouseup', function() {
    if (resizing) {
      resizing = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      saveRatios(currentRatios);
    }
  });

  // Update resetLayout to also reset ratios
  var _origResetLayout = window.resetLayout;
  window.resetLayout = function() {
    _origResetLayout();
    localStorage.removeItem(STORAGE_RATIOS_KEY);
    currentRatios = JSON.parse(JSON.stringify(defaultRatios));
    applyRatios(currentRatios);
  };
```

- [ ] **Step 2: Verify resizing works**

1. Enter edit mode (gear icon)
2. Hover near the border between two panels — cursor should change to col-resize or row-resize
3. Drag the border — panels should resize proportionally
4. Refresh — ratios should persist
5. Click "Reset layout" — ratios should return to default

- [ ] **Step 3: Commit**

```bash
git add src/views/racing-pitwall.ejs
git commit -m "feat(pitwall): drag-to-resize panel borders with ratio persistence"
```

---

### Task 7: Final Polish + Route Verification

**Files:**
- Modify: `src/views/racing-pitwall.ejs`

Final touches: ensure the route still works correctly, add a subtle transition when entering/exiting edit mode, and verify everything end-to-end.

- [ ] **Step 1: Add page transition polish CSS**

Inside the `<style>` block, add:

```css
/* Smooth transitions */
.pitwall-grid, .pitwall-strip {
  transition: grid-template-columns 0.2s ease, grid-template-rows 0.2s ease;
}
/* Edit mode indicator bar */
body.edit-mode::after {
  content: 'EDIT MODE — Drag panels to rearrange, drag borders to resize';
  position: fixed; top: var(--timing-bar-h); left: 0; right: 0;
  background: rgba(145,70,255,0.15); color: var(--accent);
  font-size: 10px; font-weight: 600; text-align: center;
  padding: 4px 0; z-index: 99;
  font-family: var(--font-body);
  letter-spacing: 0.3px;
}
body.edit-mode .pitwall-grid { top: calc(var(--timing-bar-h) + 24px); }
```

- [ ] **Step 2: Verify the route handler is compatible**

Check that the route at `src/routes/racing.js:45` still passes all needed variables. The template uses:
- `team.team_name` — from `membership` object (has `team_name` from JOIN)
- `members` — array from `getTeamMembers()`
- `racingUser.id` — from session
- `streamer` — passed but not used in new template (safe to ignore)

No route changes needed.

- [ ] **Step 3: Full end-to-end verification**

1. Navigate to `/racing/pitwall` — full-screen dark page loads
2. Timing bar shows: back arrow, "Select a driver", driver dots, gear icon, connection dot
3. Click a driver dot — LIVE badge appears, iframes load, dot highlights
4. Click same dot — deselects, placeholders return
5. Enter edit mode — purple labels, "EDIT MODE" banner
6. Drag a panel label to swap — panels swap positions
7. Drag a border — panels resize
8. Refresh — layout + ratios persist
9. "Reset layout" — returns to default
10. ESC in edit mode — exits edit mode
11. ESC outside edit mode — navigates to `/racing/teams`

- [ ] **Step 4: Commit**

```bash
git add src/views/racing-pitwall.ejs
git commit -m "feat(pitwall): polish edit mode indicator, transitions, end-to-end verification"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Full-screen HTML shell + CSS variables | racing-pitwall.ejs |
| 2 | Timing bar with driver dots + LIVE badge | racing-pitwall.ejs |
| 3 | Default 9-panel CSS Grid layout | racing-pitwall.ejs |
| 4 | WebSocket client + driver selection | racing-pitwall.ejs |
| 5 | Drag-and-drop panel rearrangement | racing-pitwall.ejs |
| 6 | Panel edge resizing | racing-pitwall.ejs |
| 7 | Polish + route verification | racing-pitwall.ejs |

All 7 tasks modify a single file. No backend, route, database, or overlay changes.
