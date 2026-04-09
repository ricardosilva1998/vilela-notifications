# WebSocket Per-Client Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-WebSocket-client message logging so each connected overlay can be clicked in the Logs tab to view, copy, or clear its individual message history.

**Architecture:** Extend `websocket.js` to assign each client an auto-incrementing ID, friendly name (derived from subscribed channels), and an in-memory message log (capped at 500 entries). Expose client list + logs via IPC handlers in `main.js`. Redesign the control-panel Logs tab with a two-column layout: client list on the left, log viewer on the right. The existing global file-based "All Logs" view is preserved as the default selection.

**Tech Stack:** Electron IPC, ws (WebSocket), existing control-panel HTML/CSS/JS

---

### Task 1: Add per-client tracking to websocket.js

**Files:**
- Modify: `bridge/websocket.js`

- [ ] **Step 1: Add client ID counter and per-client metadata to websocket.js**

Replace the entire `bridge/websocket.js` with the updated version that adds client IDs, friendly names, connect timestamps, and per-client message logs:

```javascript
'use strict';

const { WebSocketServer } = require('ws');
let wss = null;
const clients = new Map();
let currentIracingStatus = false;
let selectedCarIdx = null;
let nextClientId = 1;
const MAX_LOG_ENTRIES = 500;

// Per-client metadata stored separately keyed by clientId
const clientLogs = new Map();

function startServer(port) {
  wss = new WebSocketServer({ port });
  console.log(`[WebSocket] Server started on ws://localhost:${port}`);

  wss.on('connection', (ws) => {
    const clientId = nextClientId++;
    const meta = { id: clientId, channels: new Set(), connectedAt: Date.now(), name: 'Client #' + clientId };
    clients.set(ws, meta);
    clientLogs.set(clientId, []);
    console.log('[WebSocket] Client connected (id: ' + clientId + ')');

    try {
      ws.send(JSON.stringify({ type: 'bridge-connected' }));
      ws.send(JSON.stringify({ type: 'status', iracing: currentIracingStatus }));
    } catch(e) {}

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'subscribe' && Array.isArray(msg.channels)) {
          msg.channels.forEach(ch => meta.channels.add(ch));
          meta.name = deriveClientName(meta.channels);
          console.log('[WebSocket] Client ' + clientId + ' (' + meta.name + ') subscribed to:', [...meta.channels]);
        } else if (msg.type === 'select-driver' && msg.carIdx !== undefined) {
          selectedCarIdx = msg.carIdx === null ? null : Number(msg.carIdx);
          broadcastToChannel('_all', { type: 'driver-selected', carIdx: selectedCarIdx });
        }
      } catch (e) {}
    });

    ws.on('close', () => {
      const m = clients.get(ws);
      if (m) {
        console.log('[WebSocket] Client disconnected (id: ' + m.id + ', ' + m.name + ')');
        m.disconnectedAt = Date.now();
      }
      clients.delete(ws);
    });

    ws.on('error', () => {
      const m = clients.get(ws);
      if (m) m.disconnectedAt = Date.now();
      clients.delete(ws);
    });
  });
}

function stopServer() {
  if (wss) wss.close();
}

function deriveClientName(channels) {
  if (!channels || channels.size === 0) return 'Unknown';
  const names = [...channels].map(ch => ch.charAt(0).toUpperCase() + ch.slice(1));
  return names.join(', ');
}

function logToClient(clientId, entry) {
  const log = clientLogs.get(clientId);
  if (!log) return;
  log.push(entry);
  if (log.length > MAX_LOG_ENTRIES) log.splice(0, log.length - MAX_LOG_ENTRIES);
}

function broadcastToChannel(channel, data) {
  if (!wss) return;
  if (data && data.type === 'status' && data.iracing !== undefined) {
    currentIracingStatus = data.iracing;
  }
  const msg = JSON.stringify(data);
  const size = msg.length;
  clients.forEach((meta, ws) => {
    if (ws.readyState === 1 && (channel === '_all' || meta.channels.has(channel))) {
      try {
        ws.send(msg);
        logToClient(meta.id, {
          ts: Date.now(),
          channel: channel === '_all' ? 'broadcast' : channel,
          type: data.type || 'unknown',
          size
        });
      } catch (e) {}
    }
  });
}

