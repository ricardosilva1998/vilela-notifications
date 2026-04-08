# Bridge Remote Logs & Bug Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the Bridge Electron app to upload logs to the server, viewable on the iRacing dashboard tab, with a scheduled agent that analyzes logs for potential bugs.

**Architecture:** Bridge generates a UUID on first launch and uploads new log lines every 60s to a public POST endpoint. Server stores in SQLite with 7-day retention. Dashboard iRacing tab shows log viewer + bug report cards. A scheduled Claude Code agent periodically fetches logs, detects errors, and stores findings for user review.

**Tech Stack:** Node.js, Express, better-sqlite3, Electron, native `https` module

---

### Task 1: Database — bridge_logs and bridge_bug_reports tables

**Files:**
- Modify: `src/db.js:818` (after track_maps migrations, before seed section)

- [ ] **Step 1: Add bridge_logs table creation and bridge_bug_reports table creation**

In `src/db.js`, add after the track metadata migrations (line ~818) and before the `--- Seed ---` section:

```javascript
// --- Bridge Remote Logs ---
db.exec(`
  CREATE TABLE IF NOT EXISTS bridge_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bridge_id TEXT NOT NULL,
    lines TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_bridge_logs_lookup ON bridge_logs (bridge_id, created_at)`);

db.exec(`
  CREATE TABLE IF NOT EXISTS bridge_bug_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bridge_id TEXT NOT NULL,
    error_pattern TEXT NOT NULL,
    explanation TEXT NOT NULL,
    suggested_fix TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_bridge_bug_reports_lookup ON bridge_bug_reports (bridge_id, status)`);
```

- [ ] **Step 2: Add DB helper functions**

Add before the `module.exports` block (around line ~3098):

```javascript
// --- Bridge Logs ---

function insertBridgeLogs(bridgeId, lines) {
  db.prepare('INSERT INTO bridge_logs (bridge_id, lines) VALUES (?, ?)').run(bridgeId, lines);
}

function getBridgeLogs(bridgeId, hours) {
  const h = Math.min(Math.max(hours || 24, 1), 168);
  return db.prepare(
    "SELECT id, lines, created_at FROM bridge_logs WHERE bridge_id = ? AND created_at >= datetime('now', '-' || ? || ' hours') ORDER BY created_at ASC"
  ).all(bridgeId, h);
}

function cleanupOldBridgeLogs() {
  const result = db.prepare("DELETE FROM bridge_logs WHERE created_at < datetime('now', '-7 days')").run();
  if (result.changes > 0) console.log(`[DB] Cleaned up ${result.changes} old bridge log entries`);
}

function insertBridgeBugReport(bridgeId, errorPattern, explanation, suggestedFix) {
  const result = db.prepare('INSERT INTO bridge_bug_reports (bridge_id, error_pattern, explanation, suggested_fix) VALUES (?, ?, ?, ?)').run(bridgeId, errorPattern, explanation, suggestedFix);
  return result.lastInsertRowid;
}

function getBridgeBugReports(bridgeId, status) {
  if (status) {
    return db.prepare('SELECT * FROM bridge_bug_reports WHERE bridge_id = ? AND status = ? ORDER BY created_at DESC').all(bridgeId, status);
  }
  return db.prepare('SELECT * FROM bridge_bug_reports WHERE bridge_id = ? ORDER BY created_at DESC').all(bridgeId);
}

function updateBridgeBugReportStatus(id, status) {
  db.prepare('UPDATE bridge_bug_reports SET status = ? WHERE id = ?').run(status, id);
}

function cleanupOldBridgeBugReports() {
  const result = db.prepare("DELETE FROM bridge_bug_reports WHERE status = 'dismissed' AND created_at < datetime('now', '-30 days')").run();
  if (result.changes > 0) console.log(`[DB] Cleaned up ${result.changes} old dismissed bug reports`);
}
```

- [ ] **Step 3: Export the new functions**

Add to `module.exports` (before `closeDb`):

```javascript
  insertBridgeLogs,
  getBridgeLogs,
  cleanupOldBridgeLogs,
  insertBridgeBugReport,
  getBridgeBugReports,
  updateBridgeBugReportStatus,
  cleanupOldBridgeBugReports,
```

- [ ] **Step 4: Verify tables are created**

Run: `npm run dev` briefly or `node -e "require('./src/db'); console.log('OK')"`
Expected: No errors, tables created

- [ ] **Step 5: Commit**

```bash
git add src/db.js
git commit -m "feat: add bridge_logs and bridge_bug_reports tables"
```

