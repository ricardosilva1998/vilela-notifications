# Team Customization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let team owners upload a team picture and banner that display on the team detail page, using interactive crop editors.

**Architecture:** Add `picture` and `banner` TEXT columns to the `teams` table (base64 data URLs). Two new POST routes for uploads. Redesign the team detail page header to show banner + inline picture/name section. Crop editor modals reuse the same UX pattern as the avatar crop editor on `racing-account.ejs`.

**Tech Stack:** Express, better-sqlite3, EJS, Canvas API (client-side crop)

---

### Task 1: DB Migration + Query Functions

**Files:**
- Modify: `src/db.js`

- [ ] **Step 1: Add migration for picture and banner columns**

In `src/db.js`, find the migration block near line 821 (after the `track_stats` migrations) and add:

```js
// Migration: add picture and banner to teams
try { db.exec('ALTER TABLE teams ADD COLUMN picture TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE teams ADD COLUMN banner TEXT'); } catch(e) {}
```

- [ ] **Step 2: Add prepared statements and query functions**

In `src/db.js`, find the team queries section (after `_deleteTeam` around line 3765) and add:

```js
const _updateTeamPicture = db.prepare('UPDATE teams SET picture = ? WHERE id = ?');
const _updateTeamBanner = db.prepare('UPDATE teams SET banner = ? WHERE id = ?');
```

Then add these functions after `getTeamById()` (around line 3860):

```js
function updateTeamPicture(teamId, base64) {
  _updateTeamPicture.run(base64, teamId);
}

function updateTeamBanner(teamId, base64) {
  _updateTeamBanner.run(base64, teamId);
}
```

- [ ] **Step 3: Export the new functions**

Add `updateTeamPicture` and `updateTeamBanner` to the `module.exports` object.

- [ ] **Step 4: Update `_getTeamMemberships` query to include picture and banner**

Change the `_getTeamMemberships` prepared statement from:

```js
const _getTeamMemberships = db.prepare(`
  SELECT tm.*, t.name AS team_name, t.owner_id, t.invite_code
  FROM team_members tm JOIN teams t ON tm.team_id = t.id
  WHERE tm.user_id = ?