function getClientInfo() {
  const info = [];
  clients.forEach((meta) => {
    info.push({ id: meta.id, state: 1, channels: [...meta.channels], name: meta.name, connectedAt: meta.connectedAt });
  });
  // Also include recently disconnected clients that still have logs
  clientLogs.forEach((log, clientId) => {
    if (!info.find(c => c.id === clientId) && log.length > 0) {
      // Find disconnected meta — we don't have it in clients map anymore, but we stored disconnectedAt
      info.push({ id: clientId, state: 3, channels: [], name: 'Disconnected #' + clientId, connectedAt: 0 });
    }
  });
  return info;
}

function getClientLog(clientId) {
  return clientLogs.get(clientId) || [];
}

function clearClientLog(clientId) {
  clientLogs.set(clientId, []);
}

function clearAllClientLogs() {
  clientLogs.forEach((log, id) => { clientLogs.set(id, []); });
  // Remove disconnected clients with no logs
  for (const [id] of clientLogs) {
    let stillConnected = false;
    clients.forEach(meta => { if (meta.id === id) stillConnected = true; });
    if (!stillConnected) clientLogs.delete(id);
  }
}

function getSelectedCarIdx() { return selectedCarIdx; }
function resetSelectedCar() { selectedCarIdx = null; }

module.exports = { startServer, stopServer, broadcastToChannel, getClientInfo, getClientLog, clearClientLog, clearAllClientLogs, getSelectedCarIdx, resetSelectedCar };
```

Key changes from original:
- `clients` Map now stores `{ id, channels: Set, connectedAt, name, disconnectedAt }` instead of just a `Set` of channels
- New `clientLogs` Map keyed by clientId, each entry is an array of `{ ts, channel, type, size }`
- `broadcastToChannel` now calls `logToClient()` after each successful send
- `meta.channels` is a Set (same as before but on the meta object)
- `getClientInfo()` now returns id, name, connectedAt, and includes disconnected clients with remaining logs
- New exports: `getClientLog`, `clearClientLog`, `clearAllClientLogs`

- [ ] **Step 2: Update telemetry.js import to match new exports**

In `bridge/telemetry.js` line 18, the import already destructures only what it uses:
```javascript
const { broadcastToChannel, getClientInfo, getSelectedCarIdx, resetSelectedCar } = require('./websocket');
```
These are all still exported, so no change is needed. Verify by searching for all `require('./websocket')` calls:

Run: `grep -rn "require('./websocket')" bridge/`
Expected: Only `telemetry.js` and `main.js` import it. Both use only functions that are still exported.

- [ ] **Step 3: Commit**

```bash
git add bridge/websocket.js
git commit -m "feat(bridge): add per-client WebSocket message logging

Track client IDs, friendly names, connect times, and per-client
message logs (capped at 500 entries) for the control panel UI."
```

---

### Task 2: Add IPC handlers in main.js

**Files:**
- Modify: `bridge/main.js:20` (import line)
- Modify: `bridge/main.js` (after existing ipcMain handlers, ~line 601)

- [ ] **Step 1: Update websocket import in main.js**

In `bridge/main.js` line 20, change:
```javascript
const { startServer, stopServer } = require('./websocket');
```
to:
```javascript
const { startServer, stopServer, getClientInfo: getWsClients, getClientLog, clearClientLog, clearAllClientLogs } = require('./websocket');
```

- [ ] **Step 2: Add IPC handlers after the existing ones**

After `bridge/main.js` line 601 (after `get-overlay-settings` handler), add:

```javascript
// ─── WebSocket client logs IPC ────────────────────────────────
ipcMain.on('get-ws-clients', (event) => {
  event.reply('ws-clients', getWsClients());
});

ipcMain.on('get-ws-client-log', (event, clientId) => {
  event.reply('ws-client-log', clientId, getClientLog(clientId));
});

ipcMain.on('clear-ws-client-log', (event, clientId) => {
  clearClientLog(clientId);
  event.reply('ws-client-log', clientId, []);
});

ipcMain.on('clear-all-ws-client-logs', (event) => {
  clearAllClientLogs();
  event.reply('ws-clients', getWsClients());
});
```

- [ ] **Step 3: Commit**

```bash
git add bridge/main.js
git commit -m "feat(bridge): add IPC handlers for WebSocket client logs

