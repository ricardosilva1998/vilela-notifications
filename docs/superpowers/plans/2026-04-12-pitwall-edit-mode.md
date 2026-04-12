# Pitwall Edit Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a discoverable "Edit Layout" toggle in the pitwall top bar that lets users drag, resize, and freely place any of the nine overlay panels from anywhere on the tile, replacing the current hidden Lock Layout mechanism.

**Architecture:** Single-file change to `src/views/racing-pitwall.ejs`. Edit mode is a CSS class (`.editing`) applied to `#pitwall-grid` plus a pair of DOM elements (`.pitwall-drag-strip` and `.pitwall-iframe-shield`) added to every tile. The iframe shield is the linchpin — a transparent overlay that captures clicks that would otherwise be swallowed by iframes, letting gridstack treat any click on the tile as a drag. Gridstack config switches to `float: true` and all eight resize handles.

**Tech Stack:** EJS view, vanilla JS (no ESM, no build step), gridstack.js v10, CSS custom properties, localStorage.

**Spec:** `docs/superpowers/specs/2026-04-12-pitwall-edit-mode-design.md`

---

## File Structure

One file modified:

- `src/views/racing-pitwall.ejs` — adds Edit Layout button, edit mode state, drag strip and iframe shield DOM, edit-mode CSS. Removes Lock Layout infrastructure.

No new files. No changes to `src/routes/`, `src/services/pitwallRelay.js`, or any Bridge overlay HTML file.

## Testing Approach

