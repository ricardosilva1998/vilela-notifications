# Screenshot Lap Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to import race data from Garage61 screenshots on the track detail page, using GPT-4o vision for extraction, feeding into existing `track_stats` table.

**Architecture:** Client reads screenshot as base64, sends to server endpoint which forwards to OpenAI GPT-4o vision API. Parsed data is shown in a confirmation card. On save, data is POSTed to the existing `POST /api/track-stats` upsert endpoint.

**Tech Stack:** Express, OpenAI API (GPT-4o-mini vision), client-side FileReader, existing track_stats infrastructure

---

### Task 1: Server endpoint — screenshot analysis via GPT-4o vision

**Files:**
- Modify: `src/server.js` (add endpoint after `POST /api/track-stats` around line 224)

- [ ] **Step 1: Add the import-screenshot endpoint**

In `src/server.js`, add after the `POST /api/track-stats` endpoint (after line 224, before `app.get('/api/track-stats', ...)`):

```javascript
// Screenshot import — analyze Garage61 screenshot via GPT-4o vision
app.post('/api/track-stats/import-screenshot', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    if (!req.streamer) return res.status(401).json({ error: 'Login required' });

    const { image, trackName, carClass, raceType } = req.body;
    if (!image || !trackName) return res.status(400).json({ error: 'image and trackName required' });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OpenAI API key not configured' });

    // Strip data URL prefix if present
    const base64 = image.replace(/^data:image\/\w+;base64,/, '');

    const https = require('https');
    const postData = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'You are analyzing a screenshot from Garage61, a racing data website for iRacing. Extract the following race statistics from the image. Return ONLY valid JSON, no markdown, no code fences, no other text.\n\n{\n  "carClass": "the car class (e.g. GT3, GTP, LMP2, GT4, LMP3, GTE, TCR, Porsche Cup, BMW M2, Toyota, Mazda) or null if not visible",\n  "raceType": "the race/series type (e.g. VRS Sprint, VRS Open, IMSA Sprint, IMSA Open, IMSA Endurance, Global Endurance, Sprint, Open, Endurance, Regionals, LMP2 Sprint, Proto Sprint) or null if not visible",\n  "avgLapTime": "average race lap time in seconds (e.g. 92.456 for 1:32.456) or null",\n  "avgQualifyTime": "average qualifying lap time in seconds or null",\n  "avgPitTime": "average pit stop time in seconds or null",\n  "avgSOF": "strength of field as a number or null",\n  "driverCount": "number of drivers in the session or null",\n  "estLaps": "total number of race laps completed or null"\n}\n\nParse lap times from formats like "1:32.456" to total seconds (92.456). If a value is not visible in the screenshot, set it to null.'
          },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,' + base64 }
          }
        ]
      }],
      max_tokens: 500,
    });

    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        timeout: 30000,
      }, (resp) => {
        let body = '';
        resp.on('data', chunk => body += chunk);
        resp.on('end', () => {
          try { resolve(JSON.parse(body)); } catch(e) { reject(new Error('Invalid OpenAI response')); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('OpenAI request timed out')); });
      req.write(postData);
      req.end();
    });

    if (result.error) {
      console.error('[ScreenshotImport] OpenAI error:', result.error.message);
      return res.status(500).json({ error: 'OpenAI error: ' + result.error.message });
    }

    const content = result.choices?.[0]?.message?.content;
    if (!content) return res.status(500).json({ error: 'No response from OpenAI' });

    let parsed;
    try {
      // Strip markdown code fences if present
      const clean = content.replace(/```json?\s*/g, '').replace(/```\s*/g, '').trim();
      parsed = JSON.parse(clean);
    } catch(e) {
      console.error('[ScreenshotImport] Failed to parse:', content);
      return res.status(500).json({ error: 'Could not parse AI response' });
    }

    // Override with user selections if not "auto"
    const data = {
      carClass: (carClass && carClass !== 'auto') ? carClass : (parsed.carClass || null),
      raceType: (raceType && raceType !== 'auto') ? raceType : (parsed.raceType || null),
      avgLapTime: parsed.avgLapTime ? Number(parsed.avgLapTime) : null,
      avgQualifyTime: parsed.avgQualifyTime ? Number(parsed.avgQualifyTime) : null,
      avgPitTime: parsed.avgPitTime ? Number(parsed.avgPitTime) : null,
      avgSOF: parsed.avgSOF ? Number(parsed.avgSOF) : null,
      driverCount: parsed.driverCount ? Number(parsed.driverCount) : null,
      estLaps: parsed.estLaps ? Number(parsed.estLaps) : null,
    };

    res.json({ ok: true, data });
  } catch(e) {
    console.error('[ScreenshotImport] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Verify the endpoint works**

Start the server with `npm run dev`, then test with a simple curl (no real image, just checking the endpoint responds):

```bash
curl -X POST http://localhost:3000/api/track-stats/import-screenshot \
  -H "Content-Type: application/json" \
  -H "Cookie: session=YOUR_SESSION" \
  -d '{"image":"dGVzdA==","trackName":"test"}'
```

Expected: Either OpenAI processes it or returns a parsing error (not a 500 crash).

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "feat: add screenshot import endpoint using GPT-4o vision

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Track detail UI — import section with dropdowns and drop zone

**Files:**
- Modify: `src/views/tracks.ejs`

- [ ] **Step 1: Add CSS for the import section**

In `src/views/tracks.ejs`, find the closing `</style>` tag (line 80). Add before it:

```css
  /* Import Section */
  .import-section { margin-top: 24px; }
  .import-toggle { background: none; border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; padding: 8px 16px; color: rgba(255,255,255,0.6); font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; }
  .import-toggle:hover { color: #fff; border-color: rgba(255,255,255,0.3); }
  .import-toggle svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; }
  .import-panel { display: none; margin-top: 16px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 20px; }
  .import-panel.open { display: block; }
  .import-controls { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; align-items: flex-end; }
  .import-field { display: flex; flex-direction: column; gap: 4px; }
  .import-field label { font-size: 11px; color: rgba(255,255,255,0.4); text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px; }
  .import-field select { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 8px 12px; color: #fff; font-size: 13px; min-width: 160px; }
  .import-dropzone { border: 2px dashed rgba(255,255,255,0.12); border-radius: 10px; padding: 32px; text-align: center; cursor: pointer; transition: all 0.2s; }
  .import-dropzone:hover, .import-dropzone.dragover { border-color: var(--accent, #9146ff); background: rgba(145,70,255,0.05); }
  .import-dropzone-text { font-size: 14px; font-weight: 600; color: rgba(255,255,255,0.5); margin-bottom: 4px; }
  .import-dropzone-hint { font-size: 12px; color: rgba(255,255,255,0.25); }
  .import-spinner { display: none; text-align: center; padding: 24px; color: rgba(255,255,255,0.5); font-size: 13px; }
  .import-spinner.active { display: block; }
  .import-confirm { display: none; margin-top: 16px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 16px; }
  .import-confirm.active { display: block; }
  .import-confirm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; margin-bottom: 16px; }
  .import-confirm-item { text-align: center; padding: 8px; }
  .import-confirm-value { font-size: 18px; font-weight: 700; color: #fff; font-family: 'JetBrains Mono', monospace; }
  .import-confirm-label { font-size: 10px; color: rgba(255,255,255,0.4); text-transform: uppercase; }
  .import-confirm-actions { display: flex; gap: 8px; }
  .btn-save-import { background: #3ecf8e; color: #000; border: none; border-radius: 8px; padding: 8px 20px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .btn-save-import:hover { filter: brightness(1.1); }
  .btn-save-import:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-cancel-import { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.6); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 8px 20px; font-size: 13px; cursor: pointer; }
  .import-error { color: #f04438; font-size: 13px; margin-top: 8px; }
  .import-success { color: #3ecf8e; font-size: 13px; margin-top: 8px; }
```

- [ ] **Step 2: Add HTML for the import section**

In `src/views/tracks.ejs`, find line 122 (`<div id="class-stats-content"></div>`). Add after it:

```html
    <!-- Screenshot Import -->
    <div class="import-section">
      <button class="import-toggle" onclick="toggleImport()">
        <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        Import Race Data
      </button>
      <div class="import-panel" id="import-panel">
        <div class="import-controls">
          <div class="import-field">
            <label>Car Class</label>
            <select id="import-class">
              <option value="auto">Auto-detect</option>
              <option value="GTP">GTP</option>
              <option value="LMP2">LMP2</option>
              <option value="GT3">GT3</option>
              <option value="LMP3">LMP3</option>
              <option value="GT4">GT4</option>
              <option value="GTE">GTE</option>
              <option value="TCR">TCR</option>
              <option value="Porsche Cup">Porsche Cup</option>
              <option value="BMW M2">BMW M2</option>
              <option value="Toyota">Toyota</option>
              <option value="Mazda">Mazda</option>
            </select>
          </div>
          <div class="import-field">
            <label>Race Type</label>
            <select id="import-race-type">
              <option value="auto">Auto-detect</option>
              <option value="Sprint">Sprint</option>
              <option value="Open">Open</option>
              <option value="Endurance">Endurance</option>
              <option value="Regionals">Regionals</option>
              <option value="VRS Sprint">VRS Sprint</option>
              <option value="VRS Open">VRS Open</option>
              <option value="IMSA Sprint">IMSA Sprint</option>
              <option value="IMSA Open">IMSA Open</option>
              <option value="IMSA Endurance">IMSA Endurance</option>
              <option value="Global Endurance">Global Endurance</option>
              <option value="LMP2 Sprint">LMP2 Sprint</option>
              <option value="Proto Sprint">Proto Sprint</option>
            </select>
          </div>
        </div>
        <div class="import-dropzone" id="import-dropzone"
          ondragover="event.preventDefault(); this.classList.add('dragover');"
          ondragleave="this.classList.remove('dragover');"
          ondrop="event.preventDefault(); this.classList.remove('dragover'); handleImportDrop(event);"
          onclick="document.getElementById('import-file-input').click();">
          <input type="file" id="import-file-input" accept="image/*" style="display:none" onchange="handleImportFile(this.files[0])">
          <div class="import-dropzone-text">Drop Garage61 screenshot here or click to browse</div>
          <div class="import-dropzone-hint">PNG, JPG, or WEBP — max 5MB</div>
        </div>
        <div class="import-spinner" id="import-spinner">Analyzing screenshot...</div>
        <div class="import-confirm" id="import-confirm">
          <div class="import-controls" style="margin-bottom:12px;">
            <div class="import-field">
              <label>Car Class</label>
              <select id="import-confirm-class"></select>
            </div>
            <div class="import-field">
              <label>Race Type</label>
              <select id="import-confirm-race-type"></select>
            </div>
          </div>
          <div class="import-confirm-grid" id="import-confirm-grid"></div>
          <div class="import-confirm-actions">
            <button class="btn-save-import" id="btn-save-import" onclick="saveImport()">Save to Database</button>
            <button class="btn-cancel-import" onclick="cancelImport()">Cancel</button>
          </div>
          <div id="import-message"></div>
        </div>
        <div id="import-error" class="import-error"></div>
      </div>
    </div>
```

- [ ] **Step 3: Add JavaScript for the import flow**

In `src/views/tracks.ejs`, find the line `window.showList = showList;` (around line 431). Add after it:

```javascript
  // ─── Screenshot Import ───
  let importData = null;

  window.toggleImport = function() {
    var panel = document.getElementById('import-panel');
    panel.classList.toggle('open');
  };

  function handleImportDrop(e) {
    var file = e.dataTransfer.files[0];
    if (file) handleImportFile(file);
  }
  window.handleImportDrop = handleImportDrop;

  window.handleImportFile = function(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      document.getElementById('import-error').textContent = 'File too large (max 5MB)';
      return;
    }
    document.getElementById('import-error').textContent = '';
    document.getElementById('import-confirm').classList.remove('active');
    document.getElementById('import-spinner').classList.add('active');
    document.getElementById('import-dropzone').style.display = 'none';

    var reader = new FileReader();
    reader.onload = function() {
      var base64 = reader.result;
      var trackName = document.getElementById('detail-name').textContent;
      var carClass = document.getElementById('import-class').value;
      var raceType = document.getElementById('import-race-type').value;

      fetch('/api/track-stats/import-screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64, trackName: trackName, carClass: carClass, raceType: raceType }),
      })
      .then(function(r) { return r.json(); })
      .then(function(result) {
        document.getElementById('import-spinner').classList.remove('active');
        if (!result.ok) {
          document.getElementById('import-error').textContent = result.error || 'Failed to analyze screenshot';
          document.getElementById('import-dropzone').style.display = '';
          return;
        }
        importData = result.data;
        showImportConfirm(result.data);
      })
      .catch(function(e) {
        document.getElementById('import-spinner').classList.remove('active');
        document.getElementById('import-error').textContent = 'Request failed: ' + e.message;
        document.getElementById('import-dropzone').style.display = '';
      });
    };
    reader.readAsDataURL(file);
  };

  function showImportConfirm(data) {
    // Populate class dropdown
    var classOpts = ['GTP','LMP2','GT3','LMP3','GT4','GTE','TCR','Porsche Cup','BMW M2','Toyota','Mazda'];
    var classSelect = document.getElementById('import-confirm-class');
    classSelect.innerHTML = classOpts.map(function(c) {
      return '<option value="' + c + '"' + (c === data.carClass ? ' selected' : '') + '>' + c + '</option>';
    }).join('');

    // Populate race type dropdown
    var raceOpts = ['Sprint','Open','Endurance','Regionals','VRS Sprint','VRS Open','IMSA Sprint','IMSA Open','IMSA Endurance','Global Endurance','LMP2 Sprint','Proto Sprint'];
    var raceSelect = document.getElementById('import-confirm-race-type');
    raceSelect.innerHTML = raceOpts.map(function(r) {
      return '<option value="' + r + '"' + (r === data.raceType ? ' selected' : '') + '>' + r + '</option>';
    }).join('');

    // Populate values grid
    var grid = document.getElementById('import-confirm-grid');
    grid.innerHTML = '';
    var fields = [
      { key: 'avgLapTime', label: 'Avg Lap', format: formatLapTime },
      { key: 'avgQualifyTime', label: 'Avg Qualify', format: formatLapTime },
      { key: 'avgPitTime', label: 'Avg Pit', format: function(v) { return v ? v.toFixed(1) + 's' : '--'; } },
      { key: 'avgSOF', label: 'SOF', format: function(v) { return v ? Math.round(v).toLocaleString() : '--'; } },
      { key: 'driverCount', label: 'Drivers', format: function(v) { return v || '--'; } },
      { key: 'estLaps', label: 'Laps', format: function(v) { return v || '--'; } },
    ];
    fields.forEach(function(f) {
      var val = data[f.key];
      grid.innerHTML += '<div class="import-confirm-item"><div class="import-confirm-value">' + f.format(val) + '</div><div class="import-confirm-label">' + f.label + '</div></div>';
    });

    document.getElementById('import-confirm').classList.add('active');
    document.getElementById('import-message').innerHTML = '';

    // Disable save if class or race type is missing
    var btn = document.getElementById('btn-save-import');
    btn.disabled = !data.carClass || !data.raceType;
    classSelect.onchange = raceSelect.onchange = function() { btn.disabled = false; };
  }

  window.saveImport = function() {
    if (!importData) return;
    var trackName = document.getElementById('detail-name').textContent;
    var carClass = document.getElementById('import-confirm-class').value;
    var raceType = document.getElementById('import-confirm-race-type').value;
    var btn = document.getElementById('btn-save-import');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    var stats = {};
    stats[carClass] = {
      avgLapTime: importData.avgLapTime || 0,
      avgPitTime: importData.avgPitTime || 0,
      avgQualifyTime: importData.avgQualifyTime || 0,
      avgSOF: importData.avgSOF || 0,
      estLaps: importData.estLaps || 0,
      samples: importData.driverCount || 0,
    };

    fetch('/api/track-stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackName: trackName, raceType: raceType, stats: stats }),
    })
    .then(function(r) { return r.json(); })
    .then(function(result) {
      if (result.ok) {
        document.getElementById('import-message').innerHTML = '<div class="import-success">Data saved! Refreshing...</div>';
        // Reload stats data and refresh the detail view
        setTimeout(function() {
          fetch('/api/track-stats').then(function(r) { return r.json(); }).then(function(s) {
            allStats = s;
            showDetail(trackName);
            cancelImport();
          });
        }, 1000);
      } else {
        document.getElementById('import-message').innerHTML = '<div class="import-error">Error: ' + (result.error || 'Save failed') + '</div>';
        btn.disabled = false;
        btn.textContent = 'Save to Database';
      }
    })
    .catch(function(e) {
      document.getElementById('import-message').innerHTML = '<div class="import-error">Request failed: ' + e.message + '</div>';
      btn.disabled = false;
      btn.textContent = 'Save to Database';
    });
  };

  window.cancelImport = function() {
    document.getElementById('import-confirm').classList.remove('active');
    document.getElementById('import-dropzone').style.display = '';
    document.getElementById('import-spinner').classList.remove('active');
    document.getElementById('import-error').textContent = '';
    document.getElementById('import-file-input').value = '';
    importData = null;
  };
```

- [ ] **Step 4: Commit**

```bash
git add src/views/tracks.ejs
git commit -m "feat: add screenshot import UI on track detail page

Drop a Garage61 screenshot, AI extracts race data, confirm and save
to track stats. Supports manual class/race type selection or auto-detect.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```
