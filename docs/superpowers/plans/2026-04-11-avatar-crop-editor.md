# Avatar Crop Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the auto-crop avatar upload with an interactive circular crop editor modal (drag-to-pan, scroll/slider-to-zoom, live previews).

**Architecture:** All client-side in `src/views/racing-account.ejs`. The existing `uploadAvatar()` function is replaced with one that opens a modal. The modal uses canvas rendering for the crop area and live previews. No server changes — same `POST /racing/account/avatar` endpoint with base64 JPEG.

**Tech Stack:** Vanilla JS, Canvas API, existing CSS custom properties.

**Spec:** `docs/superpowers/specs/2026-04-11-avatar-crop-editor-design.md`

---

### Task 1: Add crop editor modal HTML

**Files:**
- Modify: `src/views/racing-account.ejs:175` (insert modal markup before `</div>` closing the page wrapper)

- [ ] **Step 1: Add the modal HTML right before the closing `</div>` at line 175**

Insert this block at line 175 (before the existing `</div>`):

```html
<!-- Avatar Crop Editor Modal -->
<div id="crop-modal" style="display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.7);align-items:center;justify-content:center;" onclick="if(event.target===this)closeCropModal()">
  <div style="background:#1a1b23;border-radius:12px;padding:20px;width:480px;max-width:95vw;border:1px solid rgba(255,255,255,0.08);" onclick="event.stopPropagation()">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <span style="color:#fff;font-size:14px;font-weight:700;">Crop Avatar</span>
      <span onclick="closeCropModal()" style="color:rgba(255,255,255,0.4);cursor:pointer;font-size:18px;line-height:1;padding:4px;">&times;</span>
    </div>
    <div style="display:flex;gap:20px;align-items:center;">
      <!-- Crop area -->
      <div style="position:relative;flex-shrink:0;">
        <canvas id="crop-canvas" width="240" height="240" style="border-radius:8px;cursor:grab;display:block;"></canvas>
      </div>
      <!-- Live previews -->
      <div style="display:flex;flex-direction:column;align-items:center;gap:12px;">
        <span style="color:rgba(255,255,255,0.4);font-size:11px;text-transform:uppercase;letter-spacing:1px;">Preview</span>
        <canvas id="crop-preview-72" width="72" height="72" style="border-radius:50%;border:2px solid rgba(255,255,255,0.1);"></canvas>
        <canvas id="crop-preview-36" width="36" height="36" style="border-radius:50%;border:2px solid rgba(255,255,255,0.1);"></canvas>
        <span style="color:rgba(255,255,255,0.3);font-size:10px;">72px &nbsp; 36px</span>
      </div>
    </div>
    <!-- Zoom slider -->
    <div style="display:flex;align-items:center;gap:8px;margin-top:14px;">
      <span style="color:rgba(255,255,255,0.4);font-size:11px;">−</span>
      <input id="crop-zoom" type="range" min="0" max="100" value="0" style="flex:1;accent-color:#3ecf8e;height:3px;">
      <span style="color:rgba(255,255,255,0.4);font-size:11px;">+</span>
    </div>
    <!-- Buttons -->
    <div style="display:flex;gap:8px;margin-top:16px;">
      <button onclick="closeCropModal()" style="flex:1;padding:8px;background:none;border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:rgba(255,255,255,0.5);font-size:12px;cursor:pointer;">Cancel</button>
      <button onclick="saveCrop()" style="flex:1;padding:8px;background:#3ecf8e;border:none;border-radius:8px;color:#0d0e14;font-size:12px;font-weight:700;cursor:pointer;">Save</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Commit**

```bash
git add src/views/racing-account.ejs
git commit -m "feat(racing): add crop editor modal markup"
```

---

### Task 2: Replace uploadAvatar with crop editor logic

**Files:**
- Modify: `src/views/racing-account.ejs:177-212` (replace entire `<script>` block)

- [ ] **Step 1: Replace the `<script>` block (lines 177-213) with the crop editor JS**

Replace the entire `<script>...</script>` block with:

```html
<script>
// Crop editor state
let cropImg = null;
let cropZoom = 1;
let cropMinZoom = 1;
let cropMaxZoom = 3;
let cropX = 0, cropY = 0;
let cropDragging = false;
let cropDragStart = { x: 0, y: 0, cx: 0, cy: 0 };
let cropRaf = null;