Expose get-ws-clients, get-ws-client-log, clear-ws-client-log,
and clear-all-ws-client-logs IPC channels for the control panel."
```

---

### Task 3: Redesign Logs tab UI in control-panel.html

**Files:**
- Modify: `bridge/control-panel.html` (CSS section ~lines 198-210, HTML ~lines 400-410, JS ~lines 1479-1524)

- [ ] **Step 1: Replace the Logs CSS block**

Replace lines 198-210 (the `/* ─── Logs panel ─── */` CSS section) with:

```css
    /* ─── Logs panel ──────────────────────────────────────── */
    .logs-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .logs-actions { display: flex; gap: 6px; }
    .log-action-btn {
      padding: 4px 10px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1);
      background: transparent; color: #8b8a9e; font-size: 10px; cursor: pointer;
    }
    .log-action-btn:hover { border-color: rgba(255,255,255,0.2); color: #e8e6f0; }
    .logs-layout { display: flex; gap: 10px; height: calc(100vh - 140px); }
    .logs-client-list {
      width: 180px; min-width: 180px; background: #0a0b10; border: 1px solid rgba(255,255,255,0.06);
      border-radius: 6px; overflow-y: auto; padding: 4px;
    }
    .logs-client-item {
      display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 4px;
      cursor: pointer; font-size: 11px; color: #8b8a9e; transition: background 0.15s, color 0.15s;
    }
    .logs-client-item:hover { background: rgba(255,255,255,0.04); color: #c0bfd0; }
    .logs-client-item.active { background: rgba(145,70,255,0.15); color: #e8e6f0; }
    .logs-client-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .logs-client-dot.connected { background: #3ecf8e; }
    .logs-client-dot.disconnected { background: #5c5b6e; }
    .logs-client-dot.all { background: #9146ff; }
    .logs-client-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .logs-client-count { font-size: 9px; color: #5c5b6e; }
    .logs-viewer { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .logs-viewer-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .logs-viewer-title { font-size: 11px; font-weight: 700; color: #e8e6f0; }
    #log-container {
      background: #0a0b10; border: 1px solid rgba(255,255,255,0.06); border-radius: 6px;
      padding: 8px; flex: 1; overflow-y: auto; font-family: Consolas, monospace;
      font-size: 10px; color: #8b8a9e; line-height: 1.5; white-space: pre-wrap; word-break: break-all;
    }
```

- [ ] **Step 2: Replace the Logs HTML panel**

Replace lines 400-410 (the `<!-- ═══ LOGS PANEL ═══ -->` section) with:

```html
      <!-- ═══ LOGS PANEL ═══ -->
      <div class="content-panel" id="panel-logs">
        <div class="logs-header">
          <div class="section-header" style="margin:0;border:none;padding:0;">Live Logs</div>
        </div>
        <div class="logs-layout">
          <div class="logs-client-list" id="logs-client-list">
            <div class="logs-client-item active" data-client="all" onclick="selectLogClient('all')">
              <div class="logs-client-dot all"></div>
              <div class="logs-client-name">All Logs</div>
            </div>
          </div>
          <div class="logs-viewer">
            <div class="logs-viewer-header">
              <div class="logs-viewer-title" id="logs-viewer-title">All Logs</div>
              <div class="logs-actions">
                <button class="log-action-btn" onclick="copyLogs()">Copy</button>
                <button class="log-action-btn" onclick="clearCurrentLog()">Clear</button>
              </div>
            </div>
            <div id="log-container">Loading logs...</div>
          </div>
        </div>
      </div>
```

- [ ] **Step 3: Replace the Logs JavaScript block**

Replace lines 1479-1524 (from `// ─── Logs ───` through `stopLogRefresh` function) with:

```javascript
    // ─── Logs ────────────────────────────────────────────────
    const logFs = require('fs');
    const logPath = require('path').join(require('os').homedir(), 'atleta-bridge.log');
    let logContent = '';
    let logInterval = null;
    let selectedLogClient = 'all'; // 'all' or numeric clientId

    function loadLogs() {
      if (selectedLogClient === 'all') {
        loadGlobalLogs();
      }
      // Always refresh client list
      ipcRenderer.send('get-ws-clients');
    }

    function loadGlobalLogs() {
      try {
        const content = logFs.readFileSync(logPath, 'utf8');
        if (content !== logContent) {
          logContent = content;
          renderGlobalLogs();
        }
      } catch(e) {
        document.getElementById('log-container').textContent = 'Log file not found: ' + logPath;
      }
    }

    function renderGlobalLogs() {
      const container = document.getElementById('log-container');
      container.innerHTML = logContent.split('\n').map(line => {
        if (line.includes('[Speech]') || line.includes('[VoiceInput]') || line.includes('[VoiceOverlay]'))
          return '<span style="color:#9146ff">' + escapeLogHtml(line) + '</span>';
        if (line.includes('ERROR') || line.includes('error') || line.includes('FATAL'))
          return '<span style="color:#f04438">' + escapeLogHtml(line) + '</span>';
        if (line.includes('[Telemetry]') || line.includes('[SessionInfo]'))
          return '<span style="color:#3ecf8e">' + escapeLogHtml(line) + '</span>';
        if (line.includes('[Diag]'))
          return '<span style="color:#5c5b6e">' + escapeLogHtml(line) + '</span>';
        return escapeLogHtml(line);
      }).join('\n');
      container.scrollTop = container.scrollHeight;
    }

    function renderClientLog(entries) {
      const container = document.getElementById('log-container');
      if (!entries || entries.length === 0) {
        container.innerHTML = '<span style="color:#5c5b6e">No messages logged yet.</span>';
        return;
      }
      container.innerHTML = entries.map(e => {
        const time = new Date(e.ts).toISOString().slice(11, 23);
        const sizeStr = e.size > 1024 ? (e.size / 1024).toFixed(1) + 'KB' : e.size + 'B';
        const channelColor = e.channel === 'broadcast' ? '#9146ff' : '#3ecf8e';
        return '<span style="color:#5c5b6e">' + time + '</span> ' +
               '<span style="color:' + channelColor + '">[' + escapeLogHtml(e.channel) + ']</span> ' +
               '<span style="color:#8b8a9e">' + escapeLogHtml(e.type) + '</span> ' +
               '<span style="color:#5c5b6e">(' + sizeStr + ')</span>';
      }).join('\n');
      container.scrollTop = container.scrollHeight;
    }

    function escapeLogHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    function selectLogClient(clientId) {
      selectedLogClient = clientId;
      // Update active state in client list
      document.querySelectorAll('.logs-client-item').forEach(el => {
        el.classList.toggle('active', el.dataset.client === String(clientId));
      });
      const title = document.getElementById('logs-viewer-title');
      if (clientId === 'all') {
        title.textContent = 'All Logs';
        logContent = ''; // force re-render
        loadGlobalLogs();
      } else {
        const item = document.querySelector('.logs-client-item[data-client="' + clientId + '"]');
        title.textContent = item ? item.querySelector('.logs-client-name').textContent : 'Client #' + clientId;
        ipcRenderer.send('get-ws-client-log', clientId);
      }
    }

    function copyLogs() {
      const container = document.getElementById('log-container');
      const text = container.innerText;
      require('electron').clipboard.writeText(text);
      const toast = document.getElementById('copy-toast');
      toast.style.display = 'block';
      setTimeout(() => { toast.style.display = 'none'; }, 1500);
    }

    function clearCurrentLog() {
      if (selectedLogClient === 'all') {
        document.getElementById('log-container').innerHTML = '';
        logContent = '';
      } else {
        ipcRenderer.send('clear-ws-client-log', selectedLogClient);
      }
    }

    // IPC listeners for client data
    ipcRenderer.on('ws-clients', (event, clientList) => {
      const list = document.getElementById('logs-client-list');
      // Keep "All Logs" item, rebuild rest
      const allItem = list.querySelector('[data-client="all"]');
      list.innerHTML = '';
      list.appendChild(allItem);
      clientList.forEach(c => {
        const item = document.createElement('div');
        item.className = 'logs-client-item' + (selectedLogClient === c.id ? ' active' : '');
        item.dataset.client = c.id;
        item.onclick = () => selectLogClient(c.id);
        const dotClass = c.state === 1 ? 'connected' : 'disconnected';
        const logCount = c.logCount !== undefined ? c.logCount : '';
        item.innerHTML =
          '<div class="logs-client-dot ' + dotClass + '"></div>' +
          '<div class="logs-client-name">' + escapeLogHtml(c.name) + '</div>' +
          (logCount ? '<div class="logs-client-count">' + logCount + '</div>' : '');
        list.appendChild(item);
      });
      // If selected client is not 'all', refresh its log too
      if (selectedLogClient !== 'all') {
        ipcRenderer.send('get-ws-client-log', selectedLogClient);
      }
    });

    ipcRenderer.on('ws-client-log', (event, clientId, entries) => {
      if (selectedLogClient === clientId) {
        renderClientLog(entries);
      }
    });

    function startLogRefresh() { if (!logInterval) { loadLogs(); logInterval = setInterval(loadLogs, 2000); } }
    function stopLogRefresh() { if (logInterval) { clearInterval(logInterval); logInterval = null; } }
```

- [ ] **Step 4: Commit**

```bash
git add bridge/control-panel.html
git commit -m "feat(bridge): redesign Logs tab with per-client WebSocket viewer

Two-column layout: client list on left (with connection status dots),
log viewer on right. Click a client to see its message history.
All Logs (global file) preserved as default view. Copy and Clear
buttons work per-client or globally."
```

---

### Task 4: Wire up log counts in getClientInfo response

**Files:**
- Modify: `bridge/websocket.js` (in `getClientInfo` function)

- [ ] **Step 1: Add logCount to client info response**

In the `getClientInfo` function in `bridge/websocket.js`, update the two `info.push` calls to include `logCount`:

For connected clients:
```javascript
info.push({ id: meta.id, state: 1, channels: [...meta.channels], name: meta.name, connectedAt: meta.connectedAt, logCount: (clientLogs.get(meta.id) || []).length });
```

For disconnected clients with logs:
```javascript
info.push({ id: clientId, state: 3, channels: [], name: 'Disconnected #' + clientId, connectedAt: 0, logCount: log.length });
```

- [ ] **Step 2: Commit**

```bash
git add bridge/websocket.js
git commit -m "feat(bridge): include log count in WebSocket client info response"
```

---

### Task 5: Preserve disconnected client name

**Files:**
- Modify: `bridge/websocket.js`

Currently when a client disconnects, the `clients` Map entry is deleted and we lose the name. We need to preserve it for the disconnected client display.

- [ ] **Step 1: Store disconnected client metadata**

Add a `disconnectedMeta` Map alongside `clientLogs` near the top of websocket.js:

```javascript
const disconnectedMeta = new Map();
```

In the `ws.on('close')` handler, before `clients.delete(ws)`, store the meta:

```javascript
ws.on('close', () => {
  const m = clients.get(ws);
  if (m) {
    console.log('[WebSocket] Client disconnected (id: ' + m.id + ', ' + m.name + ')');
    m.disconnectedAt = Date.now();
    disconnectedMeta.set(m.id, { id: m.id, name: m.name, channels: [...m.channels], disconnectedAt: m.disconnectedAt });
  }
  clients.delete(ws);
});
```

Same for the `ws.on('error')` handler:

```javascript
ws.on('error', () => {
  const m = clients.get(ws);
  if (m) {
    m.disconnectedAt = Date.now();
    disconnectedMeta.set(m.id, { id: m.id, name: m.name, channels: [...m.channels], disconnectedAt: m.disconnectedAt });
  }
  clients.delete(ws);
});
```

Update the disconnected-client section of `getClientInfo()`:

```javascript
clientLogs.forEach((log, clientId) => {
  if (!info.find(c => c.id === clientId) && log.length > 0) {
    const dm = disconnectedMeta.get(clientId);
    const name = dm ? dm.name : 'Disconnected #' + clientId;
    info.push({ id: clientId, state: 3, channels: dm ? dm.channels : [], name, connectedAt: dm ? dm.disconnectedAt : 0, logCount: log.length });
  }
});
```

Update `clearAllClientLogs()` to also clean up disconnected metadata:

```javascript
function clearAllClientLogs() {
  clientLogs.forEach((log, id) => { clientLogs.set(id, []); });
  for (const [id] of clientLogs) {
    let stillConnected = false;
    clients.forEach(meta => { if (meta.id === id) stillConnected = true; });
    if (!stillConnected) {
      clientLogs.delete(id);
      disconnectedMeta.delete(id);
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add bridge/websocket.js
git commit -m "feat(bridge): preserve disconnected client name and metadata for log display"
```

---

### Task 6: Manual testing

- [ ] **Step 1: Verify no import/runtime errors**

Run the app and confirm:
1. Control panel opens without errors
2. Logs tab shows "All Logs" in the client list by default
3. Global log file content displays in the viewer (same as before)

- [ ] **Step 2: Verify per-client logging**

1. Enable an overlay (e.g., Standings)
2. Switch to Logs tab — the overlay should appear in the client list with a green dot and its name (e.g., "Standings, Relative")
3. Click the client — should show message entries with timestamps, channels, types, and sizes
4. Click "Copy" — should copy the displayed text to clipboard
5. Click "Clear" — should clear that client's log

- [ ] **Step 3: Verify disconnected clients**

1. Disable the overlay
2. The client should show with a gray dot in the client list (still visible if it has logs)
3. Its logs should still be viewable

- [ ] **Step 4: Verify All Logs still works**

1. Click "All Logs" in the client list
2. Global log file content should display with color coding (same as before)
3. Copy and Clear should work for the global view