```

to:

```js
const _getTeamMemberships = db.prepare(`
  SELECT tm.*, t.name AS team_name, t.owner_id, t.invite_code, t.picture AS team_picture, t.banner AS team_banner
  FROM team_members tm JOIN teams t ON tm.team_id = t.id
  WHERE tm.user_id = ?
```

- [ ] **Step 5: Verify the app starts**

Run: `npm run dev`
Expected: No errors on startup. The migration adds columns silently.

- [ ] **Step 6: Commit**

```bash
git add src/db.js
git commit -m "feat: add picture and banner columns to teams table"
```

---

### Task 2: Upload Routes

**Files:**
- Modify: `src/routes/racing-team.js`

- [ ] **Step 1: Add POST route for team picture upload**

In `src/routes/racing-team.js`, before the `module.exports` line, add:

```js
// POST /racing/teams/:teamId/picture
router.post('/:teamId/picture', express.json({ limit: '2mb' }), (req, res) => {
  const teamId = parseInt(req.params.teamId);
  const membership = db.getTeamsForUser(req.racingUser.id).find(t => t.team_id === teamId);
  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
    return res.status(403).json({ error: 'Only team owner can change the picture' });
  }
  const { picture } = req.body;
  if (!picture || !picture.startsWith('data:image/')) {
    return res.status(400).json({ error: 'Invalid image' });
  }
  if (picture.length > 700000) {
    return res.status(400).json({ error: 'Image too large (max 500KB)' });
  }
  db.updateTeamPicture(teamId, picture);
  res.json({ ok: true });
});
```

- [ ] **Step 2: Add POST route for team banner upload**

Right after the picture route, add:

```js
// POST /racing/teams/:teamId/banner
router.post('/:teamId/banner', express.json({ limit: '2mb' }), (req, res) => {
  const teamId = parseInt(req.params.teamId);
  const membership = db.getTeamsForUser(req.racingUser.id).find(t => t.team_id === teamId);
  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
    return res.status(403).json({ error: 'Only team owner can change the banner' });
  }
  const { banner } = req.body;
  if (!banner || !banner.startsWith('data:image/')) {
    return res.status(400).json({ error: 'Invalid image' });
  }
  if (banner.length > 1000000) {
    return res.status(400).json({ error: 'Image too large (max 700KB)' });
  }
  db.updateTeamBanner(teamId, banner);
  res.json({ ok: true });
});
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/racing-team.js
git commit -m "feat: add team picture and banner upload routes"
```

---

### Task 3: Redesign Team Detail Page Header

**Files:**
- Modify: `src/views/racing-team-detail.ejs`

- [ ] **Step 1: Replace the card header section**

In `racing-team-detail.ejs`, replace the existing card header (lines 12-24, from `<div class="card"` through the closing `</div>` of the header flex container and the member count paragraph) with the new banner + inline layout.

Replace this block:

```html
  <div class="card" style="padding:20px;margin-bottom:20px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
      <div>
        <h2 style="font-size:20px;font-weight:800;"><%= team.team_name %></h2>
        <p style="color:var(--text-muted);font-size:12px;"><%= members.length %> member<%= members.length !== 1 ? 's' : '' %></p>
      </div>
      <% if (team.role === 'owner') { %>
        <div style="display:flex;gap:8px;align-items:center;">
          <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:6px 12px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text-secondary);user-select:all;cursor:text;" title="Share this code to invite teammates"><%= team.invite_code %></div>
          <button onclick="navigator.clipboard.writeText('<%= team.invite_code %>');this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)" style="background:rgba(145,70,255,0.15);color:var(--accent);border:none;border-radius:6px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;">Copy</button>
        </div>
      <% } %>
    </div>
```

With:

```html
  <div class="card" style="padding:0;margin-bottom:20px;overflow:hidden;">
    <!-- Banner -->
    <div style="height:140px;position:relative;overflow:hidden;<%= team.team_banner ? '' : 'background:linear-gradient(135deg,#1a1a2e,#16213e,#0f3460);' %>">
      <% if (team.team_banner) { %>
        <img src="<%= team.team_banner %>" style="width:100%;height:100%;object-fit:cover;">
      <% } %>
      <% if (team.role === 'owner' || team.role === 'admin') { %>
        <label style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;cursor:pointer;background:rgba(0,0,0,0);transition:background 0.2s;" onmouseover="this.style.background='rgba(0,0,0,0.45)';this.querySelector('svg').style.opacity='1'" onmouseout="this.style.background='rgba(0,0,0,0)';this.querySelector('svg').style.opacity='0'">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="white" style="opacity:0;transition:opacity 0.2s;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.5))"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z"/><path d="M9 2 7.17 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3.17L15 2H9zm3 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/></svg>
          <input type="file" accept="image/*" style="display:none;" onchange="openBannerCrop(this)">
        </label>
      <% } %>
    </div>
    <!-- Inline section below banner -->
    <div style="padding:16px 20px;display:flex;align-items:center;gap:14px;border-top:1px solid rgba(255,255,255,0.06);">
      <div style="width:56px;height:56px;border-radius:50%;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;position:relative;<%= (team.role === 'owner' || team.role === 'admin') ? 'cursor:pointer;' : '' %>" id="team-picture-wrap" <% if (team.role === 'owner' || team.role === 'admin') { %>onclick="document.getElementById('picture-input').click()" onmouseover="var o=this.querySelector('.pic-overlay');if(o)o.style.opacity='1'" onmouseout="var o=this.querySelector('.pic-overlay');if(o)o.style.opacity='0'"<% } %>>
        <% if (team.team_picture) { %>
          <img src="<%= team.team_picture %>" style="width:100%;height:100%;object-fit:cover;" id="team-picture-img">
        <% } else { %>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="var(--text-muted)" id="team-picture-placeholder"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
        <% } %>
        <% if (team.role === 'owner' || team.role === 'admin') { %>
          <div class="pic-overlay" style="position:absolute;inset:0;border-radius:50%;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.2s;">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="white"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z"/><path d="M9 2 7.17 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3.17L15 2H9zm3 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/></svg>
          </div>
          <input type="file" accept="image/*" id="picture-input" style="display:none;" onchange="openPictureCrop(this)">
        <% } %>
      </div>
      <div style="flex:1;min-width:0;">
        <h2 style="font-size:20px;font-weight:800;margin:0;"><%= team.team_name %></h2>
        <p style="color:var(--text-muted);font-size:12px;margin:2px 0 0;"><%= members.length %> member<%= members.length !== 1 ? 's' : '' %></p>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <% if (team.role === 'owner') { %>
          <span style="background:rgba(247,201,72,0.15);color:#f7c948;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;">OWNER</span>
        <% } %>
      </div>
    </div>
    <!-- Invite code for owners -->
    <% if (team.role === 'owner') { %>
      <div style="padding:0 20px 16px;display:flex;gap:8px;align-items:center;">
        <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:6px 12px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text-secondary);user-select:all;cursor:text;" title="Share this code to invite teammates"><%= team.invite_code %></div>
        <button onclick="navigator.clipboard.writeText('<%= team.invite_code %>');this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)" style="background:rgba(145,70,255,0.15);color:var(--accent);border:none;border-radius:6px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;">Copy</button>
      </div>
    <% } %>
```

Note: The opening `<div class="card">` for the members list section moves to just before the member list `<div style="border-top:...">`. The members list and everything after stays the same, but needs its own wrapping card now. Look at the original file — the members list `<div style="border-top:1px solid var(--border);padding-top:12px;">` that follows the header should be wrapped in a new card:

```html
  <div class="card" style="padding:20px;margin-bottom:20px;">
    <h3 style="font-size:15px;font-weight:700;margin-bottom:12px;">Members</h3>
```

And the existing members forEach loop and closing `</div>` tags stay as-is.

- [ ] **Step 2: Verify the page renders**

Run: `npm run dev`, navigate to a team detail page.
Expected: Banner area with gradient fallback, team picture placeholder, name + member count inline below. Owner sees hover overlays on banner and picture.

- [ ] **Step 3: Commit**

```bash
git add src/views/racing-team-detail.ejs
git commit -m "feat: redesign team detail header with banner + picture layout"
```

---

### Task 4: Crop Editor Modals + Upload Logic

**Files:**
- Modify: `src/views/racing-team-detail.ejs`

- [ ] **Step 1: Add crop modal HTML for team picture**

Before the closing `</div>` and before the existing `<script>` block at the bottom of `racing-team-detail.ejs`, add:

```html
<!-- Crop Picture Modal -->
<div id="crop-picture-modal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);" onclick="if(event.target===this)closePictureCrop()">
  <div style="background:#1a1b23;border-radius:12px;border:1px solid rgba(255,255,255,0.08);padding:24px;width:480px;max-width:95vw;" onclick="event.stopPropagation()">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
      <h3 style="font-size:16px;font-weight:700;margin:0;">Crop Team Picture</h3>
      <button onclick="closePictureCrop()" style="background:none;border:none;color:rgba(255,255,255,0.5);font-size:20px;cursor:pointer;padding:0 4px;line-height:1;">&times;</button>
    </div>
    <div style="display:flex;gap:20px;align-items:flex-start;">
      <canvas id="pic-crop-canvas" width="240" height="240" style="border-radius:8px;cursor:grab;flex-shrink:0;background:#0c0d14;"></canvas>
      <div style="display:flex;flex-direction:column;align-items:center;gap:8px;padding-top:8px;">
        <span style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Preview</span>
        <canvas id="pic-preview-56" width="56" height="56" style="border-radius:50%;border:2px solid rgba(255,255,255,0.1);"></canvas>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:14px;">
      <span style="font-size:12px;color:var(--text-muted);">&minus;</span>
      <input type="range" id="pic-zoom-slider" min="0" max="100" value="0" style="flex:1;accent-color:#3ecf8e;">
      <span style="font-size:12px;color:var(--text-muted);">+</span>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px;">
      <button onclick="closePictureCrop()" style="background:none;border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:8px 18px;color:rgba(255,255,255,0.6);font-size:13px;cursor:pointer;">Cancel</button>
      <button onclick="savePictureCrop()" style="background:#3ecf8e;border:none;border-radius:8px;padding:8px 22px;color:#0c0d14;font-size:13px;font-weight:700;cursor:pointer;">Save</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add crop modal HTML for banner**

Right after the picture crop modal, add:

```html
<!-- Crop Banner Modal -->
<div id="crop-banner-modal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);" onclick="if(event.target===this)closeBannerCrop()">
  <div style="background:#1a1b23;border-radius:12px;border:1px solid rgba(255,255,255,0.08);padding:24px;width:560px;max-width:95vw;" onclick="event.stopPropagation()">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
      <h3 style="font-size:16px;font-weight:700;margin:0;">Crop Banner</h3>
      <button onclick="closeBannerCrop()" style="background:none;border:none;color:rgba(255,255,255,0.5);font-size:20px;cursor:pointer;padding:0 4px;line-height:1;">&times;</button>
    </div>
    <canvas id="banner-crop-canvas" width="480" height="200" style="border-radius:8px;cursor:grab;background:#0c0d14;width:100%;"></canvas>
    <div style="display:flex;align-items:center;gap:8px;margin-top:14px;">
      <span style="font-size:12px;color:var(--text-muted);">&minus;</span>
      <input type="range" id="banner-zoom-slider" min="0" max="100" value="0" style="flex:1;accent-color:#3ecf8e;">
      <span style="font-size:12px;color:var(--text-muted);">+</span>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px;">
      <button onclick="closeBannerCrop()" style="background:none;border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:8px 18px;color:rgba(255,255,255,0.6);font-size:13px;cursor:pointer;">Cancel</button>
      <button onclick="saveBannerCrop()" style="background:#3ecf8e;border:none;border-radius:8px;padding:8px 22px;color:#0c0d14;font-size:13px;font-weight:700;cursor:pointer;">Save</button>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Add JavaScript for picture crop editor**

In the existing `<script>` block (or replace it entirely since we're adding substantial new JS), add the picture crop logic. This goes after the existing invite autocomplete script:

```js
// ── Team Picture Crop ──
var picImg = null, picZoom = 1, picMinZoom = 1, picMaxZoom = 3;
var picX = 0, picY = 0, picDragging = false, picDragStart = null;
var PIC_CANVAS = 240, PIC_CIRCLE_D = 200, PIC_CIRCLE_R = 100;
var PIC_CX = 120, PIC_CY = 120;

function openPictureCrop(input) {
  if (!input.files || !input.files[0]) return;
  var file = input.files[0];
  if (file.size > 5 * 1024 * 1024) { alert('Image too large (max 5MB)'); return; }
  var reader = new FileReader();
  reader.onload = function(e) {
    var img = new Image();
    img.onload = function() {
      picImg = img;
      picMinZoom = PIC_CIRCLE_D / Math.min(img.width, img.height);
      picMaxZoom = picMinZoom * 3;
      picZoom = picMinZoom;
      picX = PIC_CX - (img.width * picZoom) / 2;
      picY = PIC_CY - (img.height * picZoom) / 2;
      document.getElementById('crop-picture-modal').style.display = 'flex';
      document.getElementById('pic-zoom-slider').value = 0;
      setupPicCropEvents();
      renderPicCrop();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  input.value = '';
}

function closePictureCrop() {
  document.getElementById('crop-picture-modal').style.display = 'none';
}

function clampPicPos() {
  var sw = picImg.width * picZoom, sh = picImg.height * picZoom;
  picX = Math.min(PIC_CX - PIC_CIRCLE_R, Math.max(PIC_CX + PIC_CIRCLE_R - sw, picX));
  picY = Math.min(PIC_CY - PIC_CIRCLE_R, Math.max(PIC_CY + PIC_CIRCLE_R - sh, picY));
}

function renderPicCrop() {
  var canvas = document.getElementById('pic-crop-canvas');
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, PIC_CANVAS, PIC_CANVAS);
  ctx.drawImage(picImg, picX, picY, picImg.width * picZoom, picImg.height * picZoom);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, PIC_CANVAS, PIC_CANVAS);
  ctx.arc(PIC_CX, PIC_CY, PIC_CIRCLE_R, 0, Math.PI * 2, true);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(PIC_CX, PIC_CY, PIC_CIRCLE_R, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 2;
  ctx.stroke();
  // Preview
  var pCanvas = document.getElementById('pic-preview-56');
  var pCtx = pCanvas.getContext('2d');
  var srcCx = (PIC_CX - picX) / picZoom, srcCy = (PIC_CY - picY) / picZoom;
  var srcR = PIC_CIRCLE_R / picZoom;
  pCtx.clearRect(0, 0, 56, 56);
  pCtx.save();
  pCtx.beginPath();
  pCtx.arc(28, 28, 28, 0, Math.PI * 2);
  pCtx.clip();
  pCtx.drawImage(picImg, srcCx - srcR, srcCy - srcR, srcR * 2, srcR * 2, 0, 0, 56, 56);
  pCtx.restore();
}

function setupPicCropEvents() {
  var canvas = document.getElementById('pic-crop-canvas');
  var slider = document.getElementById('pic-zoom-slider');
  canvas.onmousedown = function(e) { picDragging = true; picDragStart = { x: e.clientX - picX, y: e.clientY - picY }; canvas.style.cursor = 'grabbing'; };
  window.addEventListener('mousemove', function picMove(e) { if (!picDragging) return; picX = e.clientX - picDragStart.x; picY = e.clientY - picDragStart.y; clampPicPos(); renderPicCrop(); });
  window.addEventListener('mouseup', function picUp() { picDragging = false; canvas.style.cursor = 'grab'; });
  canvas.ontouchstart = function(e) { e.preventDefault(); var t = e.touches[0]; picDragging = true; picDragStart = { x: t.clientX - picX, y: t.clientY - picY }; };
  canvas.ontouchmove = function(e) { e.preventDefault(); if (!picDragging) return; var t = e.touches[0]; picX = t.clientX - picDragStart.x; picY = t.clientY - picDragStart.y; clampPicPos(); renderPicCrop(); };
  canvas.ontouchend = function() { picDragging = false; };
  canvas.onwheel = function(e) {
    e.preventDefault();
    var oldZoom = picZoom;
    picZoom = Math.min(picMaxZoom, Math.max(picMinZoom, picZoom + (e.deltaY > 0 ? -0.02 : 0.02) * (picMaxZoom - picMinZoom)));
    var ratio = picZoom / oldZoom;
    picX = PIC_CX - (PIC_CX - picX) * ratio; picY = PIC_CY - (PIC_CY - picY) * ratio;
    clampPicPos(); slider.value = ((picZoom - picMinZoom) / (picMaxZoom - picMinZoom)) * 100; renderPicCrop();
  };
  slider.oninput = function() {
    var oldZoom = picZoom;
    picZoom = picMinZoom + (parseFloat(this.value) / 100) * (picMaxZoom - picMinZoom);
    var ratio = picZoom / oldZoom;
    picX = PIC_CX - (PIC_CX - picX) * ratio; picY = PIC_CY - (PIC_CY - picY) * ratio;
    clampPicPos(); renderPicCrop();
  };
}

function savePictureCrop() {
  var out = document.createElement('canvas');
  out.width = 128; out.height = 128;
  var ctx = out.getContext('2d');
  var srcCx = (PIC_CX - picX) / picZoom, srcCy = (PIC_CY - picY) / picZoom;
  var srcR = PIC_CIRCLE_R / picZoom;
  ctx.beginPath(); ctx.arc(64, 64, 64, 0, Math.PI * 2); ctx.clip();
  ctx.drawImage(picImg, srcCx - srcR, srcCy - srcR, srcR * 2, srcR * 2, 0, 0, 128, 128);
  var dataUrl = out.toDataURL('image/jpeg', 0.8);
  fetch('/racing/teams/<%= team.team_id %>/picture', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ picture: dataUrl }),
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.ok) {
      var wrap = document.getElementById('team-picture-wrap');
      var existing = document.getElementById('team-picture-img');
      var placeholder = document.getElementById('team-picture-placeholder');
      if (existing) { existing.src = dataUrl; }
      else {
        if (placeholder) placeholder.remove();
        var img = document.createElement('img');
        img.src = dataUrl; img.id = 'team-picture-img';
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
        wrap.insertBefore(img, wrap.querySelector('.pic-overlay'));
      }
      closePictureCrop();
    } else { alert(d.error || 'Upload failed'); }
  }).catch(function() { alert('Upload failed'); });
}
```

- [ ] **Step 4: Add JavaScript for banner crop editor**

Append the banner crop logic right after the picture crop code:

```js
// ── Team Banner Crop ──
var banImg = null, banZoom = 1, banMinZoom = 1, banMaxZoom = 3;
var banX = 0, banY = 0, banDragging = false, banDragStart = null;
var BAN_CW = 480, BAN_CH = 200;
var BAN_RECT_W = 440, BAN_RECT_H = 160;
var BAN_RX = (BAN_CW - BAN_RECT_W) / 2, BAN_RY = (BAN_CH - BAN_RECT_H) / 2;

function openBannerCrop(input) {
  if (!input.files || !input.files[0]) return;
  var file = input.files[0];
  if (file.size > 5 * 1024 * 1024) { alert('Image too large (max 5MB)'); return; }
  var reader = new FileReader();
  reader.onload = function(e) {
    var img = new Image();
    img.onload = function() {
      banImg = img;
      // Fit so image covers the crop rectangle
      banMinZoom = Math.max(BAN_RECT_W / img.width, BAN_RECT_H / img.height);
      banMaxZoom = banMinZoom * 3;
      banZoom = banMinZoom;
      banX = BAN_CW / 2 - (img.width * banZoom) / 2;
      banY = BAN_CH / 2 - (img.height * banZoom) / 2;
      document.getElementById('crop-banner-modal').style.display = 'flex';
      document.getElementById('banner-zoom-slider').value = 0;
      setupBannerCropEvents();
      renderBannerCrop();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  input.value = '';
}

function closeBannerCrop() {
  document.getElementById('crop-banner-modal').style.display = 'none';
}

function clampBanPos() {
  var sw = banImg.width * banZoom, sh = banImg.height * banZoom;
  banX = Math.min(BAN_RX, Math.max(BAN_RX + BAN_RECT_W - sw, banX));
  banY = Math.min(BAN_RY, Math.max(BAN_RY + BAN_RECT_H - sh, banY));
}

function renderBannerCrop() {
  var canvas = document.getElementById('banner-crop-canvas');
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, BAN_CW, BAN_CH);
  ctx.drawImage(banImg, banX, banY, banImg.width * banZoom, banImg.height * banZoom);
  // Dark overlay outside rectangle
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, BAN_CW, BAN_CH);
  ctx.rect(BAN_RX + BAN_RECT_W, BAN_RY, -BAN_RECT_W, BAN_RECT_H);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fill('evenodd');
  ctx.restore();
  // Rectangle border
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 2;
  ctx.strokeRect(BAN_RX, BAN_RY, BAN_RECT_W, BAN_RECT_H);
}

function setupBannerCropEvents() {
  var canvas = document.getElementById('banner-crop-canvas');
  var slider = document.getElementById('banner-zoom-slider');
  canvas.onmousedown = function(e) { banDragging = true; banDragStart = { x: e.clientX - banX, y: e.clientY - banY }; canvas.style.cursor = 'grabbing'; };
  window.addEventListener('mousemove', function banMove(e) { if (!banDragging) return; banX = e.clientX - banDragStart.x; banY = e.clientY - banDragStart.y; clampBanPos(); renderBannerCrop(); });
  window.addEventListener('mouseup', function banUp() { banDragging = false; canvas.style.cursor = 'grab'; });
  canvas.ontouchstart = function(e) { e.preventDefault(); var t = e.touches[0]; banDragging = true; banDragStart = { x: t.clientX - banX, y: t.clientY - banY }; };
  canvas.ontouchmove = function(e) { e.preventDefault(); if (!banDragging) return; var t = e.touches[0]; banX = t.clientX - banDragStart.x; banY = t.clientY - banDragStart.y; clampBanPos(); renderBannerCrop(); };
  canvas.ontouchend = function() { banDragging = false; };
  canvas.onwheel = function(e) {
    e.preventDefault();
    var oldZoom = banZoom;
    banZoom = Math.min(banMaxZoom, Math.max(banMinZoom, banZoom + (e.deltaY > 0 ? -0.02 : 0.02) * (banMaxZoom - banMinZoom)));
    var ratio = banZoom / oldZoom;
    banX = BAN_CW / 2 - (BAN_CW / 2 - banX) * ratio; banY = BAN_CH / 2 - (BAN_CH / 2 - banY) * ratio;
    clampBanPos(); slider.value = ((banZoom - banMinZoom) / (banMaxZoom - banMinZoom)) * 100; renderBannerCrop();
  };
  slider.oninput = function() {
    var oldZoom = banZoom;
    banZoom = banMinZoom + (parseFloat(this.value) / 100) * (banMaxZoom - banMinZoom);
    var ratio = banZoom / oldZoom;
    banX = BAN_CW / 2 - (BAN_CW / 2 - banX) * ratio; banY = BAN_CH / 2 - (BAN_CH / 2 - banY) * ratio;
    clampBanPos(); renderBannerCrop();
  };
}

function saveBannerCrop() {
  var out = document.createElement('canvas');
  out.width = 800; out.height = 200;
  var ctx = out.getContext('2d');
  var srcX = (BAN_RX - banX) / banZoom;
  var srcY = (BAN_RY - banY) / banZoom;
  var srcW = BAN_RECT_W / banZoom;
  var srcH = BAN_RECT_H / banZoom;
  ctx.drawImage(banImg, srcX, srcY, srcW, srcH, 0, 0, 800, 200);
  var dataUrl = out.toDataURL('image/jpeg', 0.85);
  fetch('/racing/teams/<%= team.team_id %>/banner', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ banner: dataUrl }),
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.ok) { location.reload(); }
    else { alert(d.error || 'Upload failed'); }
  }).catch(function() { alert('Upload failed'); });
}
```

- [ ] **Step 5: Test the full flow**

Run: `npm run dev`, navigate to a team detail page as the owner.
Expected:
1. Banner area shows gradient fallback, hover shows camera icon
2. Click banner → file picker → crop modal with rectangular crop area
3. Drag/zoom works, save uploads and page reloads with banner
4. Team picture shows placeholder, hover shows camera icon
5. Click picture → file picker → crop modal with circular crop area
6. Drag/zoom works, save uploads and picture updates inline

- [ ] **Step 6: Commit**

```bash
git add src/views/racing-team-detail.ejs
git commit -m "feat: add crop editor modals for team picture and banner"
```
