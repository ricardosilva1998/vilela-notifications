# VTuber Face Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a browser-based 3D VTuber face tracker to the Experimental tab, with model selection, custom VRM upload, and OBS Browser Source support.

**Architecture:** MediaPipe Face Landmarker + Three.js + @pixiv/three-vrm run client-side in a new `/vtuber/:token` EJS page. Dashboard Experimental tab gets a model selector grid with category filters and embeds the tracker as an iframe. Models stored in DB with bundled defaults + custom upload support.

**Tech Stack:** MediaPipe Face Landmarker (CDN), Three.js (CDN), @pixiv/three-vrm (CDN), Express routes, SQLite, EJS templates.

**IMPORTANT:** Another developer is working on a different feature in this same repo simultaneously. Only touch files listed in each task. Do not modify any file not explicitly mentioned.

---

## File Structure

### New files
- `src/routes/vtuber.js` — Express route for `/vtuber/:token` page (token lookup, render EJS)
- `src/views/vtuber.ejs` — Face tracker page (Three.js canvas, MediaPipe, VRM loading, two modes)
- `public/vtuber/models/.gitkeep` — Directory for bundled VRM model files
- `data/vtuber-models/.gitkeep` — Directory for custom uploaded VRM files

### Modified files
- `src/db.js` — Migration for `vtuber_models` table + `vtuber_model_id` column on `streamers` + DB functions + seed
- `src/server.js` — Mount vtuber route + static route for `data/vtuber-models/`
- `src/routes/dashboard.js` — Model CRUD API endpoints + VRM upload + select model + pass vtuberUrl to render
- `src/views/dashboard.ejs` — Replace Experimental tab with model selector grid + updated iframe + controls

---

### Task 1: Database Schema — vtuber_models table + streamer column

**Files:**
- Modify: `src/db.js`

- [ ] **Step 1: Add vtuber_models table migration**

In `src/db.js`, after the last `CREATE TABLE IF NOT EXISTS` block (before the functions section), add:

```javascript
// Migration: VTuber models table
db.exec(`
  CREATE TABLE IF NOT EXISTS vtuber_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    streamer_id INTEGER,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    filename TEXT NOT NULL,
    is_bundled INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (streamer_id) REFERENCES streamers(id)
  )
`);
```

- [ ] **Step 2: Add vtuber_model_id column to streamers**

Below the migration from Step 1, add the ALTER TABLE migration following the existing pattern:

```javascript
// Migration: Add vtuber_model_id to streamers
try {
  const cols = db.pragma('table_info(streamers)').map(c => c.name);
  if (!cols.includes('vtuber_model_id')) {
    db.exec('ALTER TABLE streamers ADD COLUMN vtuber_model_id INTEGER REFERENCES vtuber_models(id)');
    console.log('[DB] Added vtuber_model_id column to streamers');
  }
} catch {}
```

- [ ] **Step 3: Add seed for bundled models**

Below the migration from Step 2, add seed logic:

```javascript
// Seed: Bundled VTuber models
{
  const existing = db.prepare('SELECT filename FROM vtuber_models WHERE is_bundled = 1').all().map(r => r.filename);
  const bundled = [
    { name: 'AvatarSample_A', category: 'anime', filename: 'AvatarSample_A.vrm' },
    { name: 'AvatarSample_B', category: 'anime', filename: 'AvatarSample_B.vrm' },
  ];
  const insert = db.prepare('INSERT INTO vtuber_models (streamer_id, name, category, filename, is_bundled) VALUES (NULL, ?, ?, ?, 1)');
  for (const m of bundled) {
    if (!existing.includes(m.filename)) {
      insert.run(m.name, m.category, m.filename);
      console.log(`[DB] Seeded bundled VTuber model: ${m.name}`);
    }
  }
}
```

Note: We start with 2 bundled models (the VRoid Studio CC0 sample avatars). More can be added later by extending the `bundled` array — the seed is idempotent.

- [ ] **Step 4: Add DB functions**

Add these functions before the `module.exports` block in `db.js`:

```javascript
// --- VTuber Models ---

function getVtuberModels(streamerId) {
  return db.prepare('SELECT * FROM vtuber_models WHERE is_bundled = 1 OR streamer_id = ? ORDER BY is_bundled DESC, name').all(streamerId);
}

function getVtuberModel(id) {
  return db.prepare('SELECT * FROM vtuber_models WHERE id = ?').get(id);
}

function addVtuberModel(streamerId, name, category, filename) {
  return db.prepare('INSERT INTO vtuber_models (streamer_id, name, category, filename, is_bundled) VALUES (?, ?, ?, ?, 0)').run(streamerId, name, category, filename);
}

function deleteVtuberModel(id, streamerId) {
  return db.prepare('DELETE FROM vtuber_models WHERE id = ? AND streamer_id = ? AND is_bundled = 0').run(id, streamerId);
}

function selectVtuberModel(streamerId, modelId) {
  db.prepare('UPDATE streamers SET vtuber_model_id = ? WHERE id = ?').run(modelId, streamerId);
}
```

- [ ] **Step 5: Export new DB functions**

Add to the `module.exports` object in `db.js`:

```javascript
  getVtuberModels,
  getVtuberModel,
  addVtuberModel,
  deleteVtuberModel,
  selectVtuberModel,
```

- [ ] **Step 6: Test the migration runs**

Run: `node -e "require('./src/db'); console.log('DB OK')"`

Expected: No errors, prints `DB OK` and any `[DB] Seeded bundled VTuber model:` messages.

- [ ] **Step 7: Commit**

```bash
git add src/db.js
git commit -m "feat(vtuber): add vtuber_models table, streamer column, and DB functions"
```

---

### Task 2: VTuber Route + Static Serving

**Files:**
- Create: `src/routes/vtuber.js`
- Modify: `src/server.js`
- Create: `public/vtuber/models/.gitkeep`
- Create: `data/vtuber-models/.gitkeep`

- [ ] **Step 1: Create model directories**

```bash
mkdir -p public/vtuber/models
touch public/vtuber/models/.gitkeep
mkdir -p data/vtuber-models
touch data/vtuber-models/.gitkeep
```

- [ ] **Step 2: Create the vtuber route file**

Create `src/routes/vtuber.js`:

```javascript
const { Router } = require('express');
const db = require('../db');

const router = Router();

router.get('/:token', (req, res) => {
  const streamer = db.getStreamerByOverlayToken(req.params.token);
  if (!streamer) return res.status(404).send('Invalid token');

  const mode = req.query.mode || 'dashboard';
  const model = streamer.vtuber_model_id ? db.getVtuberModel(streamer.vtuber_model_id) : null;

  let modelUrl = null;
  if (model) {
    modelUrl = model.is_bundled
      ? `/vtuber/models/${model.filename}`
      : `/vtuber-models/${streamer.id}/${model.filename}`;
  }

  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.render('vtuber', { mode, modelUrl, streamerName: streamer.twitch_username || 'Streamer' });
});

module.exports = router;
```

- [ ] **Step 3: Mount route and static directory in server.js**

In `src/server.js`, add the import near the other route imports:

```javascript
const vtuberRoutes = require('./routes/vtuber');
```

Add the static route for custom VRM uploads (near the other data static routes like `/sponsors`):

```javascript
// Serve custom VTuber models from persistent data volume
app.use('/vtuber-models', express.static(path.join(__dirname, '..', 'data', 'vtuber-models')));
```

Mount the route (near the other `app.use` route mounts, BEFORE the overlay route to avoid `:token` conflicts):

```javascript
app.use('/vtuber', vtuberRoutes);
```

- [ ] **Step 4: Test route mounts**

Run: `node -e "require('./src/server'); console.log('Server OK')"`

Expected: No errors about missing modules or routes.

- [ ] **Step 5: Commit**

```bash
git add src/routes/vtuber.js src/server.js public/vtuber/models/.gitkeep data/vtuber-models/.gitkeep
git commit -m "feat(vtuber): add vtuber route, static serving, and model directories"
```

---

### Task 3: VTuber Face Tracker Page (vtuber.ejs)

**Files:**
- Create: `src/views/vtuber.ejs`

This is the core face tracking page. It loads MediaPipe, Three.js, and @pixiv/three-vrm via CDN, captures webcam, runs face landmark detection, and animates a VRM model in real-time.

- [ ] **Step 1: Create the vtuber.ejs template**

Create `src/views/vtuber.ejs`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VTuber Face Tracker</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      overflow: hidden;
      background: <% if (mode === 'stream') { %>transparent<% } else { %>#1a1a2e<% } %>;
      font-family: 'Segoe UI', system-ui, sans-serif;
    }
    #canvas3d {
      width: 100vw;
      height: 100vh;
      display: block;
    }
    <% if (mode !== 'stream') { %>
    #webcam-preview {
      position: fixed;
      bottom: 12px;
      left: 12px;
      width: 160px;
      height: 120px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.15);
      object-fit: cover;
      z-index: 10;
      background: #000;
    }
    #status-bar {
      position: fixed;
      top: 12px;
      right: 12px;
      background: rgba(0,0,0,0.6);
      border-radius: 8px;
      padding: 6px 12px;
      font-size: 12px;
      color: rgba(255,255,255,0.5);
      font-family: monospace;
      z-index: 10;
    }
    #loading-screen {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      background: #1a1a2e;
      z-index: 100;
      color: rgba(255,255,255,0.6);
      font-size: 14px;
      gap: 12px;
    }
    .spinner {
      width: 32px; height: 32px;
      border: 3px solid rgba(255,255,255,0.1);
      border-top-color: #667eea;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    <% } %>
    <% if (mode === 'stream') { %>
    #loading-screen {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      z-index: 100;
      color: rgba(255,255,255,0.4);
      font-size: 14px;
    }
    <% } %>
    #error-msg {
      position: fixed;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      background: #1a1a2e;
      z-index: 200;
      color: #e74c3c;
      font-size: 14px;
      gap: 8px;
    }
  </style>
