# Report Issue with Screenshots + AI Agent Triage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add screenshot uploads to the report issue form and build an AI-powered triage pipeline that analyzes bug reports, diagnoses issues in the bridge/racing code, and can auto-fix them via PR.

**Architecture:** User submits report with screenshots → server saves to SQLite + disk → async Claude API call analyzes report + bridge source → admin sees diagnosis + "Fix It" button → applies patch, creates git branch, pushes, opens GitHub PR.

**Tech Stack:** Anthropic SDK (`@anthropic-ai/sdk`), GitHub REST API (native `https`), existing Express/EJS/SQLite stack.

---

### Task 1: Install Anthropic SDK + Add Config

**Files:**
- Modify: `package.json:14-28` (dependencies)
- Modify: `src/config.js:48-58` (app config section)

- [ ] **Step 1: Install @anthropic-ai/sdk**

```bash
npm install @anthropic-ai/sdk
```

- [ ] **Step 2: Add env vars to config.js**

In `src/config.js`, add after the `paypal` block (line 48) and before `features`:

```js
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
  },
  github: {
    token: process.env.GITHUB_TOKEN || '',
    repo: process.env.GITHUB_REPO || '',
  },
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json src/config.js
git commit -m "chore: add @anthropic-ai/sdk dependency and config vars"
```

---

### Task 2: DB Migration — Add Columns to Issues Table

**Files:**
- Modify: `src/db.js:511-521` (issues table schema)
- Modify: `src/db.js:2346-2367` (issues queries)
- Modify: `src/db.js:3613-3616` (module.exports)

- [ ] **Step 1: Add migration for new columns**

Find the migration section in `src/db.js` (after the CREATE TABLE statements, where `ALTER TABLE` migrations run). Add:

```js
// --- Issues: screenshots + AI triage columns ---
try { db.exec("ALTER TABLE issues ADD COLUMN screenshots TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE issues ADD COLUMN agent_analysis TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE issues ADD COLUMN agent_status TEXT"); } catch(e) {}
```

- [ ] **Step 2: Update createIssue to return the new issue ID**

Replace the `createIssue` function at line ~2353:

```js
function createIssue(streamerId, discordUsername, subject, description) {
  const result = _createIssue.run(streamerId, discordUsername, subject, description);
  return result.lastInsertRowid;
}
```

- [ ] **Step 3: Add new prepared statements and functions**

After `updateIssueStatus` (line ~2365), add:

```js
const _updateIssueScreenshots = db.prepare('UPDATE issues SET screenshots = ? WHERE id = ?');
const _updateIssueAnalysis = db.prepare('UPDATE issues SET agent_analysis = ?, agent_status = ? WHERE id = ?');
const _updateIssueAgentStatus = db.prepare('UPDATE issues SET agent_status = ? WHERE id = ?');

function updateIssueScreenshots(id, screenshots) {
  _updateIssueScreenshots.run(screenshots, id);
}

function updateIssueAnalysis(id, analysis, status) {
  _updateIssueAnalysis.run(analysis, status, id);
}

function updateIssueAgentStatus(id, status) {
  _updateIssueAgentStatus.run(status, id);
}
```

- [ ] **Step 4: Export new functions**

In the `module.exports` block, after `updateIssueStatus,` (line ~3616), add:

```js
  updateIssueScreenshots,
  updateIssueAnalysis,
  updateIssueAgentStatus,
```

- [ ] **Step 5: Commit**

```bash
git add src/db.js
git commit -m "feat: add screenshots and AI triage columns to issues table"
```

---

### Task 3: Static Route for Issue Screenshots

**Files:**
- Modify: `src/server.js:40` (after avatars static route)

- [ ] **Step 1: Add static route**

In `src/server.js`, after the avatars static route (line 40), add:

```js
// Serve issue screenshots from persistent data volume
app.use('/issues-files', express.static(path.join(__dirname, '..', 'data', 'issues')));
```

- [ ] **Step 2: Commit**

```bash
git add src/server.js
git commit -m "feat: add static route for issue screenshot files"
```

---

### Task 4: Screenshot Upload Routes

**Files:**
- Modify: `src/routes/dashboard.js:1326-1346` (report routes)

- [ ] **Step 1: Rewrite POST /report to return JSON with issue ID**

Replace the existing `POST /report` handler at lines 1330-1346:

```js
router.post('/report', (req, res) => {
  const subject = (req.body.subject || '').trim();
  const description = (req.body.description || '').trim();

  if (!subject || !description) {
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  }

  const issueId = db.createIssue(
    req.streamer.id,
    req.streamer.discord_display_name || req.streamer.discord_username,
    subject,
    description
  );
  console.log(`[Dashboard] Issue #${issueId} reported by ${req.streamer.discord_username}: ${subject}`);
  res.json({ ok: true, issueId });
});
```

- [ ] **Step 2: Add screenshot upload endpoint**

After the POST /report handler, add:

```js
// Upload screenshot for an issue (raw body, same pattern as sponsors/avatars)
router.post('/report/:id/screenshot', (req, res) => {
  const issueId = parseInt(req.params.id);
  const issue = db.getIssueById(issueId);
  if (!issue || issue.streamer_id !== req.streamer.id) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }

  // Check max 3 screenshots
  const existing = issue.screenshots ? issue.screenshots.split(',').filter(Boolean) : [];
  if (existing.length >= 3) {
    return res.status(400).json({ ok: false, error: 'max_screenshots' });
  }

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    if (buf.length > 5 * 1024 * 1024) {
      return res.status(400).json({ ok: false, error: 'file_too_large' });
    }

    const issueDir = path.join(__dirname, '..', '..', 'data', 'issues', String(issueId));
    if (!fs.existsSync(issueDir)) fs.mkdirSync(issueDir, { recursive: true });

    const ext = (req.query.ext || 'png').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'png';
    const filename = `shot_${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(issueDir, filename), buf);

    existing.push(filename);
    db.updateIssueScreenshots(issueId, existing.join(','));
    res.json({ ok: true, filename });
  });
});
```

- [ ] **Step 3: Add analyze trigger endpoint**

After the screenshot upload endpoint, add:

```js
// Trigger AI analysis for an issue
router.post('/report/:id/analyze', (req, res) => {
  const issueId = parseInt(req.params.id);
  const issue = db.getIssueById(issueId);
  if (!issue || issue.streamer_id !== req.streamer.id) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }

  const config = require('../config');
  if (!config.anthropic.apiKey) {
    console.log('[Dashboard] Skipping AI analysis — no ANTHROPIC_API_KEY');
    return res.json({ ok: true, status: 'skipped' });
  }

  db.updateIssueAgentStatus(issueId, 'analyzing');
  res.json({ ok: true, status: 'analyzing' });

  // Fire async — don't await
  const { analyzeIssue } = require('../services/agentTriage');
  analyzeIssue(issueId).catch(err => {
    console.error(`[AgentTriage] Error analyzing issue #${issueId}:`, err.message);
    db.updateIssueAnalysis(issueId, JSON.stringify({ error: err.message }), 'error');
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add src/routes/dashboard.js
git commit -m "feat: add screenshot upload and AI analyze endpoints for issues"
```

---

### Task 5: Agent Triage Service

**Files:**
- Create: `src/services/agentTriage.js`

- [ ] **Step 1: Create the agent triage service**

Create `src/services/agentTriage.js`:

```js
const Anthropic = require('@anthropic-ai/sdk').default;
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');

const BRIDGE_DIR = path.join(__dirname, '..', '..', 'bridge');

// Bridge source files to include in context
const BRIDGE_FILES = [
  'main.js', 'telemetry.js', 'websocket.js', 'settings.js',
  'fuel-calculator.js', 'relative.js', 'keyboardSim.js',
  'voiceInput.js', 'sessionRecorder.js', 'trackExtractor.js',
];

const OVERLAY_DIR = path.join(BRIDGE_DIR, 'overlays');

function loadBridgeSources() {
  const sources = [];

  // Main bridge JS files
  for (const file of BRIDGE_FILES) {
    const filePath = path.join(BRIDGE_DIR, file);
    if (fs.existsSync(filePath)) {
      sources.push({ file: `bridge/${file}`, content: fs.readFileSync(filePath, 'utf8') });
    }
  }

  // Control panel HTML
  const cpPath = path.join(BRIDGE_DIR, 'control-panel.html');
  if (fs.existsSync(cpPath)) {
    sources.push({ file: 'bridge/control-panel.html', content: fs.readFileSync(cpPath, 'utf8') });
  }

  // All overlay HTML files
  if (fs.existsSync(OVERLAY_DIR)) {
    const overlays = fs.readdirSync(OVERLAY_DIR).filter(f => f.endsWith('.html'));
    for (const file of overlays) {
      sources.push({
        file: `bridge/overlays/${file}`,
        content: fs.readFileSync(path.join(OVERLAY_DIR, file), 'utf8'),
      });
    }
  }

  // Server-side racing route
  const racingPath = path.join(__dirname, '..', 'routes', 'racing.js');
  if (fs.existsSync(racingPath)) {
    sources.push({ file: 'src/routes/racing.js', content: fs.readFileSync(racingPath, 'utf8') });
  }

  return sources;
}

function loadScreenshots(issueId, screenshotNames) {
  const images = [];
  const issueDir = path.join(__dirname, '..', '..', 'data', 'issues', String(issueId));
  if (!screenshotNames || !fs.existsSync(issueDir)) return images;

  const files = screenshotNames.split(',').filter(Boolean);
  for (const file of files) {
    const filePath = path.join(issueDir, file);
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath);
      const ext = path.extname(file).slice(1).toLowerCase();
      const mediaType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      images.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: data.toString('base64') },
      });
    }
  }
  return images;
}