function uploadAvatar(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  if (file.size > 5000000) { alert('Image too large (max 5MB)'); return; }

  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      cropImg = img;
      // Fit image so circle (diameter 200 within 240 canvas) is fully covered
      const circleD = 200;
      cropMinZoom = circleD / Math.min(img.width, img.height);
      cropMaxZoom = cropMinZoom * 3;
      cropZoom = cropMinZoom;
      cropX = 0; cropY = 0;
      document.getElementById('crop-zoom').value = 0;
      openCropModal();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function openCropModal() {
  const modal = document.getElementById('crop-modal');
  modal.style.display = 'flex';
  setupCropEvents();
  renderCrop();
}

function closeCropModal() {
  const modal = document.getElementById('crop-modal');
  modal.style.display = 'none';
  if (cropRaf) { cancelAnimationFrame(cropRaf); cropRaf = null; }
  // Reset file input so same file can be re-selected
  document.getElementById('avatar-input').value = '';
}

function clampCropPosition() {
  if (!cropImg) return;
  const canvas = document.getElementById('crop-canvas');
  const cw = canvas.width, ch = canvas.height;
  const iw = cropImg.width * cropZoom, ih = cropImg.height * cropZoom;
  // Center of canvas
  const cx = cw / 2, cy = ch / 2;
  const circleR = 100; // radius of crop circle
  // Clamp so circle area is always filled
  const minX = cx + circleR - iw;
  const maxX = cx - circleR;
  const minY = cy + circleR - ih;
  const maxY = cy - circleR;
  cropX = Math.max(minX, Math.min(maxX, cropX));
  cropY = Math.max(minY, Math.min(maxY, cropY));
}

function renderCrop() {
  if (!cropImg) return;
  const canvas = document.getElementById('crop-canvas');
  const ctx = canvas.getContext('2d');
  const cw = canvas.width, ch = canvas.height;
  const cx = cw / 2, cy = ch / 2;
  const circleR = 100;

  clampCropPosition();

  // Clear
  ctx.clearRect(0, 0, cw, ch);

  // Draw image
  const iw = cropImg.width * cropZoom, ih = cropImg.height * cropZoom;
  ctx.drawImage(cropImg, cropX, cropY, iw, ih);

  // Dark overlay outside circle
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, cw, ch);
  ctx.arc(cx, cy, circleR, 0, Math.PI * 2, true);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fill();
  ctx.restore();

  // Circle border
  ctx.beginPath();
  ctx.arc(cx, cy, circleR, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Update previews
  renderPreview('crop-preview-72', 72);
  renderPreview('crop-preview-36', 36);
}

function renderPreview(canvasId, size) {
  if (!cropImg) return;
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext('2d');
  const cropCanvas = document.getElementById('crop-canvas');
  const cw = cropCanvas.width;
  const cx = cw / 2;
  const circleR = 100;

  // Source: the circle region from the image
  // The circle center in image coords: (cx - cropX) / cropZoom, (cy - cropY) / cropZoom
  const srcCx = (cx - cropX) / cropZoom;
  const srcCy = (cx - cropY) / cropZoom; // same center calc for Y using cy which equals cx (both 120)
  const srcR = circleR / cropZoom;

  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(cropImg,
    srcCx - srcR, srcCy - srcR, srcR * 2, srcR * 2,
    0, 0, size, size
  );
  ctx.restore();
}

function setupCropEvents() {
  const canvas = document.getElementById('crop-canvas');

  // Mouse drag
  canvas.onmousedown = function(e) {
    cropDragging = true;
    cropDragStart = { x: e.clientX, y: e.clientY, cx: cropX, cy: cropY };
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
  };
  window.onmousemove = function(e) {
    if (!cropDragging) return;
    cropX = cropDragStart.cx + (e.clientX - cropDragStart.x);
    cropY = cropDragStart.cy + (e.clientY - cropDragStart.y);
    renderCrop();
  };
  window.onmouseup = function() {
    if (cropDragging) {
      cropDragging = false;
      canvas.style.cursor = 'grab';
    }
  };

  // Touch drag
  canvas.ontouchstart = function(e) {
    if (e.touches.length !== 1) return;
    cropDragging = true;
    const t = e.touches[0];
    cropDragStart = { x: t.clientX, y: t.clientY, cx: cropX, cy: cropY };
    e.preventDefault();
  };
  canvas.ontouchmove = function(e) {
    if (!cropDragging || e.touches.length !== 1) return;
    const t = e.touches[0];
    cropX = cropDragStart.cx + (t.clientX - cropDragStart.x);
    cropY = cropDragStart.cy + (t.clientY - cropDragStart.y);
    renderCrop();
    e.preventDefault();
  };
  canvas.ontouchend = function() { cropDragging = false; };

  // Scroll zoom
  canvas.onwheel = function(e) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.02 : 0.02;
    const range = cropMaxZoom - cropMinZoom;
    cropZoom = Math.max(cropMinZoom, Math.min(cropMaxZoom, cropZoom + delta * range));
    // Sync slider
    document.getElementById('crop-zoom').value = ((cropZoom - cropMinZoom) / range) * 100;
    renderCrop();
  };

  // Slider zoom
  document.getElementById('crop-zoom').oninput = function() {
    const range = cropMaxZoom - cropMinZoom;
    cropZoom = cropMinZoom + (this.value / 100) * range;
    renderCrop();
  };
}