</head>
<body>
  <canvas id="canvas3d"></canvas>
  <% if (mode !== 'stream') { %>
    <video id="webcam-preview" autoplay playsinline muted></video>
    <div id="status-bar">Loading...</div>
  <% } %>
  <div id="loading-screen">
    <% if (mode !== 'stream') { %><div class="spinner"></div><% } %>
    <span>Loading face tracker...</span>
  </div>
  <div id="error-msg"></div>

  <!-- CDN Libraries -->
  <script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/",
      "@pixiv/three-vrm": "https://cdn.jsdelivr.net/npm/@pixiv/three-vrm@3/lib/three-vrm.module.min.js"
    }
  }
  </script>

  <script type="module">
    import * as THREE from 'three';
    import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
    import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
    import { FilesetResolver, FaceLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/vision_bundle.mjs';

    const MODE = '<%= mode %>';
    const MODEL_URL = <%- modelUrl ? JSON.stringify(modelUrl) : 'null' %>;
    const canvas = document.getElementById('canvas3d');
    const loading = document.getElementById('loading-screen');
    const errorEl = document.getElementById('error-msg');
    const statusBar = document.getElementById('status-bar');

    function showError(msg) {
      errorEl.innerHTML = `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#e74c3c" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg><span>${msg}</span>`;
      errorEl.style.display = 'flex';
      loading.style.display = 'none';
    }

    if (!MODEL_URL) {
      showError('No model selected. Pick a model in the dashboard first.');
      throw new Error('No model');
    }

    // --- Three.js Setup ---
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: MODE === 'stream', antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    if (MODE === 'stream') {
      renderer.setClearColor(0x000000, 0);
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(20, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 1.35, 1.5);
    camera.lookAt(0, 1.35, 0);

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambient);
    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(1, 2, 3);
    scene.add(directional);
    const fill = new THREE.DirectionalLight(0x8888ff, 0.3);
    fill.position.set(-1, 1, -1);
    scene.add(fill);

    // --- Load VRM Model ---
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    let vrm = null;

    try {
      const gltf = await loader.loadAsync(MODEL_URL);
      vrm = gltf.userData.vrm;
      VRMUtils.rotateVRM0(vrm);
      scene.add(vrm.scene);

      // Center the model
      const box = new THREE.Box3().setFromObject(vrm.scene);
      const center = box.getCenter(new THREE.Vector3());
      const height = box.max.y - box.min.y;
      camera.position.set(0, center.y + height * 0.1, height * 0.9);
      camera.lookAt(0, center.y + height * 0.1, 0);
    } catch (e) {
      showError('Failed to load model. Try a different avatar.');
      throw e;
    }

    // --- MediaPipe Face Landmarker ---
    let faceLandmarker = null;
    let videoEl = null;

    try {
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm'
      );
      faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'GPU'
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true
      });
    } catch (e) {
      showError('Failed to load face detection model.');
      throw e;
    }

    // --- Webcam ---
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' }
      });
      videoEl = document.createElement('video');
      videoEl.srcObject = stream;
      videoEl.autoplay = true;
      videoEl.playsInline = true;
      await videoEl.play();

      // Show webcam preview in dashboard mode
      if (MODE !== 'stream') {
        const preview = document.getElementById('webcam-preview');
        if (preview) preview.srcObject = stream;
      }
    } catch (e) {
      showError('Camera access denied. Please allow camera and reload.');
      throw e;
    }

    loading.style.display = 'none';

    // --- Blend shape helpers ---
    function getBlendShape(blendShapes, name) {
      if (!blendShapes || !blendShapes[0]) return 0;
      const shape = blendShapes[0].categories.find(c => c.categoryName === name);
      return shape ? shape.score : 0;
    }

    // Smoothing for stable tracking
    const smooth = {};
    function lerp(key, target, factor = 0.3) {
      if (smooth[key] === undefined) smooth[key] = target;
      smooth[key] += (target - smooth[key]) * factor;
      return smooth[key];
    }

    // --- Animation Loop ---
    const clock = new THREE.Clock();
    let frameCount = 0;
    let lastFpsUpdate = 0;
    let fps = 0;

    function animate() {
      requestAnimationFrame(animate);
      const delta = clock.getDelta();

      if (vrm && faceLandmarker && videoEl && videoEl.readyState >= 2) {
        const now = performance.now();
        const result = faceLandmarker.detectForVideo(videoEl, now);

        if (result.faceBlendshapes && result.faceBlendshapes.length > 0) {
          const bs = result.faceBlendshapes;

          // Eye blinks
          const blinkL = getBlendShape(bs, 'eyeBlinkLeft');
          const blinkR = getBlendShape(bs, 'eyeBlinkRight');
          vrm.expressionManager.setValue('blinkLeft', lerp('blinkL', blinkL, 0.5));
          vrm.expressionManager.setValue('blinkRight', lerp('blinkR', blinkR, 0.5));

          // Mouth
          const jawOpen = getBlendShape(bs, 'jawOpen');
          const mouthSmile = (getBlendShape(bs, 'mouthSmileLeft') + getBlendShape(bs, 'mouthSmileRight')) / 2;
          vrm.expressionManager.setValue('aa', lerp('mouth', jawOpen * 1.2, 0.4));
          vrm.expressionManager.setValue('happy', lerp('smile', mouthSmile, 0.3));

          // Brows
          const browUp = getBlendShape(bs, 'browInnerUp');
          const browDownL = getBlendShape(bs, 'browDownLeft');
          const browDownR = getBlendShape(bs, 'browDownRight');
          vrm.expressionManager.setValue('surprised', lerp('browUp', browUp * 0.7, 0.3));
          vrm.expressionManager.setValue('angry', lerp('browDown', (browDownL + browDownR) / 2 * 0.5, 0.3));

          // Eye look direction
          const lookLeft = getBlendShape(bs, 'eyeLookOutLeft');
          const lookRight = getBlendShape(bs, 'eyeLookOutRight');
          const lookUp = getBlendShape(bs, 'eyeLookUpLeft');
          const lookDown = getBlendShape(bs, 'eyeLookDownLeft');
          vrm.expressionManager.setValue('lookLeft', lerp('lookL', lookLeft, 0.3));
          vrm.expressionManager.setValue('lookRight', lerp('lookR', lookRight, 0.3));
          vrm.expressionManager.setValue('lookUp', lerp('lookUp', lookUp, 0.3));
          vrm.expressionManager.setValue('lookDown', lerp('lookDown', lookDown, 0.3));
        }

        // Head rotation from transformation matrix
        if (result.facialTransformationMatrixes && result.facialTransformationMatrixes.length > 0) {
          const matrix = result.facialTransformationMatrixes[0];
          const m = new THREE.Matrix4().fromArray(matrix.data);
          const euler = new THREE.Euler().setFromRotationMatrix(m, 'ZYX');

          const head = vrm.humanoid.getNormalizedBoneNode('head');
          if (head) {
            head.rotation.x = lerp('headX', euler.x * 0.6, 0.3);
            head.rotation.y = lerp('headY', -euler.y * 0.7, 0.3);
            head.rotation.z = lerp('headZ', -euler.z * 0.5, 0.3);
          }

          const neck = vrm.humanoid.getNormalizedBoneNode('neck');
          if (neck) {
            neck.rotation.x = lerp('neckX', euler.x * 0.2, 0.2);
            neck.rotation.y = lerp('neckY', -euler.y * 0.2, 0.2);
          }

          const spine = vrm.humanoid.getNormalizedBoneNode('upperChest') || vrm.humanoid.getNormalizedBoneNode('spine');
          if (spine) {
            spine.rotation.x = lerp('spineX', euler.x * 0.05, 0.15);
            spine.rotation.y = lerp('spineY', -euler.y * 0.05, 0.15);
          }
        }

        vrm.update(delta);
      }

      // FPS counter
      if (MODE !== 'stream' && statusBar) {
        frameCount++;
        const now = performance.now();
        if (now - lastFpsUpdate > 1000) {
          fps = frameCount;
          frameCount = 0;
          lastFpsUpdate = now;
          const tracking = (vrm && videoEl && videoEl.readyState >= 2) ? 'ON' : 'OFF';
          statusBar.textContent = `${fps} FPS | Tracking: ${tracking}`;
        }
      }

      renderer.render(scene, camera);
    }

    animate();

    // --- Resize ---
    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });
  </script>