const SYSTEM_PROMPT = `You are a senior developer triaging a bug report for Atleta Bridge, an Electron desktop app for iRacing sim racing. The app reads iRacing telemetry via shared memory (node-iracing-sdk) and displays transparent always-on-top overlays (standings, relative, fuel, wind, track map, driver card, session laps, weather, inputs, race duration, voice chat, etc.). It has a WebSocket server on port 9100, a control panel for settings, and session recording.

Your job:
1. Analyze the bug description and any screenshots provided
2. Search the source code to identify the likely root cause — cite specific file(s) and line(s)
3. Assess whether you can produce a reliable fix
4. If fixable, produce a JSON patch array with exact string replacements

Respond with ONLY valid JSON (no markdown fences):
{
  "summary": "Brief 1-2 sentence diagnosis",
  "root_cause": "Detailed explanation — which file, what code, why it fails",
  "can_fix": true or false,
  "confidence": "high" or "medium" or "low",
  "patch": [
    {
      "file": "bridge/main.js",
      "old": "exact existing code to replace (copy-paste from source)",
      "new": "replacement code"
    }
  ],
  "notes": "Caveats, things to watch, or testing suggestions"
}

If you cannot fix it, set can_fix to false, patch to [], and explain why in notes.
Keep patches minimal — fix only what's broken, don't refactor surrounding code.`;

async function analyzeIssue(issueId) {
  const issue = db.getIssueById(issueId);
  if (!issue) throw new Error('Issue not found');

  console.log(`[AgentTriage] Analyzing issue #${issueId}: ${issue.subject}`);
  db.updateIssueAgentStatus(issueId, 'analyzing');

  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  // Build source code context
  const sources = loadBridgeSources();
  const sourceContext = sources.map(s => `--- ${s.file} ---\n${s.content}`).join('\n\n');

  // Build user message content (text + optional images)
  const content = [];

  // Add screenshots first (vision)
  const screenshots = loadScreenshots(issueId, issue.screenshots);
  for (const img of screenshots) {
    content.push(img);
  }

  // Add the bug report text + source code
  content.push({
    type: 'text',
    text: `## Bug Report\n\n**Subject:** ${issue.subject}\n\n**Description:** ${issue.description}\n\n**Reported by:** ${issue.discord_username}\n\n## Source Code\n\n${sourceContext}`,
  });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6-20250514',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  });

  const text = response.content.find(b => b.type === 'text')?.text || '';

  // Parse JSON response (strip markdown fences if present)
  let analysis;
  try {
    const cleaned = text.replace(/^```json?\s*\n?/m, '').replace(/\n?```\s*$/m, '');
    analysis = JSON.parse(cleaned);
  } catch (e) {
    analysis = { summary: 'Failed to parse AI response', root_cause: text, can_fix: false, confidence: 'low', patch: [], notes: 'Raw response saved' };
  }

  db.updateIssueAnalysis(issueId, JSON.stringify(analysis), 'done');
  console.log(`[AgentTriage] Issue #${issueId} analyzed: can_fix=${analysis.can_fix}, confidence=${analysis.confidence}`);
  return analysis;
}

module.exports = { analyzeIssue };
```

- [ ] **Step 2: Commit**

```bash
git add src/services/agentTriage.js
git commit -m "feat: add AI agent triage service for issue analysis"
```

---

### Task 6: Auto-Fix Service

**Files:**
- Create: `src/services/autoFix.js`

- [ ] **Step 1: Create the auto-fix service**

Create `src/services/autoFix.js`:

```js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');
const config = require('../config');
const db = require('../db');