---

### Task 2: API Endpoints — bridge logs and bug reports

**Files:**
- Modify: `src/server.js:248` (after live-session endpoint, before auth-gated `/api` routes)

- [ ] **Step 1: Add POST /api/bridge-logs endpoint**

In `src/server.js`, add after the `DELETE /api/track-stats` endpoint (line ~271) and before the `// Track Database page` section:

```javascript
// Bridge remote logs (public — must be before /api auth middleware)
app.post('/api/bridge-logs', (req, res) => {
  try {
    const { bridgeId, lines } = req.body;
    if (!bridgeId || typeof bridgeId !== 'string') return res.status(400).json({ error: 'bridgeId required' });
    if (!lines || typeof lines !== 'string') return res.status(400).json({ error: 'lines required' });
    if (lines.length > 1024 * 1024) return res.status(400).json({ error: 'Payload too large (max 1MB)' });
    db.insertBridgeLogs(bridgeId, lines);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bridge-logs/:bridgeId', (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const logs = db.getBridgeLogs(req.params.bridgeId, hours);
    res.json({ logs });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 2: Add bug report endpoints**

Add right after the bridge-logs endpoints:

```javascript
app.post('/api/bridge-bug-reports', (req, res) => {
  try {
    const { bridgeId, errorPattern, explanation, suggestedFix } = req.body;
    if (!bridgeId || !errorPattern || !explanation || !suggestedFix) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const id = db.insertBridgeBugReport(bridgeId, errorPattern, explanation, suggestedFix);
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bridge-bug-reports', (req, res) => {
  try {
    const { bridgeId, status } = req.query;
    if (!bridgeId) return res.status(400).json({ error: 'bridgeId required' });
    const reports = db.getBridgeBugReports(bridgeId, status);
    res.json({ reports });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/bridge-bug-reports/:id', (req, res) => {
  try {
    const { status } = req.body;
    if (!['approved', 'dismissed'].includes(status)) {
      return res.status(400).json({ error: 'Status must be approved or dismissed' });
    }
    db.updateBridgeBugReportStatus(req.params.id, status);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 3: Add cleanup intervals**

In `src/index.js`, add after the existing `db.cleanupOldOverlayEvents();` line (~54):

```javascript
    // Clean up old bridge logs (every 6 hours)
    setInterval(() => { try { db.cleanupOldBridgeLogs(); } catch (e) {} }, 6 * 60 * 60 * 1000);
    db.cleanupOldBridgeLogs();
    setInterval(() => { try { db.cleanupOldBridgeBugReports(); } catch (e) {} }, 6 * 60 * 60 * 1000);
    db.cleanupOldBridgeBugReports();
```

- [ ] **Step 4: Test endpoints manually**

Run the server with `npm run dev`, then in another terminal:

```bash
# Upload logs
curl -X POST http://localhost:3000/api/bridge-logs \
  -H "Content-Type: application/json" \
  -d '{"bridgeId":"test-uuid","lines":"[2026-04-08T12:00:00Z] [MAIN] test log line\n[2026-04-08T12:00:01Z] [TELEMETRY] connected"}'

# Read logs
curl http://localhost:3000/api/bridge-logs/test-uuid

# Create bug report
curl -X POST http://localhost:3000/api/bridge-bug-reports \
  -H "Content-Type: application/json" \
  -d '{"bridgeId":"test-uuid","errorPattern":"[ERROR] null ref","explanation":"Driver object is null","suggestedFix":"Add null check"}'

# Read bug reports
curl "http://localhost:3000/api/bridge-bug-reports?bridgeId=test-uuid"

# Update status
curl -X PATCH http://localhost:3000/api/bridge-bug-reports/1 \
  -H "Content-Type: application/json" \
  -d '{"status":"approved"}'
```

Expected: All return `{ ok: true }` or JSON data.

- [ ] **Step 5: Commit**

```bash
git add src/server.js src/index.js
git commit -m "feat: add bridge logs and bug report API endpoints"
```

---

### Task 3: Bridge — UUID generation in settings

**Files:**
- Modify: `bridge/settings.js`

- [ ] **Step 1: Add bridgeId generation to settings load**

Replace the entire `bridge/settings.js` content:

```javascript
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SETTINGS_DIR = path.join(os.homedir(), 'Documents', 'Atleta Bridge');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

function load() {
  let settings = {};
  try {
    if (!fs.existsSync(SETTINGS_DIR)) fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    if (fs.existsSync(SETTINGS_FILE)) settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch(e) {}

  // Generate Bridge ID on first launch
  if (!settings.bridgeId) {
    settings.bridgeId = crypto.randomUUID();
    save(settings);
  }

  return settings;
}

function save(settings) {
  try {
    if (!fs.existsSync(SETTINGS_DIR)) fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch(e) { console.error('[Settings] Save error:', e.message); }
}

module.exports = { load, save };
```

- [ ] **Step 2: Verify it works**

Run: `node -e "const s = require('./bridge/settings'); const data = s.load(); console.log('bridgeId:', data.bridgeId)"`
Expected: Prints a UUID like `bridgeId: 550e8400-e29b-41d4-a716-446655440000`

- [ ] **Step 3: Commit**

```bash
git add bridge/settings.js
git commit -m "feat: generate bridgeId UUID on first Bridge launch"
```

---

### Task 4: Bridge — Log upload interval

**Files:**
- Modify: `bridge/main.js` (in the `app.on('ready', ...)` block)

- [ ] **Step 1: Add uploadLogs function and interval**

In `bridge/main.js`, add after the `console.log('[Bridge] Started');` line (line 247), but still inside the `app.on('ready', ...)` callback:

```javascript
  // --- Remote Log Upload (every 60s) ---
  const LOG_UPLOAD_URL = 'https://atletanotifications.com/api/bridge-logs';
  let lastLogOffset = 0;

  function uploadLogs() {
    try {
      const fs = require('fs');
      const https = require('https');
      const logPath = require('path').join(require('os').homedir(), 'atleta-bridge.log');
      if (!fs.existsSync(logPath)) return;

      const stat = fs.statSync(logPath);
      // Log file was recreated (smaller than offset) — reset
      if (stat.size < lastLogOffset) lastLogOffset = 0;
      if (stat.size <= lastLogOffset) return; // no new data

      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(stat.size - lastLogOffset);
      fs.readSync(fd, buf, 0, buf.length, lastLogOffset);
      fs.closeSync(fd);

      const newLines = buf.toString('utf8');
      if (!newLines.trim()) return;

      const postData = JSON.stringify({ bridgeId: settings.bridgeId, lines: newLines });

      // Cap at 1MB per upload
      if (postData.length > 1024 * 1024) {
        lastLogOffset = stat.size;
        return;
      }

      const url = new URL(LOG_UPLOAD_URL);
      const req = https.request({
        hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        timeout: 10000,
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) lastLogOffset = stat.size;
        });
      });
      req.on('error', () => {}); // silent fail
      req.on('timeout', () => req.destroy());
      req.write(postData);
      req.end();
    } catch(e) {} // never crash the app
  }

  setInterval(uploadLogs, 60000);
  // Upload initial logs after 10s
  setTimeout(uploadLogs, 10000);
```

- [ ] **Step 2: Commit**

```bash
git add bridge/main.js
git commit -m "feat: upload Bridge logs to server every 60s"
```

---

### Task 5: Bridge — Show Bridge ID in control panel

**Files:**
- Modify: `bridge/control-panel.html`

- [ ] **Step 1: Find the About section in control-panel.html**

Search for the About tab/section in the control panel. It's in the sidebar under "About".

- [ ] **Step 2: Add Bridge ID display**

Find the About tab content and add a Bridge ID row. The exact location depends on the existing HTML, but add this inside the About tab content area:

```html
<div style="margin-top:12px; padding:10px 12px; background:rgba(255,255,255,0.03); border-radius:8px; display:flex; align-items:center; justify-content:space-between;">
  <div>
    <div style="font-size:11px; color:#888; margin-bottom:2px;">Bridge ID</div>
    <div id="bridge-id-display" style="font-size:11px; font-family:monospace; color:#ccc; user-select:all;"></div>
  </div>
  <button onclick="navigator.clipboard.writeText(document.getElementById('bridge-id-display').textContent); this.textContent='Copied!'; setTimeout(() => this.textContent='Copy', 1500);" style="background:rgba(145,70,255,0.15); color:#9146ff; border:none; padding:4px 10px; border-radius:6px; font-size:11px; cursor:pointer;">Copy</button>
</div>
```

And in the JavaScript initialization section (where settings are loaded), add:

```javascript
document.getElementById('bridge-id-display').textContent = settings.bridgeId || 'Not generated';
```

- [ ] **Step 3: Commit**

```bash
git add bridge/control-panel.html
git commit -m "feat: show Bridge ID in control panel About section"
```

---

### Task 6: Dashboard — Bridge Logs and Bug Reports UI on iRacing tab

**Files:**
- Modify: `src/views/dashboard.ejs:591-597` (iRacing sub-tabs) and `708-711` (before closing iracing tab)

- [ ] **Step 1: Add Bridge Logs sub-tab button**

In `dashboard.ejs`, find the iRacing sub-tabs section (line ~591-597). Add a new sub-tab button after "Stream Overlays" and before the admin-only Track Upload:

```html
    <button class="iracing-subtab" data-irtab="logs" onclick="switchIRacingTab('logs')">Bridge Logs</button>
```

Add it between the "Stream Overlays" button and the `<% if (typeof isAdmin ...` line.

- [ ] **Step 2: Add Bridge Logs tab content**

Before the closing `</div><!-- /irtab-tracks -->` admin section (line ~708), add the logs and bug reports tab content:

```html
  <div class="iracing-subtab-content" id="irtab-logs">
    <!-- Bridge ID input -->
    <div class="card animate-in" style="margin-bottom: 12px; padding: 16px 20px;">
      <div style="display:flex; align-items:center; gap:10px;">
        <label style="font-size:13px; font-weight:600; white-space:nowrap;">Bridge ID</label>
        <input type="text" id="bridge-id-input" placeholder="Paste your Bridge ID here (from Bridge app → About)" style="flex:1; background:var(--bg-base); border:1px solid var(--border); color:var(--text-primary); padding:7px 10px; border-radius:var(--radius-sm); font-size:12px; font-family:monospace;">
        <button onclick="saveBridgeId()" class="btn btn-primary" style="font-size:12px; padding:7px 14px;">Connect</button>
      </div>
      <p style="font-size:11px; color:var(--text-muted); margin-top:6px;">Find your Bridge ID in the Atleta Bridge app → About tab.</p>
    </div>

    <!-- Bug Reports Card -->
    <div class="card animate-in" style="margin-bottom: 12px; padding: 20px 24px;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
        <h3 style="font-size:15px; font-weight:700; margin:0;">Bug Reports</h3>
        <span id="bug-report-count" style="font-size:11px; color:var(--text-muted);"></span>
      </div>
      <div id="bug-reports-container">
        <p style="font-size:12px; color:var(--text-muted);">Enter your Bridge ID above to see bug reports.</p>
      </div>
    </div>

    <!-- Bridge Logs Card -->
    <div class="card animate-in" style="padding: 20px 24px;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
        <h3 style="font-size:15px; font-weight:700; margin:0;">Bridge Logs</h3>
        <div style="display:flex; align-items:center; gap:8px;">
          <label style="font-size:11px; color:var(--text-muted); display:flex; align-items:center; gap:4px; cursor:pointer;">
            <input type="checkbox" id="logs-auto-refresh" onchange="toggleLogAutoRefresh(this.checked)"> Auto-refresh
          </label>
          <button onclick="fetchBridgeLogs()" class="btn btn-secondary" style="font-size:11px; padding:5px 10px;">Refresh</button>
          <button onclick="copyAllLogs()" class="btn btn-secondary" style="font-size:11px; padding:5px 10px;">Copy All</button>
        </div>
      </div>
      <div id="bridge-logs-container" style="background:rgba(0,0,0,0.3); border-radius:8px; padding:12px; max-height:500px; overflow-y:auto; font-family:monospace; font-size:11px; line-height:1.6; white-space:pre-wrap; word-break:break-all; color:#ccc;">
        <span style="color:var(--text-muted);">Enter your Bridge ID above to view logs.</span>
      </div>
    </div>
  </div><!-- /irtab-logs -->
```

- [ ] **Step 3: Add JavaScript for logs and bug reports**

Add at the end of the iRacing script section (after the existing `switchIRacingTab` and IBT parser code), before the closing `</script>` of the dashboard:

```javascript
// ─── Bridge Logs ──────────────────────────────────────────
let bridgeLogRefreshInterval = null;

function saveBridgeId() {
  const id = document.getElementById('bridge-id-input').value.trim();
  if (!id) return;
  localStorage.setItem('bridgeId', id);
  fetchBridgeLogs();
  fetchBugReports();
}

// Load saved Bridge ID on page load
(function() {
  const saved = localStorage.getItem('bridgeId');
  if (saved) {
    document.getElementById('bridge-id-input').value = saved;
    // Auto-fetch on load
    setTimeout(() => { fetchBridgeLogs(); fetchBugReports(); }, 500);
  }
})();

function fetchBridgeLogs() {
  const bridgeId = localStorage.getItem('bridgeId');
  if (!bridgeId) return;
  const container = document.getElementById('bridge-logs-container');
  fetch('/api/bridge-logs/' + encodeURIComponent(bridgeId) + '?hours=24')
    .then(r => r.json())
    .then(data => {
      if (!data.logs || data.logs.length === 0) {
        container.innerHTML = '<span style="color:var(--text-muted);">No logs found in the last 24 hours.</span>';
        return;
      }
      const allLines = data.logs.map(l => l.lines).join('');
      container.innerHTML = colorizeLogs(allLines);
      container.scrollTop = container.scrollHeight;
    })
    .catch(() => { container.innerHTML = '<span style="color:#e74c3c;">Failed to fetch logs.</span>'; });
}

function colorizeLogs(text) {
  return text.split('\n').map(line => {
    if (!line.trim()) return '';
    let color = '#ccc';
    if (/\[VOICE\]|\[SPEECH\]/i.test(line)) color = '#b39ddb';
    else if (/error|ERR|\[UNCAUGHT\]/i.test(line)) color = '#ef5350';
    else if (/\[TELEMETRY\]/i.test(line)) color = '#66bb6a';
    else if (/\[DIAG\]/i.test(line)) color = '#888';
    else if (/\[MAIN\]|\[Bridge\]/i.test(line)) color = '#42a5f5';
    return '<span style="color:' + color + ';">' + escapeHtml(line) + '</span>';
  }).filter(Boolean).join('\n');
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toggleLogAutoRefresh(enabled) {
  if (bridgeLogRefreshInterval) { clearInterval(bridgeLogRefreshInterval); bridgeLogRefreshInterval = null; }
  if (enabled) {
    bridgeLogRefreshInterval = setInterval(fetchBridgeLogs, 10000);
  }
}

function copyAllLogs() {
  const container = document.getElementById('bridge-logs-container');
  navigator.clipboard.writeText(container.textContent);
}

// ─── Bug Reports ──────────────────────────────────────────
function fetchBugReports() {
  const bridgeId = localStorage.getItem('bridgeId');
  if (!bridgeId) return;
  const container = document.getElementById('bug-reports-container');
  const countEl = document.getElementById('bug-report-count');
  fetch('/api/bridge-bug-reports?bridgeId=' + encodeURIComponent(bridgeId))
    .then(r => r.json())
    .then(data => {
      if (!data.reports || data.reports.length === 0) {
        container.innerHTML = '<p style="font-size:12px; color:var(--text-muted);">No bug reports yet. The AI agent will analyze your logs periodically.</p>';
        countEl.textContent = '';
        return;
      }
      const pending = data.reports.filter(r => r.status === 'pending').length;
      countEl.textContent = pending > 0 ? pending + ' pending' : '';
      container.innerHTML = data.reports.map(r => renderBugReport(r)).join('');
    })
    .catch(() => { container.innerHTML = '<p style="color:#e74c3c;">Failed to fetch reports.</p>'; });
}

function renderBugReport(report) {
  const statusColors = { pending: '#f39c12', approved: '#2ecc71', dismissed: '#888' };
  const statusColor = statusColors[report.status] || '#888';
  const firstLine = escapeHtml((report.error_pattern || '').split('\n')[0].substring(0, 120));
  const ts = new Date(report.created_at).toLocaleString();
  const actions = report.status === 'pending' ? `
    <div style="display:flex; gap:6px; margin-top:10px;">
      <button onclick="updateBugReport(${report.id}, 'approved')" style="background:rgba(46,204,113,0.15); color:#2ecc71; border:none; padding:5px 12px; border-radius:6px; font-size:11px; cursor:pointer; font-weight:600;">Approve Fix</button>
      <button onclick="updateBugReport(${report.id}, 'dismissed')" style="background:rgba(136,136,136,0.15); color:#888; border:none; padding:5px 12px; border-radius:6px; font-size:11px; cursor:pointer;">Dismiss</button>
    </div>` : '';

  return `
    <div style="border:1px solid rgba(255,255,255,0.06); border-radius:8px; margin-bottom:8px; overflow:hidden;">
      <div onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'" style="padding:10px 14px; cursor:pointer; display:flex; align-items:center; gap:8px; background:rgba(255,255,255,0.02);">
        <span style="width:8px; height:8px; border-radius:50%; background:${statusColor}; flex-shrink:0;"></span>
        <span style="font-size:12px; flex:1; color:var(--text-primary); font-family:monospace;">${firstLine}</span>
        <span style="font-size:10px; color:var(--text-muted);">${ts}</span>
        <span style="font-size:10px; padding:2px 6px; border-radius:4px; background:${statusColor}22; color:${statusColor}; font-weight:600; text-transform:uppercase;">${escapeHtml(report.status)}</span>
      </div>
      <div style="display:none; padding:12px 14px; border-top:1px solid rgba(255,255,255,0.04);">
        <div style="margin-bottom:8px;">
          <div style="font-size:10px; color:var(--text-muted); margin-bottom:4px; text-transform:uppercase; font-weight:600;">Error Pattern</div>
          <pre style="background:rgba(0,0,0,0.3); padding:8px; border-radius:6px; font-size:11px; color:#ef5350; white-space:pre-wrap; margin:0;">${escapeHtml(report.error_pattern)}</pre>
        </div>
        <div style="margin-bottom:8px;">
          <div style="font-size:10px; color:var(--text-muted); margin-bottom:4px; text-transform:uppercase; font-weight:600;">Why This Is Likely a Bug</div>
          <p style="font-size:12px; color:var(--text-secondary); margin:0; line-height:1.5;">${escapeHtml(report.explanation)}</p>
        </div>
        <div>
          <div style="font-size:10px; color:var(--text-muted); margin-bottom:4px; text-transform:uppercase; font-weight:600;">Suggested Fix</div>
          <p style="font-size:12px; color:var(--text-secondary); margin:0; line-height:1.5;">${escapeHtml(report.suggested_fix)}</p>
        </div>
        ${actions}
      </div>
    </div>`;
}

function updateBugReport(id, status) {
  fetch('/api/bridge-bug-reports/' + id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  }).then(() => fetchBugReports());
}
```

- [ ] **Step 4: Commit**

```bash
git add src/views/dashboard.ejs
git commit -m "feat: add Bridge Logs and Bug Reports UI to iRacing dashboard tab"
```

---

### Task 7: Scheduled Agent — Log analyzer

**Files:**
- Create: `docs/superpowers/specs/bridge-log-agent-prompt.md` (agent prompt reference)

This task sets up the scheduled Claude Code agent using the `schedule` skill. The agent will:

1. Fetch recent logs via `GET /api/bridge-logs/:bridgeId?hours=6`
2. Scan for error patterns (exceptions, stack traces, repeated failures)
3. Cross-reference with Bridge codebase to understand the likely cause
4. Check existing bug reports to avoid duplicates via `GET /api/bridge-bug-reports?bridgeId=:id`
5. Post new findings via `POST /api/bridge-bug-reports`

- [ ] **Step 1: Write the agent prompt**

Create `docs/superpowers/specs/bridge-log-agent-prompt.md`:

```markdown
# Bridge Log Analyzer Agent

You are analyzing logs from the Atleta Bridge Electron app (an iRacing telemetry overlay tool).

## Your Task

1. Fetch the last 6 hours of logs from: `GET https://atletanotifications.com/api/bridge-logs/BRIDGE_ID?hours=6`
2. Fetch existing bug reports to avoid duplicates: `GET https://atletanotifications.com/api/bridge-bug-reports?bridgeId=BRIDGE_ID`
3. Analyze the logs for:
   - JavaScript errors (TypeError, ReferenceError, unhandled rejections)
   - Repeated failures (same error appearing multiple times)
   - Crash patterns ([UNCAUGHT] entries)
   - Connection failures that suggest code issues (not transient network errors)
   - Telemetry parsing errors
4. For each NEW error pattern (not already in existing reports):
   - Read the relevant Bridge source code to understand the root cause
   - POST to `https://atletanotifications.com/api/bridge-bug-reports` with:
     - `bridgeId`: the Bridge ID
     - `errorPattern`: the relevant log lines
     - `explanation`: why this is likely a bug (reference specific code)
     - `suggestedFix`: concrete description of the code change needed

## Important
- Skip transient errors (network timeouts, iRacing not running)
- Skip expected log entries (startup messages, normal status updates)
- Only report errors that indicate actual code bugs
- Be specific about file names and line references in suggested fixes
- The Bridge code is in the `bridge/` directory of this repo
```

- [ ] **Step 2: Set up the scheduled agent using the schedule skill**

Use `/schedule` to create a recurring agent that runs every 6 hours with the prompt from the doc above. The Bridge ID will need to be configured at setup time.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/bridge-log-agent-prompt.md
git commit -m "docs: add Bridge log analyzer agent prompt"
```