</body>
</html>
```

- [ ] **Step 2: Test page loads without errors**

Start the dev server and visit `/vtuber/SOME_VALID_TOKEN` in a browser. Verify:
- Page loads without JS console errors (other than "No model selected" if no model is selected)
- Three.js canvas renders

Run: `npm run dev`

- [ ] **Step 3: Commit**

```bash
git add src/views/vtuber.ejs
git commit -m "feat(vtuber): add face tracker page with MediaPipe + Three.js + VRM"
```

---

### Task 4: Dashboard API Endpoints — Model CRUD + Upload + Select

**Files:**
- Modify: `src/routes/dashboard.js`

- [ ] **Step 1: Add VTuber model list endpoint**

Near the end of `src/routes/dashboard.js` (before `module.exports = router`), add:

```javascript
// --- VTuber Model Endpoints ---

router.get('/api/vtuber/models', (req, res) => {
  const models = db.getVtuberModels(req.streamer.id);
  res.json({ ok: true, models });
});
```

- [ ] **Step 2: Add model upload endpoint**

Below the GET endpoint:

```javascript
router.post('/api/vtuber/models', (req, res) => {
  const contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > 50 * 1024 * 1024) {
    return res.status(413).json({ error: 'File too large (max 50MB)' });
  }

  const originalName = (req.query.name || 'custom').replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${req.streamer.id}_${Date.now()}_${originalName}.vrm`;
  const modelDir = path.join(__dirname, '..', '..', 'data', 'vtuber-models', String(req.streamer.id));

  if (!fs.existsSync(modelDir)) fs.mkdirSync(modelDir, { recursive: true });

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    fs.writeFileSync(path.join(modelDir, filename), Buffer.concat(chunks));
    const result = db.addVtuberModel(req.streamer.id, originalName, 'custom', filename);
    const model = db.getVtuberModel(result.lastInsertRowid);
    res.json({ ok: true, model });
  });
});
```

- [ ] **Step 3: Add model delete endpoint**

Below the POST endpoint:

```javascript
router.delete('/api/vtuber/models/:id', (req, res) => {
  const model = db.getVtuberModel(parseInt(req.params.id));
  if (!model) return res.status(404).json({ error: 'Model not found' });
  if (model.is_bundled) return res.status(403).json({ error: 'Cannot delete bundled models' });
  if (model.streamer_id !== req.streamer.id) return res.status(403).json({ error: 'Not your model' });

  // Delete file
  const filePath = path.join(__dirname, '..', '..', 'data', 'vtuber-models', String(req.streamer.id), model.filename);
  try { fs.unlinkSync(filePath); } catch {}

  // Clear selection if this model was selected
  if (req.streamer.vtuber_model_id === model.id) {
    db.selectVtuberModel(req.streamer.id, null);
  }

  db.deleteVtuberModel(model.id, req.streamer.id);
  res.json({ ok: true });
});
```

- [ ] **Step 4: Add model select endpoint**

Below the DELETE endpoint:

```javascript
router.put('/api/vtuber/select', (req, res) => {
  const { modelId } = req.body;
  if (modelId !== null) {
    const model = db.getVtuberModel(modelId);
    if (!model) return res.status(404).json({ error: 'Model not found' });
    if (!model.is_bundled && model.streamer_id !== req.streamer.id) {
      return res.status(403).json({ error: 'Not your model' });
    }
  }
  db.selectVtuberModel(req.streamer.id, modelId);
  res.json({ ok: true });
});
```

- [ ] **Step 5: Add vtuberUrl to the main dashboard render**

Find the `router.get('/')` handler in `dashboard.js` that calls `res.render('dashboard', { ... })`. Add `vtuberUrl` to the data object passed to the template.

Near the existing `overlayUrl` computation (around line 131), add:

```javascript
  const vtuberUrl = req.streamer.overlay_token
    ? `${config.app.url}/vtuber/${req.streamer.overlay_token}`
    : null;
```

Then add `vtuberUrl` to the `res.render('dashboard', { ... })` call alongside the other variables.

- [ ] **Step 6: Verify dashboard still loads**

Run: `npm run dev` and visit the dashboard. Confirm no errors.

- [ ] **Step 7: Commit**

```bash
git add src/routes/dashboard.js
git commit -m "feat(vtuber): add model CRUD API, upload, select, and vtuberUrl to dashboard"
```

---

### Task 5: Dashboard Experimental Tab UI — Model Selector + Tracker Controls

**Files:**
- Modify: `src/views/dashboard.ejs`

- [ ] **Step 1: Replace the Experimental tab content**

Find the `<div class="tab-content" id="tab-experimental">` section (around lines 640-729) and replace the entire content (from the opening `<div class="tab-content" id="tab-experimental">` to its closing `</div>`, including the `<script>` block with `toggleVtuber` and `copyOBSUrl` functions) with:

```html
<div class="tab-content" id="tab-experimental">
  <div class="animate-in animate-in-delay-2">
    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 20px;">
      <h3 class="section-title" style="margin: 0; line-height: 1;">VTuber Face Tracker</h3>
      <span style="background: linear-gradient(135deg, #667eea, #764ba2); color: white; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 20px;">BETA</span>
    </div>

    <!-- Info Card -->
    <div class="card" style="padding: 16px; margin-bottom: 16px;">
      <p style="color: var(--text-secondary); font-size: 13px; margin-bottom: 12px;">
        Track your face with your webcam and display an animated 3D avatar on your stream via OBS Browser Source.
      </p>
      <div style="display: flex; gap: 8px; flex-wrap: wrap;">
        <div style="background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 12px; font-size: 12px; color: var(--text-secondary);">
          <strong style="color: var(--text-primary);">1.</strong> Pick a model below
        </div>
        <div style="background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 12px; font-size: 12px; color: var(--text-secondary);">
          <strong style="color: var(--text-primary);">2.</strong> Launch tracker &amp; allow camera
        </div>
        <div style="background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 12px; font-size: 12px; color: var(--text-secondary);">
          <strong style="color: var(--text-primary);">3.</strong> Copy OBS URL &amp; add as Browser Source
        </div>
      </div>
    </div>

    <!-- Model Selector Card -->
    <div class="card" style="padding: 0; margin-bottom: 16px; overflow: hidden;">
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border);">
        <span style="font-size: 13px; font-weight: 600; color: var(--text-primary);">Choose Avatar</span>
        <label style="background: rgba(102,126,234,0.15); border: 1px solid rgba(102,126,234,0.3); color: #667eea; padding: 5px 12px; border-radius: var(--radius-sm); font-size: 11px; cursor: pointer; font-weight: 600; font-family: var(--font-display);">
          + Upload VRM
          <input type="file" accept=".vrm" id="vtuber-upload-input" style="display: none;" onchange="uploadVtuberModel(this)">
        </label>
      </div>

      <!-- Category Filter Pills -->
      <div id="vtuber-category-pills" style="display: flex; gap: 6px; padding: 12px 16px 8px; flex-wrap: wrap;">
        <button class="vtuber-cat-pill active" data-category="all" onclick="filterVtuberCategory('all', this)" style="background: #667eea; color: white; border: none; padding: 3px 12px; border-radius: 20px; font-size: 11px; cursor: pointer; font-weight: 600; font-family: var(--font-display);">All</button>
        <button class="vtuber-cat-pill" data-category="anime" onclick="filterVtuberCategory('anime', this)" style="background: var(--bg-hover); color: var(--text-muted); border: none; padding: 3px 12px; border-radius: 20px; font-size: 11px; cursor: pointer; font-family: var(--font-display);">Anime</button>
        <button class="vtuber-cat-pill" data-category="animal" onclick="filterVtuberCategory('animal', this)" style="background: var(--bg-hover); color: var(--text-muted); border: none; padding: 3px 12px; border-radius: 20px; font-size: 11px; cursor: pointer; font-family: var(--font-display);">Animals</button>
        <button class="vtuber-cat-pill" data-category="robot" onclick="filterVtuberCategory('robot', this)" style="background: var(--bg-hover); color: var(--text-muted); border: none; padding: 3px 12px; border-radius: 20px; font-size: 11px; cursor: pointer; font-family: var(--font-display);">Robots</button>
        <button class="vtuber-cat-pill" data-category="custom" onclick="filterVtuberCategory('custom', this)" style="background: var(--bg-hover); color: var(--text-muted); border: none; padding: 3px 12px; border-radius: 20px; font-size: 11px; cursor: pointer; font-family: var(--font-display);">Custom</button>
      </div>

      <!-- Model Grid -->
      <div id="vtuber-model-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 10px; padding: 10px 16px 16px;">
        <div style="text-align: center; color: var(--text-muted); font-size: 12px; padding: 20px;">Loading models...</div>
      </div>
    </div>

    <!-- Tracker Toolbar + Preview -->
    <div class="card" style="padding: 0; overflow: hidden;">
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--bg-elevated);">
        <div style="display: flex; align-items: center; gap: 8px;">
          <div id="vtuber-status" style="width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted);"></div>
          <span style="font-size: 12px; color: var(--text-secondary);" id="vtuber-status-text">Not started</span>
        </div>
        <div style="display: flex; gap: 8px;">
          <button onclick="copyVtuberOBSUrl()" id="vtuber-copy-btn" style="background: var(--bg-hover); border: 1px solid var(--border); color: var(--text-secondary); padding: 5px 12px; border-radius: var(--radius-sm); font-size: 12px; cursor: pointer; font-family: var(--font-display); font-weight: 600; transition: all var(--transition);" onmouseover="this.style.color='var(--text-primary)'" onmouseout="this.style.color='var(--text-secondary)'">
            Copy OBS URL
          </button>
          <button onclick="toggleVtuber()" id="vtuber-toggle-btn" style="background: linear-gradient(135deg, #667eea, #764ba2); border: none; color: white; padding: 5px 16px; border-radius: var(--radius-sm); font-size: 12px; cursor: pointer; font-family: var(--font-display); font-weight: 600; transition: all var(--transition);">
            Launch Tracker
          </button>
        </div>
      </div>
      <div id="vtuber-container" style="position: relative; width: 100%; height: 500px; background: #1a1a2e; display: flex; align-items: center; justify-content: center;">
        <div id="vtuber-placeholder" style="text-align: center; color: var(--text-muted);">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 12px; opacity: 0.5;"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
          <p style="font-size: 14px; font-weight: 600; margin-bottom: 4px;">Pick a model and click "Launch Tracker"</p>
          <p style="font-size: 12px;">Your webcam will be used to track facial movements</p>
        </div>
        <iframe id="vtuber-iframe" style="display: none; width: 100%; height: 100%; border: none;" allow="camera"></iframe>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Replace the VTuber script block**

Remove the old `<script>` block containing `toggleVtuber()` and `copyOBSUrl()` (around lines 709-729) and replace with this script block. Place it right after the closing `</div>` of `tab-experimental`, in the same location the old script was:

```html
<script>
  // --- VTuber Face Tracker ---
  let vtuberActive = false;
  let vtuberModels = [];
  let vtuberSelectedId = <%= typeof streamer !== 'undefined' && streamer.vtuber_model_id ? streamer.vtuber_model_id : 'null' %>;
  const vtuberUrl = <%- typeof vtuberUrl !== 'undefined' && vtuberUrl ? JSON.stringify(vtuberUrl) : 'null' %>;
  let vtuberCategoryFilter = 'all';

  const CATEGORY_ICONS = {
    anime: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="5"/><path d="M3 21v-2a7 7 0 0114 0v2"/></svg>',
    animal: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 20c-4 0-8-2-8-6 0-3 2-5 4-6l1-4h6l1 4c2 1 4 3 4 6 0 4-4 6-8 6z"/><circle cx="9" cy="13" r="1" fill="currentColor"/><circle cx="15" cy="13" r="1" fill="currentColor"/></svg>',
    robot: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="8" width="14" height="12" rx="2"/><path d="M12 2v4"/><circle cx="9" cy="14" r="1.5"/><circle cx="15" cy="14" r="1.5"/><path d="M9 18h6"/></svg>',
    custom: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>'
  };

  async function loadVtuberModels() {
    try {
      const resp = await fetch('/dashboard/api/vtuber/models');
      const data = await resp.json();
      if (data.ok) {
        vtuberModels = data.models;
        renderVtuberGrid();
      }
    } catch (e) { console.error('Failed to load VTuber models', e); }
  }

  function renderVtuberGrid() {
    const grid = document.getElementById('vtuber-model-grid');
    const filtered = vtuberCategoryFilter === 'all'
      ? vtuberModels
      : vtuberModels.filter(m => m.category === vtuberCategoryFilter);

    if (filtered.length === 0) {
      grid.innerHTML = '<div style="text-align: center; color: var(--text-muted); font-size: 12px; padding: 20px; grid-column: 1/-1;">No models in this category</div>';
      return;
    }

    grid.innerHTML = filtered.map(m => {
      const selected = m.id === vtuberSelectedId;
      const icon = CATEGORY_ICONS[m.category] || CATEGORY_ICONS.custom;
      const canDelete = !m.is_bundled;
      return `
        <div onclick="selectVtuberModel(${m.id})" style="border-radius: 10px; background: ${selected ? 'linear-gradient(135deg, rgba(102,126,234,0.15), rgba(118,75,162,0.15))' : 'var(--bg-elevated)'}; border: 2px solid ${selected ? '#667eea' : 'transparent'}; padding: 8px; text-align: center; cursor: pointer; position: relative; transition: all 0.2s;" onmouseover="this.style.borderColor='${selected ? '#667eea' : 'var(--border)'}'" onmouseout="this.style.borderColor='${selected ? '#667eea' : 'transparent'}'">
          <div style="width: 100%; aspect-ratio: 1; background: rgba(0,0,0,0.15); border-radius: 8px; display: flex; align-items: center; justify-content: center; margin-bottom: 6px; color: var(--text-muted);">
            ${icon}
          </div>
          <span style="font-size: 10px; color: ${selected ? 'var(--text-primary)' : 'var(--text-muted)'}; font-weight: ${selected ? '600' : '400'}; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${m.name}</span>
          ${selected ? '<div style="position: absolute; top: 6px; right: 6px; width: 16px; height: 16px; border-radius: 50%; background: #667eea; display: flex; align-items: center; justify-content: center;"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>' : ''}
          ${canDelete ? `<div onclick="event.stopPropagation(); deleteVtuberModel(${m.id}, '${m.name.replace(/'/g, "\\'")}')" style="position: absolute; top: 6px; left: 6px; width: 18px; height: 18px; border-radius: 50%; background: rgba(231,76,60,0.8); display: none; align-items: center; justify-content: center; cursor: pointer;" onmouseover="this.style.background='#e74c3c'" onmouseout="this.style.background='rgba(231,76,60,0.8)'" class="vtuber-delete-btn"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></div>` : ''}
        </div>`;
    }).join('');

    // Show delete buttons on hover for custom models
    grid.querySelectorAll('[onclick^="selectVtuberModel"]').forEach(el => {
      const delBtn = el.querySelector('.vtuber-delete-btn');
      if (delBtn) {
        el.addEventListener('mouseenter', () => delBtn.style.display = 'flex');
        el.addEventListener('mouseleave', () => delBtn.style.display = 'none');
      }
    });
  }

  function filterVtuberCategory(category, btn) {
    vtuberCategoryFilter = category;
    document.querySelectorAll('.vtuber-cat-pill').forEach(p => {
      p.style.background = 'var(--bg-hover)';
      p.style.color = 'var(--text-muted)';
      p.classList.remove('active');
    });
    btn.style.background = '#667eea';
    btn.style.color = 'white';
    btn.classList.add('active');
    renderVtuberGrid();
  }

  async function selectVtuberModel(id) {
    try {
      const resp = await fetch('/dashboard/api/vtuber/select', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: id })
      });
      const data = await resp.json();
      if (data.ok) {
        vtuberSelectedId = id;
        renderVtuberGrid();
        // If tracker is running, reload iframe with new model
        if (vtuberActive) {
          const iframe = document.getElementById('vtuber-iframe');
          iframe.src = vtuberUrl + '?_t=' + Date.now();
        }
      }
    } catch (e) { console.error('Failed to select model', e); }
  }

  async function uploadVtuberModel(input) {
    const file = input.files[0];
    if (!file) return;
    if (!file.name.endsWith('.vrm')) {
      alert('Please select a .vrm file');
      input.value = '';
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      alert('File too large (max 50MB)');
      input.value = '';
      return;
    }

    const name = file.name.replace('.vrm', '');
    try {
      const resp = await fetch(`/dashboard/api/vtuber/models?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        body: file
      });
      const data = await resp.json();
      if (data.ok) {
        vtuberModels.push(data.model);
        vtuberCategoryFilter = 'all';
        document.querySelectorAll('.vtuber-cat-pill').forEach(p => {
          p.style.background = p.dataset.category === 'all' ? '#667eea' : 'var(--bg-hover)';
          p.style.color = p.dataset.category === 'all' ? 'white' : 'var(--text-muted)';
        });
        renderVtuberGrid();
      }
    } catch (e) { console.error('Failed to upload model', e); }
    input.value = '';
  }

  async function deleteVtuberModel(id, name) {
    if (!confirm(`Delete "${name}"?`)) return;
    try {
      const resp = await fetch(`/dashboard/api/vtuber/models/${id}`, { method: 'DELETE' });
      const data = await resp.json();
      if (data.ok) {
        vtuberModels = vtuberModels.filter(m => m.id !== id);
        if (vtuberSelectedId === id) vtuberSelectedId = null;
        renderVtuberGrid();
      }
    } catch (e) { console.error('Failed to delete model', e); }
  }

  function toggleVtuber() {
    const iframe = document.getElementById('vtuber-iframe');
    const placeholder = document.getElementById('vtuber-placeholder');
    const btn = document.getElementById('vtuber-toggle-btn');
    const status = document.getElementById('vtuber-status');
    const statusText = document.getElementById('vtuber-status-text');

    if (!vtuberActive) {
      if (!vtuberUrl) {
        alert('Overlay token not generated yet. Visit the Overlay Config page first.');
        return;
      }
      if (!vtuberSelectedId) {
        alert('Please select a model first.');
        return;
      }
      iframe.src = vtuberUrl + '?_t=' + Date.now();
      iframe.style.display = 'block';
      placeholder.style.display = 'none';
      btn.textContent = 'Stop Tracker';
      btn.style.background = '#e74c3c';
      status.style.background = '#2ecc71';
      const model = vtuberModels.find(m => m.id === vtuberSelectedId);
      statusText.textContent = 'Running' + (model ? ' — ' + model.name : '');
      vtuberActive = true;
    } else {
      iframe.src = '';
      iframe.style.display = 'none';
      placeholder.style.display = 'block';
      btn.textContent = 'Launch Tracker';
      btn.style.background = 'linear-gradient(135deg, #667eea, #764ba2)';
      status.style.background = 'var(--text-muted)';
      statusText.textContent = 'Not started';
      vtuberActive = false;
    }
  }

  function copyVtuberOBSUrl() {
    if (!vtuberUrl) {
      alert('Overlay token not generated yet.');
      return;
    }
    navigator.clipboard.writeText(vtuberUrl + '?mode=stream').then(() => {
      const btn = document.getElementById('vtuber-copy-btn');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy OBS URL'; }, 2000);
    });
  }

  // Load models when experimental tab is shown
  if (document.getElementById('tab-experimental')) {
    loadVtuberModels();
  }