`racing-pitwall.ejs` has no automated test coverage (no Playwright, no component tests). The project convention for this file is manual verification on the local dev server (`npm run dev` → http://localhost:3000/racing/pitwall after logging in as a racing user with at least one team).

Each task includes an explicit manual verification step that describes what to click and what to look for. Do not skip it — the pitwall is a visually-driven feature and "compiles" is not the same as "works."

---

## Task 1: Remove Lock Layout + enable free-form grid

**Files:**
- Modify: `src/views/racing-pitwall.ejs`

**What this task does:** Rips out the existing Lock Layout button and its state (unused once edit mode lands) and flips the gridstack config to `float: true` with all eight resize handles. The page looks identical to today afterwards — no edit mode yet — except the ⚙ settings panel no longer has a Lock button. This is a clean prep step so Task 2 has a tidy codebase to build on.

- [ ] **Step 1: Remove the `.toggle-panel .lock-btn` CSS block**

Open `src/views/racing-pitwall.ejs`. Find this block around lines 271-276:

```css
    .toggle-panel .lock-btn {
      background: var(--accent-glow);
      color: var(--accent);
      border-color: var(--border-focus);
    }
    .toggle-panel .lock-btn:hover { background: rgba(145,70,255,0.25); }
```

Delete the entire block (both rules, 6 lines).

- [ ] **Step 2: Remove the `.grid-stack.locked` CSS block**

Find this block around lines 346-348:

```css
    /* Lock mode — disable dragging visually */
    .grid-stack.locked .grid-stack-item > .ui-resizable-se { display: none; }
    .grid-stack.locked .grid-stack-item-content { cursor: default; }
```

Delete all three lines including the comment.

- [ ] **Step 3: Remove the `LOCK_KEY` constant**

Find this line around line 436:

```js
    var LOCK_KEY = 'pitwall-locked-v1';
```

Delete the whole line.

- [ ] **Step 4: Remove the `isLocked` state variable**

Find this line around line 444:

```js
    var isLocked = false;
```

Delete the whole line.

- [ ] **Step 5: Replace the lock-load + gridstack init + lock-apply block**

Find the `initGrid()` function body, starting around line 447. You are replacing lines 453-485 — from the "Load lock state" comment through the `isLocked` block after `grid.addWidget`. The current code is:

```js
      // Load lock state
      try { isLocked = localStorage.getItem(LOCK_KEY) === '1'; } catch(e) {}

      // Load saved layout or use defaults
      var layout = loadLayout();

      // Calculate row height based on viewport
      var availH = window.innerHeight - 48; // minus timing bar
      var cellH = Math.floor(availH / 10);

      grid = GridStack.init({
        column: 12,
        cellHeight: cellH,
        margin: 1,
        animate: true,
        float: false,
        disableOneColumnMode: true,
        removable: false,
        resizable: { handles: 'e,se,s' },
      }, '#pitwall-grid');

      // Add widgets
      layout.forEach(function(item) {
        addWidget(item);
      });

      // Apply lock state
      if (isLocked) {
        grid.enableMove(false);
        grid.enableResize(false);
        document.getElementById('pitwall-grid').classList.add('locked');
      }
```

Replace it with:

```js
      // Load saved layout or use defaults
      var layout = loadLayout();

      // Calculate row height based on viewport
      var availH = window.innerHeight - 48; // minus timing bar
      var cellH = Math.floor(availH / 10);

      grid = GridStack.init({
        column: 12,
        cellHeight: cellH,
        margin: 1,
        animate: true,
        float: true,
        disableOneColumnMode: true,
        removable: false,
        resizable: { handles: 'n,e,s,w,ne,nw,se,sw' },
      }, '#pitwall-grid');

      // Add widgets
      layout.forEach(function(item) {
        addWidget(item);
      });

      // Default: viewing mode — grid is present but drag/resize are off
      // until the user clicks Edit Layout (Task 2).
      grid.enableMove(false);
      grid.enableResize(false);
```

The three changes: `float: false` → `float: true`, `handles: 'e,se,s'` → `handles: 'n,e,s,w,ne,nw,se,sw'`, and the `if (isLocked)` block is replaced with an unconditional `enableMove(false) / enableResize(false)`.

- [ ] **Step 6: Remove the Lock button from `buildSettingsPanel()`**

Find this line around line 544 inside `buildSettingsPanel`:

```js
      html += '<button class="lock-btn" id="lock-btn" onclick="toggleLock()">' + (isLocked ? 'Unlock Layout' : 'Lock Layout') + '</button>';
```

Delete the whole line. The rest of `buildSettingsPanel` (the Show/Hide checkboxes and the Reset button) stays as-is.

- [ ] **Step 7: Remove the `toggleLock` function**

Find this block around lines 601-608:

```js
    window.toggleLock = function() {
      isLocked = !isLocked;
      grid.enableMove(!isLocked);
      grid.enableResize(!isLocked);
      document.getElementById('pitwall-grid').classList.toggle('locked', isLocked);
      document.getElementById('lock-btn').textContent = isLocked ? 'Unlock Layout' : 'Lock Layout';
      localStorage.setItem(LOCK_KEY, isLocked ? '1' : '0');
    };
```

Delete the whole function (including the blank line separator before the next `window.resetLayout` function).

- [ ] **Step 8: Clean `LOCK_KEY` out of `resetLayout`**

Find this block around lines 610-615:

```js
    window.resetLayout = function() {
      localStorage.removeItem(LAYOUT_KEY);
      localStorage.removeItem(HIDDEN_KEY);
      localStorage.removeItem(LOCK_KEY);
      location.reload();
    };
```

Replace it with:

```js
    window.resetLayout = function() {
      localStorage.removeItem(LAYOUT_KEY);
      localStorage.removeItem(HIDDEN_KEY);
      location.reload();
    };
```

Only the `localStorage.removeItem(LOCK_KEY);` line is deleted.

- [ ] **Step 9: Verify no `LOCK_KEY`, `isLocked`, `toggleLock`, or `.locked` references remain**

Run:

```bash
grep -nE 'LOCK_KEY|isLocked|toggleLock|\.grid-stack\.locked|lock-btn' src/views/racing-pitwall.ejs
```

Expected output: empty. Any hit means a reference was missed — re-check the steps above and remove it.

- [ ] **Step 10: Manual smoke test**

Start the dev server if it's not already running:

```bash
npm run dev
```

Log in as a racing user who is in at least one team, navigate to `/racing/pitwall`, select the team if prompted. Then:

- The page must load without any JavaScript errors in the devtools console. (F12 → Console tab.) Any reference to an undefined `isLocked` / `LOCK_KEY` / `toggleLock` here means you missed something in steps 1-9.
- The 9 panel placeholders must still appear in the same positions as before.
- Click the ⚙ settings button (top-right of the top bar). The slide-out panel must now show only two things: the "Show / Hide Overlays" checklist and a red "Reset" button. No Lock button anywhere.
- Click away from the settings panel to close it. Select your driver dot (or a teammate's). The iframes must still load their overlays the same as before.
- **Expected interim state:** Panels are not draggable and not resizable — try grabbing a panel edge and dragging; nothing happens. This is correct. Drag/resize will become available through the Edit Layout toggle in Task 2. Do not treat "can't drag" as a regression at this point.

- [ ] **Step 11: Commit**

```bash
git add src/views/racing-pitwall.ejs
git commit -m "$(cat <<'EOF'
refactor(pitwall): remove Lock Layout, switch grid to float:true + all handles

Prep for edit mode — rips out the isLocked / LOCK_KEY / toggleLock
mechanism (including its settings-panel button and .locked CSS rules)
and flips the gridstack init to float: true plus all eight resize
handles. Grid starts with drag and resize disabled so the page looks
identical to today until the edit-mode toggle lands in the next task.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add Edit Mode feature

**Files:**
- Modify: `src/views/racing-pitwall.ejs`

**What this task does:** Adds the `✎ Edit Layout` / `✓ Done` button to the top bar, the `isEditing` state, the `toggleEditMode()` function, the Escape keydown handler, the `.pitwall-drag-strip` + `.pitwall-iframe-shield` DOM elements injected into every tile, and all edit-mode CSS (border, cursor, drag strip, shield, resize handles, hiding `.panel-label`). After this task the feature is complete and shippable.

- [ ] **Step 1: Add `isEditing` state variable**

Find the block of state vars around lines 438-444 in `src/views/racing-pitwall.ejs` (after Task 1's edits, `isLocked` is gone). It currently looks like:

```js
    var grid = null;
    var ws = null;
    var reconnectTimer = null;
    var selectedDriverId = null;
    var onlineDrivers = new Set();
    var hiddenPanels = new Set();
```

Add `var isEditing = false;` on a new line right after `var hiddenPanels = new Set();`:

```js
    var grid = null;
    var ws = null;
    var reconnectTimer = null;
    var selectedDriverId = null;
    var onlineDrivers = new Set();
    var hiddenPanels = new Set();
    var isEditing = false;
```

- [ ] **Step 2: Add the Edit Layout button to the top bar**

Find this block around lines 387-390:

```html
    <button class="toolbar-btn" id="settings-btn" onclick="toggleSettingsPanel()" title="Layout settings">
      <i data-lucide="settings" style="width:16px;height:16px;"></i>
    </button>
  </div>
```

Insert a new button element immediately before the settings button:

```html
    <button class="edit-mode-btn" id="edit-mode-btn" onclick="toggleEditMode()" title="Rearrange panels (Esc to exit)">
      <span id="edit-mode-btn-label">✎ Edit Layout</span>
    </button>
    <button class="toolbar-btn" id="settings-btn" onclick="toggleSettingsPanel()" title="Layout settings">
      <i data-lucide="settings" style="width:16px;height:16px;"></i>
    </button>
  </div>
```

- [ ] **Step 3: Add the Edit Layout button CSS**

Find the `.toolbar-btn` CSS block around lines 206-220. After `.toolbar-btn.active { ... }` (around line 220), add a new block:

```css
    .edit-mode-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 32px;
      padding: 0 12px;
      border-radius: 6px;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      font-family: var(--font-body);
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: var(--transition);
      flex-shrink: 0;
      white-space: nowrap;
    }
    .edit-mode-btn:hover { background: var(--bg-hover); color: var(--text-secondary); }
    .edit-mode-btn.active {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    .edit-mode-btn.active:hover {
      background: var(--accent-hover);
      border-color: var(--accent-hover);
    }
```

- [ ] **Step 4: Add `toggleEditMode` and the Escape keydown listener**

Find the `resetLayout` function (currently around line 610 after Task 1's edits, containing only `LAYOUT_KEY` and `HIDDEN_KEY` removes). Add the new function and keydown listener immediately after `resetLayout`'s closing `};` and blank line. Before:

```js
    window.resetLayout = function() {
      localStorage.removeItem(LAYOUT_KEY);
      localStorage.removeItem(HIDDEN_KEY);
      location.reload();
    };

    // ── WebSocket ───────────────────────────────────────────────
    function connect() {
```

After:

```js
    window.resetLayout = function() {
      localStorage.removeItem(LAYOUT_KEY);
      localStorage.removeItem(HIDDEN_KEY);
      location.reload();
    };

    // ── Edit Mode ───────────────────────────────────────────────
    window.toggleEditMode = function() {
      isEditing = !isEditing;
      if (!grid) return;
      grid.enableMove(isEditing);
      grid.enableResize(isEditing);
      var gridEl = document.getElementById('pitwall-grid');
      var btn = document.getElementById('edit-mode-btn');
      var label = document.getElementById('edit-mode-btn-label');
      if (gridEl) gridEl.classList.toggle('editing', isEditing);
      if (btn) btn.classList.toggle('active', isEditing);
      if (label) label.textContent = isEditing ? '✓ Done' : '✎ Edit Layout';
    };

    window.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && isEditing) {
        window.toggleEditMode();
      }
    });

    // ── WebSocket ───────────────────────────────────────────────
    function connect() {
```

- [ ] **Step 5: Inject the drag strip and iframe shield into every tile**

Find the `addWidget` function around line 497. It currently looks like:

```js
    function addWidget(item) {
      var isHidden = hiddenPanels.has(item.id);
      var el = grid.addWidget({
        id: item.id,
        x: item.x, y: item.y,
        w: item.w, h: item.h,
        minW: 1, minH: 1,
        content:
          '<div class="panel-label">' + (PANEL_LABELS[item.id] || item.id) + '</div>' +
          '<div class="placeholder" id="placeholder-' + item.id + '">Waiting for driver...</div>' +
          '<iframe id="iframe-' + item.id + '" loading="lazy"></iframe>',
      });
      if (isHidden && el) {
        el.style.display = 'none';
        grid.update(el, { noMove: true, noResize: true });
      }
    }
```

Replace the `content:` string with:

```js
        content:
          '<div class="panel-label">' + (PANEL_LABELS[item.id] || item.id) + '</div>' +
          '<div class="pitwall-drag-strip"><span class="drag-grip">⋮⋮</span>' + (PANEL_LABELS[item.id] || item.id) + '</div>' +
          '<div class="placeholder" id="placeholder-' + item.id + '">Waiting for driver...</div>' +
          '<iframe id="iframe-' + item.id + '" loading="lazy"></iframe>' +
          '<div class="pitwall-iframe-shield"></div>',
```

The `.pitwall-drag-strip` goes after the existing `.panel-label` (so it sits above the iframe in z-order), and the `.pitwall-iframe-shield` goes after the iframe as its last sibling.

- [ ] **Step 6: Add the `.pitwall-drag-strip` CSS**

Find the `.grid-stack-item-content .panel-label` block in the `<style>` section (around line 294 in the original). After its closing brace, add:

```css
    .grid-stack-item-content .pitwall-drag-strip {
      display: none;
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 18px;
      padding: 0 8px;
      background: var(--accent);
      color: #fff;
      font-family: var(--font-body);
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      align-items: center;
      gap: 5px;
      z-index: 4;
      cursor: move;
      pointer-events: none;
      user-select: none;
    }
    .grid-stack-item-content .pitwall-drag-strip .drag-grip {
      color: #fff;
      font-size: 11px;
      letter-spacing: -2px;
      font-weight: 900;
      opacity: 0.85;
    }
```

Note: `pointer-events: none` is intentional. The gridstack drag handler is attached to the whole `.grid-stack-item` — the strip exists as a **visual** affordance only. Clicks on the strip fall through to the tile, which gridstack picks up as a drag-start. The shield (next step) is the element that actually intercepts the iframe clicks.

- [ ] **Step 7: Add the `.pitwall-iframe-shield` CSS**

In the same `<style>` block, add this rule right after the `.pitwall-drag-strip .drag-grip` rule from the previous step:

```css
    .grid-stack-item-content .pitwall-iframe-shield {
      display: none;
      position: absolute;
      inset: 0;
      z-index: 3;
      background: transparent;
      cursor: move;
    }
```

This div sits on top of the iframe (`z-index: 3` vs iframe's default 0) and captures all click events that would otherwise be swallowed by the iframe's own document.

- [ ] **Step 8: Add the `.pitwall-grid.editing` activation rules**

In the same `<style>` block, immediately after the `.pitwall-iframe-shield` rule from the previous step, add:

```css
    /* ── Edit Mode ── */
    #pitwall-grid.editing .grid-stack-item-content {
      border: 2px solid var(--accent);
      cursor: move;
    }
    #pitwall-grid.editing .grid-stack-item-content .pitwall-drag-strip {
      display: flex;
    }
    #pitwall-grid.editing .grid-stack-item-content .pitwall-iframe-shield {
      display: block;
    }
    #pitwall-grid.editing .grid-stack-item-content .panel-label {
      display: none;
    }
    #pitwall-grid.editing .grid-stack-item > .ui-resizable-handle {
      display: block !important;
      background: var(--accent);
      opacity: 0.85;
    }
    #pitwall-grid.editing .grid-stack-item > .ui-resizable-e,
    #pitwall-grid.editing .grid-stack-item > .ui-resizable-w {
      width: 6px;
      top: 50%;
      transform: translateY(-50%);
      height: 28px;
      border-radius: 3px;
    }
    #pitwall-grid.editing .grid-stack-item > .ui-resizable-n,
    #pitwall-grid.editing .grid-stack-item > .ui-resizable-s {
      height: 6px;
      left: 50%;
      transform: translateX(-50%);
      width: 28px;
      border-radius: 3px;
    }
    #pitwall-grid.editing .grid-stack-item > .ui-resizable-se,
    #pitwall-grid.editing .grid-stack-item > .ui-resizable-sw,
    #pitwall-grid.editing .grid-stack-item > .ui-resizable-ne,
    #pitwall-grid.editing .grid-stack-item > .ui-resizable-nw {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      border: 1.5px solid #fff;
      background: var(--accent);
    }
    /* Reset the old bottom-right-only visual override from the base styles */
    #pitwall-grid.editing .grid-stack-item > .ui-resizable-se::after {
      display: none;
    }