function saveCrop() {
  if (!cropImg) return;
  const cropCanvas = document.getElementById('crop-canvas');
  const cw = cropCanvas.width;
  const cx = cw / 2;
  const circleR = 100;

  // Output 128x128
  const out = document.createElement('canvas');
  out.width = 128; out.height = 128;
  const octx = out.getContext('2d');

  // Source region from original image
  const srcCx = (cx - cropX) / cropZoom;
  const srcCy = (cx - cropY) / cropZoom;
  const srcR = circleR / cropZoom;

  octx.drawImage(cropImg,
    srcCx - srcR, srcCy - srcR, srcR * 2, srcR * 2,
    0, 0, 128, 128
  );

  const dataUrl = out.toDataURL('image/jpeg', 0.8);

  fetch('/racing/account/avatar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatar: dataUrl }),
  }).then(r => r.json()).then(d => {
    if (d.ok) {
      document.getElementById('avatar-preview').innerHTML = '<img src="' + dataUrl + '" style="width:100%;height:100%;object-fit:cover;">';
      // Also update nav avatar if present
      const navAvatar = document.querySelector('nav img[style*="border-radius:50%"]');
      if (navAvatar) navAvatar.src = dataUrl;
      closeCropModal();
    } else {
      alert(d.error || 'Upload failed');
    }
  }).catch(() => alert('Upload failed'));
}
</script>
```

- [ ] **Step 2: Commit**

```bash
git add src/views/racing-account.ejs
git commit -m "feat(racing): interactive avatar crop editor with drag/zoom/preview"
```

---

### Task 3: Manual testing

**Files:** None (testing only)

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```

- [ ] **Step 2: Open the Racing account page in a browser**

Navigate to the Racing account page (log in with a Racing account first).

- [ ] **Step 3: Test the crop editor flow**

1. Click "Change Photo" → select an image file
2. Verify: modal opens with the image centered, circle mask visible, two preview circles on the right
3. Drag the image around → verify the image pans and previews update live
4. Scroll up/down on the crop area → verify zoom in/out works
5. Move the zoom slider → verify it zooms and syncs with scroll
6. Try dragging the image to the edge → verify it clamps (circle always filled)
7. Click "Save" → verify the avatar updates on the page and in the nav bar
8. Click "Change Photo" again → select a different image → click "Cancel" → verify nothing changes
9. Click backdrop outside modal → verify modal closes
10. Try with a very wide image (landscape) and a very tall image (portrait) → verify both crop correctly
11. Try with a large file (>5MB) → verify the error message appears

- [ ] **Step 4: Commit any fixes if needed**