</script>
```

- [ ] **Step 3: Test the full dashboard UI**

Run: `npm run dev` and visit the dashboard → Experimental tab.

Verify:
- Model grid loads with bundled models
- Category filter pills work
- Selecting a model highlights it
- Upload VRM button opens file picker
- Launch Tracker button works (iframe loads the face tracker page)
- Copy OBS URL copies the correct URL
- Stop Tracker button stops the iframe

- [ ] **Step 4: Commit**

```bash
git add src/views/dashboard.ejs
git commit -m "feat(vtuber): replace experimental tab with model selector and face tracker controls"
```

---

### Task 6: Source and Add Bundled VRM Models

**Files:**
- Add files to: `public/vtuber/models/`

- [ ] **Step 1: Download CC0 VRM sample models**

Download the VRoid Hub sample avatars (AvatarSample_A and AvatarSample_B) from the @pixiv/three-vrm repository which includes CC0 sample VRM files:

```bash
cd public/vtuber/models
curl -L -o AvatarSample_A.vrm "https://pixiv.github.io/three-vrm/packages/three-vrm/examples/models/AvatarSample_A.vrm"
curl -L -o AvatarSample_B.vrm "https://pixiv.github.io/three-vrm/packages/three-vrm/examples/models/AvatarSample_B.vrm"
cd ../../..
```

These are the official Pixiv CC0 sample models from the three-vrm project.

- [ ] **Step 2: Verify files downloaded correctly**

```bash
ls -la public/vtuber/models/
```

Expected: `AvatarSample_A.vrm` and `AvatarSample_B.vrm` should be present (each a few MB).

- [ ] **Step 3: Test end-to-end**

Run: `npm run dev`

1. Go to dashboard → Experimental tab
2. Two bundled models should appear in the grid
3. Select one → Launch Tracker
4. Allow camera → face tracking should animate the 3D avatar
5. Copy OBS URL → open in another tab → avatar renders on transparent background

- [ ] **Step 4: Remove .gitkeep since we have real files now**

```bash
rm -f public/vtuber/models/.gitkeep
```

- [ ] **Step 5: Commit**

```bash
git add public/vtuber/models/
git commit -m "feat(vtuber): add bundled CC0 VRM sample avatars from Pixiv"
```

---

### Task 7: Run Playwright Tests + Fix Any Regressions

**Files:**
- No new files — verification only

- [ ] **Step 1: Run existing Playwright tests**

```bash
npx playwright test
```

Expected: All existing tests pass. The VTuber changes should not break public pages or authenticated flows since we only modified the Experimental tab and added new routes.

- [ ] **Step 2: Fix any failures**

If tests fail, check:
- Did `dashboard.ejs` changes break the page load? (Check for missing closing tags, unbalanced HTML)
- Did `server.js` route mounting affect existing routes? (The vtuber route uses `/vtuber`, which shouldn't conflict)
- Did `dashboard.js` render call changes break? (Verify `vtuberUrl` is passed correctly)

Fix any issues found.

- [ ] **Step 3: Commit fixes if any**

```bash
git add -A
git commit -m "fix(vtuber): fix test regressions from vtuber feature"
```

Only create this commit if there were actual fixes needed.