```

The `!important` on `.ui-resizable-handle` display is needed because gridstack itself applies inline styles to the handles — we need to force them visible in edit mode.

- [ ] **Step 9: Manual smoke test — the whole feature**

Run the dev server (`npm run dev` if not already running) and reload `/racing/pitwall` with devtools open (F12).

Test case 1 — **viewing mode default (no chrome)**
- Page loads with no JavaScript errors in the console.
- Top bar shows `✎ Edit Layout` button with a muted outline, to the left of the ⚙ settings button.
- No panel borders. No drag strips. Tiles look exactly like before edit mode was added.
- Clicking into a standings row (if you have a driver selected) works — the iframe is fully interactive.

Test case 2 — **entering edit mode**
- Click `✎ Edit Layout`.
- The button flips to solid purple with the label `✓ Done`.
- Every visible tile grows a 2px purple border.
- A purple 18px drag strip with `⋮⋮ PANEL NAME` appears at the top of each tile.
- All eight resize handles are visible on each tile: purple circles on the four corners, purple pill-shaped bars at the middle of each edge.

Test case 3 — **drag from inside a tile**
- In edit mode, grab the Session Laps tile from anywhere inside its body (not the edge).
- Drag it somewhere else — say, the centre of the grid.
- Drop it. It stays in the new position. Other tiles that were above it **do not** collapse down to fill the old spot (thanks to `float: true`).
- Drag Race Duration and Weather into the empty bottom row.

Test case 4 — **resize from every edge**
- Still in edit mode, grab the Track Map's **left** edge handle and drag left to widen it.
- Grab its **top** edge and drag up.
- Grab its bottom-right corner and drag down-right.
- Every drag should work and the tile should grow/shrink accordingly.

Test case 5 — **Done returns to viewing mode**
- Click `✓ Done`.
- Borders, drag strips, and resize handles all disappear.
- The button label returns to `✎ Edit Layout` with muted styling.
- Tile content becomes clickable again (click a standings row to verify).

Test case 6 — **Escape exits edit mode**
- Click `✎ Edit Layout` again.
- Press Escape.
- Edit mode exits the same as clicking Done.

Test case 7 — **persistence across reloads**
- Enter edit mode, drag a panel to a new spot, click Done.
- Reload the page (Cmd+R / Ctrl+R).
- Page opens in viewing mode (default) and the moved panel is still in its new spot.

Test case 8 — **settings panel still works**
- Click the ⚙ settings button.
- The panel shows "Show / Hide Overlays" checkboxes + Reset button, no Lock button.
- Untick one panel (e.g. Weather) — it hides from the grid. Re-tick it — it comes back.

Test case 9 — **Reset still works**
- Click ⚙ → Reset. Page reloads. Layout returns to the default (Standings wide on the left, etc.), your hidden panels are re-shown, and edit mode is off. No errors in console.

If any test case fails, re-check the relevant step above and fix inline before committing.

- [ ] **Step 10: Commit**

```bash
git add src/views/racing-pitwall.ejs
git commit -m "$(cat <<'EOF'
feat(pitwall): Edit Layout toggle with drag strip + iframe shield

Adds a discoverable ✎ Edit Layout button in the top bar that flips
the grid into rearrange mode — purple borders on every tile, a drag
strip with ⋮⋮ grip across the top of each, visible resize handles on
all eight edges, and a transparent iframe shield that intercepts
clicks so gridstack receives them as drag events instead of the
iframe swallowing them. Escape exits edit mode.

Viewing mode (the default) is visually unchanged — no borders, no
grips, no shield — so the watching experience stays clean. float:true
was already enabled in the previous task so dropped panels stay where
the user puts them.

See docs/superpowers/specs/2026-04-12-pitwall-edit-mode-design.md

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Post-Implementation

After Task 2 is committed, the branch is ready to push. Let the user push — `git push origin main` triggers the Railway build. The user will verify on Railway production as the final check.

No version bump needed — `src/views/racing-pitwall.ejs` is a server-side EJS view, not a Bridge file. No automated tests to run. No migration to run.