const REPO_ROOT = path.join(__dirname, '..', '..');

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function getRepoInfo() {
  if (config.github.repo) return config.github.repo;
  try {
    const remote = execSync('git remote get-url origin', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    // Handle SSH: git@github.com:owner/repo.git
    const sshMatch = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];
    // Handle HTTPS: https://github.com/owner/repo.git
    const httpsMatch = remote.match(/github\.com\/(.+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];
  } catch (e) {}
  throw new Error('Could not determine GitHub repo — set GITHUB_REPO env var');
}

function applyPatch(patch) {
  const backups = [];

  for (const entry of patch) {
    const filePath = path.join(REPO_ROOT, entry.file);
    if (!fs.existsSync(filePath)) {
      // Rollback
      for (const b of backups) fs.writeFileSync(b.path, b.content);
      throw new Error(`File not found: ${entry.file}`);
    }

    const original = fs.readFileSync(filePath, 'utf8');
    if (!original.includes(entry.old)) {
      // Rollback
      for (const b of backups) fs.writeFileSync(b.path, b.content);
      throw new Error(`Patch string not found in ${entry.file} — code may have changed since analysis`);
    }

    backups.push({ path: filePath, content: original });
    const patched = original.replace(entry.old, entry.new);
    fs.writeFileSync(filePath, patched);
  }

  return backups;
}

function rollback(backups) {
  for (const b of backups) {
    fs.writeFileSync(b.path, b.content);
  }
}

function githubApi(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const repo = getRepoInfo();
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${repo}${endpoint}`,
      method,
      headers: {
        'Authorization': `Bearer ${config.github.token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'atleta-autofix',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    };
    if (data) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`GitHub API ${res.statusCode}: ${body}`));
        }
        try { resolve(JSON.parse(body)); } catch { resolve(body); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function fixIssue(issueId) {
  const issue = db.getIssueById(issueId);
  if (!issue) throw new Error('Issue not found');
  if (!issue.agent_analysis) throw new Error('No AI analysis available');

  const analysis = JSON.parse(issue.agent_analysis);
  if (!analysis.can_fix || !analysis.patch || analysis.patch.length === 0) {
    throw new Error('AI analysis indicates this issue cannot be auto-fixed');
  }

  if (!config.github.token) {
    throw new Error('GITHUB_TOKEN not configured');
  }

  const branchName = `fix/issue-${issueId}-${slugify(issue.subject)}`;
  const mainBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

  console.log(`[AutoFix] Applying patch for issue #${issueId} on branch ${branchName}`);

  // Apply patches
  const backups = applyPatch(analysis.patch);

  try {
    // Create branch, stage, commit, push
    execSync(`git checkout -b ${branchName}`, { cwd: REPO_ROOT, encoding: 'utf8' });
    const changedFiles = analysis.patch.map(p => p.file).join(' ');
    execSync(`git add ${changedFiles}`, { cwd: REPO_ROOT, encoding: 'utf8' });
    execSync(`git commit -m "fix: ${issue.subject} (auto-fix from issue #${issueId})"`, { cwd: REPO_ROOT, encoding: 'utf8' });
    execSync(`git push origin ${branchName}`, { cwd: REPO_ROOT, encoding: 'utf8' });

    // Create PR
    const pr = await githubApi('POST', '/pulls', {
      title: `fix: ${issue.subject} (auto-fix #${issueId})`,
      body: `## Auto-Fix for Issue #${issueId}\n\n**Problem:** ${analysis.summary}\n\n**Root Cause:** ${analysis.root_cause}\n\n**Confidence:** ${analysis.confidence}\n\n**Notes:** ${analysis.notes || 'None'}\n\n---\n_This PR was generated automatically by the Atleta AI Agent Triage system._`,
      head: branchName,
      base: mainBranch,
    });

    // Switch back to main
    execSync(`git checkout ${mainBranch}`, { cwd: REPO_ROOT, encoding: 'utf8' });

    // Update issue
    db.updateIssueStatus(issueId, 'in_progress', `Auto-fix PR created: ${pr.html_url}`);
    console.log(`[AutoFix] PR created for issue #${issueId}: ${pr.html_url}`);

    return { ok: true, pr_url: pr.html_url, branch: branchName };
  } catch (err) {
    // Rollback file changes
    rollback(backups);
    // Try to switch back to main and delete the branch
    try {
      execSync(`git checkout ${mainBranch}`, { cwd: REPO_ROOT, encoding: 'utf8' });
      execSync(`git branch -D ${branchName}`, { cwd: REPO_ROOT, encoding: 'utf8' });
    } catch (e) {}
    throw err;
  }
}

module.exports = { fixIssue };
```

- [ ] **Step 2: Commit**

```bash
git add src/services/autoFix.js
git commit -m "feat: add auto-fix service — patch application, git branch, GitHub PR"
```

---

### Task 7: Admin Fix Endpoint

**Files:**
- Modify: `src/routes/admin.js:124` (after existing issues POST handler)

- [ ] **Step 1: Add the fix endpoint**

In `src/routes/admin.js`, after the existing `POST /issues/:id` handler (line 124), add:

```js
// Auto-fix an issue using AI-generated patch
router.post('/issues/:id/fix', requireAdmin, async (req, res) => {
  try {
    const { fixIssue } = require('../services/autoFix');
    const result = await fixIssue(parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    console.error(`[Admin] Auto-fix failed for issue #${req.params.id}:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/admin.js
git commit -m "feat: add admin auto-fix endpoint for AI-patched issues"
```

---

### Task 8: Report Issue Form — Screenshot Upload UI

**Files:**
- Modify: `src/views/report-issue.ejs` (full rewrite)

- [ ] **Step 1: Rewrite report-issue.ejs with drag-and-drop screenshots**

Replace the entire contents of `src/views/report-issue.ejs`:

```html
<%- include('header', { title: 'Report an Issue', streamer: streamer }) %>

<a href="/dashboard" style="color: #adadb8; font-size: 14px;">&larr; Back to Dashboard</a>
<h2 style="margin: 12px 0 20px;">Report an Issue</h2>

<div id="successMsg" style="display: none;" class="alert alert-success">Your issue has been submitted. AI analysis is in progress!</div>
<div id="errorMsg" style="display: none;" class="alert" style="background: #e74c3c33; border: 1px solid #e74c3c;"></div>

<div class="card" id="reportForm">
  <p style="color: #adadb8; font-size: 14px; margin-bottom: 16px;">Found a bug or have a suggestion? Let us know and we'll take a look.</p>
  <form id="issueForm" onsubmit="return submitIssue(event)">
    <div class="form-group">
      <label>Subject</label>
      <input type="text" id="issueSubject" placeholder="Brief description of the issue" required>
    </div>
    <div class="form-group">
      <label>Description</label>
      <textarea id="issueDescription" placeholder="Describe the issue in detail. Include steps to reproduce if it's a bug." required style="min-height: 120px;"></textarea>
    </div>

    <!-- Screenshot Upload Zone -->
    <div class="form-group">
      <label>Screenshots (optional, max 3)</label>
      <div id="dropZone" style="border: 2px dashed var(--border); border-radius: var(--radius); padding: 24px; text-align: center; cursor: pointer; transition: border-color 0.2s, background 0.2s;"
           ondragover="event.preventDefault(); this.style.borderColor='var(--accent)'; this.style.background='rgba(99,102,241,0.05)'"
           ondragleave="this.style.borderColor='var(--border)'; this.style.background='transparent'"
           ondrop="handleDrop(event)"
           onclick="document.getElementById('fileInput').click()">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 8px;">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
        </svg>
        <div style="color: var(--text-muted); font-size: 13px;">Drop screenshots here or click to browse</div>
        <div style="color: var(--text-muted); font-size: 11px; margin-top: 4px;">PNG, JPG, GIF, WebP — max 5MB each</div>
      </div>
      <input type="file" id="fileInput" accept="image/png,image/jpeg,image/gif,image/webp" multiple style="display: none" onchange="handleFiles(this.files)">
    </div>

    <!-- Thumbnail Previews -->
    <div id="previews" style="display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px;"></div>

    <button type="submit" class="btn btn-primary" id="submitBtn">Submit Issue</button>
  </form>
</div>

<script>
const MAX_FILES = 3;
const MAX_SIZE = 5 * 1024 * 1024;
const ALLOWED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
let selectedFiles = [];

function handleDrop(e) {
  e.preventDefault();
  e.target.closest('#dropZone').style.borderColor = 'var(--border)';
  e.target.closest('#dropZone').style.background = 'transparent';
  handleFiles(e.dataTransfer.files);
}

function handleFiles(fileList) {
  for (const file of fileList) {
    if (selectedFiles.length >= MAX_FILES) break;
    if (!ALLOWED.includes(file.type)) continue;
    if (file.size > MAX_SIZE) continue;
    if (selectedFiles.some(f => f.name === file.name && f.size === file.size)) continue;
    selectedFiles.push(file);
  }
  renderPreviews();
}

function removeFile(idx) {
  selectedFiles.splice(idx, 1);
  renderPreviews();
}

function renderPreviews() {
  const container = document.getElementById('previews');
  container.innerHTML = '';
  selectedFiles.forEach((file, idx) => {
    const div = document.createElement('div');
    div.style.cssText = 'position: relative; width: 80px; height: 80px; border-radius: var(--radius-sm); overflow: hidden; border: 1px solid var(--border);';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    img.style.cssText = 'width: 100%; height: 100%; object-fit: cover;';
    img.onload = () => URL.revokeObjectURL(img.src);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.innerHTML = '&times;';
    btn.style.cssText = 'position: absolute; top: 2px; right: 2px; background: rgba(0,0,0,0.7); color: #fff; border: none; border-radius: 50%; width: 20px; height: 20px; cursor: pointer; font-size: 14px; line-height: 18px; padding: 0;';
    btn.onclick = () => removeFile(idx);
    div.appendChild(img);
    div.appendChild(btn);
    container.appendChild(div);
  });
  // Update drop zone text if at max
  const zone = document.getElementById('dropZone');
  if (selectedFiles.length >= MAX_FILES) {
    zone.style.opacity = '0.5';
    zone.style.pointerEvents = 'none';
  } else {
    zone.style.opacity = '1';
    zone.style.pointerEvents = 'auto';
  }
}

async function submitIssue(e) {
  e.preventDefault();
  const subject = document.getElementById('issueSubject').value.trim();
  const description = document.getElementById('issueDescription').value.trim();
  if (!subject || !description) return;

  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting...';
  document.getElementById('errorMsg').style.display = 'none';

  try {
    // Step 1: Create issue
    const res = await fetch('/dashboard/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, description }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to submit');

    const issueId = data.issueId;

    // Step 2: Upload screenshots
    for (const file of selectedFiles) {
      const ext = file.name.split('.').pop().toLowerCase();
      const buf = await file.arrayBuffer();
      await fetch(`/dashboard/report/${issueId}/screenshot?ext=${ext}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      });
    }

    // Step 3: Trigger AI analysis
    await fetch(`/dashboard/report/${issueId}/analyze`, { method: 'POST' });

    // Show success
    document.getElementById('reportForm').style.display = 'none';
    document.getElementById('successMsg').style.display = 'block';
  } catch (err) {
    const errEl = document.getElementById('errorMsg');
    errEl.textContent = err.message || 'Something went wrong. Please try again.';
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Submit Issue';
  }
}
</script>

<%- include('footer') %>
```

- [ ] **Step 2: Update GET /report to remove query param dependency**

In `src/routes/dashboard.js`, update the GET /report handler (line ~1326):

```js
router.get('/report', (req, res) => {
  res.render('report-issue', { streamer: req.streamer });
});
```

- [ ] **Step 3: Commit**

```bash
git add src/views/report-issue.ejs src/routes/dashboard.js
git commit -m "feat: report issue form with drag-and-drop screenshot uploads"
```

---

### Task 9: Admin Dashboard — AI Analysis Display + Fix Button

**Files:**
- Modify: `src/views/admin-dashboard.ejs:168-207` (issues tab)

- [ ] **Step 1: Replace the issues tab content**

Replace the issues tab section (lines 168-207) in `src/views/admin-dashboard.ejs`:

```html
<!-- ==================== ISSUES TAB ==================== -->
<div class="tab-content" id="tab-issues">
  <% if (issues.length === 0) { %>
    <div class="card" style="text-align: center; padding: 40px; color: var(--text-muted);">No issues reported yet.</div>
  <% } else { %>
    <% for (const issue of issues) { %>
      <div class="card" style="padding: 16px; margin-bottom: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;">
          <div>
            <div style="font-weight: 600; margin-bottom: 4px;"><%= issue.subject %></div>
            <div style="font-size: 12px; color: var(--text-muted);">by <%= issue.discord_username || 'Unknown' %> &middot; <%= issue.created_at?.split('T')[0] || '' %></div>
          </div>
          <span style="font-size: 10px; padding: 3px 8px; border-radius: 4px; font-weight: 600; text-transform: uppercase;
            background: <%= issue.status === 'open' ? 'var(--warning-bg)' : issue.status === 'resolved' ? 'var(--success-bg)' : 'var(--accent-glow)' %>;
            color: <%= issue.status === 'open' ? 'var(--warning)' : issue.status === 'resolved' ? 'var(--success)' : 'var(--accent)' %>;">
            <%= issue.status %>
          </span>
        </div>
        <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 12px; white-space: pre-wrap;"><%= issue.description %></p>

        <%# --- Screenshots --- %>
        <% if (issue.screenshots) { %>
          <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px;">
            <% for (const shot of issue.screenshots.split(',').filter(Boolean)) { %>
              <a href="/issues-files/<%= issue.id %>/<%= shot %>" target="_blank" style="display: block; width: 100px; height: 75px; border-radius: var(--radius-sm); overflow: hidden; border: 1px solid var(--border);">
                <img src="/issues-files/<%= issue.id %>/<%= shot %>" style="width: 100%; height: 100%; object-fit: cover;" loading="lazy">
              </a>
            <% } %>
          </div>
        <% } %>

        <%# --- AI Analysis --- %>
        <% if (issue.agent_status === 'analyzing') { %>
          <div style="background: var(--bg-base); border-radius: var(--radius-sm); padding: 12px; margin-bottom: 12px; border-left: 3px solid var(--warning);">
            <div style="display: flex; align-items: center; gap: 8px;">
              <div style="width: 14px; height: 14px; border: 2px solid var(--warning); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
              <span style="font-size: 12px; color: var(--warning);">AI is analyzing this issue...</span>
            </div>
          </div>
        <% } else if (issue.agent_status === 'done' && issue.agent_analysis) { %>
          <% const analysis = JSON.parse(issue.agent_analysis); %>
          <div style="background: var(--bg-base); border-radius: var(--radius-sm); padding: 12px; margin-bottom: 12px; border-left: 3px solid <%= analysis.can_fix ? 'var(--success)' : 'var(--text-muted)' %>;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <div style="font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">AI Analysis</div>
              <span style="font-size: 10px; padding: 2px 8px; border-radius: 4px; font-weight: 600;
                background: <%= analysis.confidence === 'high' ? 'var(--success-bg)' : analysis.confidence === 'medium' ? 'var(--warning-bg)' : '#e74c3c33' %>;
                color: <%= analysis.confidence === 'high' ? 'var(--success)' : analysis.confidence === 'medium' ? 'var(--warning)' : '#e74c3c' %>;">
                <%= analysis.confidence %> confidence
              </span>
            </div>
            <p style="font-size: 13px; color: var(--text-primary); margin-bottom: 6px; font-weight: 500;"><%= analysis.summary %></p>
            <details style="margin-bottom: 8px;">
              <summary style="font-size: 12px; color: var(--accent); cursor: pointer;">Root cause details</summary>
              <p style="font-size: 12px; color: var(--text-secondary); margin-top: 6px; white-space: pre-wrap;"><%= analysis.root_cause %></p>
              <% if (analysis.notes) { %>
                <p style="font-size: 12px; color: var(--text-muted); margin-top: 6px;"><strong>Notes:</strong> <%= analysis.notes %></p>
              <% } %>
              <% if (analysis.patch && analysis.patch.length > 0) { %>
                <div style="margin-top: 8px;">
                  <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">Files to patch:</div>
                  <% for (const p of analysis.patch) { %>
                    <code style="font-size: 11px; background: var(--bg-elevated); padding: 2px 6px; border-radius: 3px; margin-right: 4px;"><%= p.file %></code>
                  <% } %>
                </div>
              <% } %>
            </details>
            <% if (analysis.can_fix) { %>
              <button onclick="fixIssue(<%= issue.id %>, this)" class="btn btn-primary" style="padding: 6px 16px; font-size: 12px;">
                Fix It &amp; Create PR
              </button>
            <% } %>
          </div>
        <% } else if (issue.agent_status === 'error' && issue.agent_analysis) { %>
          <div style="background: #e74c3c11; border-radius: var(--radius-sm); padding: 10px; margin-bottom: 12px; border-left: 3px solid #e74c3c;">
            <div style="font-size: 11px; color: #e74c3c; font-weight: 600;">AI Analysis Error</div>
            <p style="font-size: 12px; color: var(--text-muted); margin-top: 4px;"><%= JSON.parse(issue.agent_analysis).error || 'Unknown error' %></p>
          </div>
        <% } %>

        <% if (issue.admin_reply) { %>
          <div style="background: var(--bg-base); border-radius: var(--radius-sm); padding: 10px; margin-bottom: 10px; border-left: 3px solid var(--accent);">
            <div style="font-size: 10px; color: var(--text-muted); margin-bottom: 4px;">Admin Reply</div>
            <p style="font-size: 13px; color: var(--text-primary);"><%= issue.admin_reply %></p>
          </div>
        <% } %>
        <form method="POST" action="/admin/issues/<%= issue.id %>" style="display: flex; gap: 8px; align-items: flex-end;">
          <div style="flex: 1;">
            <input type="text" name="admin_reply" placeholder="Reply..." value="<%= issue.admin_reply || '' %>" style="width: 100%; padding: 8px 12px; background: var(--bg-base); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 13px;">
          </div>
          <select name="status" style="padding: 8px 10px; background: var(--bg-base); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 12px;">
            <% ['open', 'in_progress', 'resolved', 'closed'].forEach(function(s) { %>
              <option value="<%= s %>" <%= issue.status === s ? 'selected' : '' %>><%= s.replace('_', ' ') %></option>
            <% }); %>
          </select>
          <button type="submit" class="btn btn-primary" style="padding: 8px 16px; font-size: 12px;">Update</button>
        </form>
      </div>
    <% } %>
  <% } %>
</div>
```

- [ ] **Step 2: Add the fixIssue JavaScript function**

Find the `<script>` block at the bottom of `admin-dashboard.ejs` (before `</script>` closing tag) and add:

```js
async function fixIssue(issueId, btn) {
  if (!confirm('Apply the AI-generated fix and create a PR?')) return;
  btn.disabled = true;
  btn.textContent = 'Applying fix...';
  try {
    const res = await fetch(`/admin/issues/${issueId}/fix`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      btn.textContent = 'PR Created!';
      btn.style.background = 'var(--success)';
      if (data.pr_url) {
        const link = document.createElement('a');
        link.href = data.pr_url;
        link.target = '_blank';
        link.textContent = 'View PR';
        link.style.cssText = 'margin-left: 8px; color: var(--accent); font-size: 12px;';
        btn.parentNode.appendChild(link);
      }
    } else {
      alert('Fix failed: ' + (data.error || 'Unknown error'));
      btn.disabled = false;
      btn.textContent = 'Fix It & Create PR';
    }
  } catch (err) {
    alert('Fix failed: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Fix It & Create PR';
  }
}
```

- [ ] **Step 3: Add the spin animation CSS**

In the `<style>` block of `admin-dashboard.ejs`, add:

```css
@keyframes spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 4: Commit**

```bash
git add src/views/admin-dashboard.ejs
git commit -m "feat: admin dashboard — AI analysis display, screenshots, Fix It button"
```

---

### Task 10: Wire Up JSON Body Parsing for Report Route

**Files:**
- Modify: `src/routes/dashboard.js:1330` (POST /report handler)

- [ ] **Step 1: Ensure JSON body parsing works for the report route**

The existing Express app likely has `express.json()` middleware. Verify by checking `src/server.js` for `express.json()`. If it's present, no changes needed. If not, the `POST /report` handler needs to parse JSON from `req.body`. Since Express v5 includes built-in body parsing, check that `app.use(express.json())` is set up in `server.js`.

Search `src/server.js` for `express.json` or `bodyParser`. If missing, add after the static routes:

```js
app.use(express.json({ limit: '1mb' }));
```

- [ ] **Step 2: Commit (only if changes were needed)**

```bash
git add src/server.js
git commit -m "chore: ensure JSON body parsing is configured"
```

---

### Task 11: End-to-End Test

**Files:**
- No new test files — manual testing

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```

- [ ] **Step 2: Test the report form**

1. Navigate to `/dashboard/report`
2. Fill in subject and description
3. Drag and drop 1-2 screenshots
4. Verify thumbnails appear with remove buttons
5. Submit — should show success message
6. Check `data/issues/` directory for saved screenshots
7. Check SQLite for the new issue row with `screenshots` and `agent_status` columns

- [ ] **Step 3: Test admin view**

1. Navigate to `/admin/dashboard?tab=issues`
2. Verify the issue shows with screenshots thumbnails (clickable to full size)
3. If `ANTHROPIC_API_KEY` is set, verify AI analysis appears after a few seconds (refresh page)
4. If analysis shows `can_fix: true`, click "Fix It & Create PR" and verify PR is created on GitHub

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: report issue with screenshots and AI agent triage pipeline"
```
