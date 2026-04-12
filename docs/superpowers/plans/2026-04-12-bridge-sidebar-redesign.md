# Bridge Sidebar Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the always-expanded category accordions in `bridge/control-panel.html` with a search-first sidebar plus dedicated Favorites and Recent grid pages, so the user can reach the overlay they want in one click.

**Architecture:** Pure data helpers extracted to a new testable `bridge/sidebarState.js` module. State persisted via two new IPC channels (`get-ui-state` / `save-ui-state`) on top of the existing `settings.json` (additive — `uiFavorites`, `uiRecent`, `uiSidebarGroups`). The control-panel renderer reads UI state once on init, applies it to the sidebar + cards, and writes back on every user click. A single shared `renderOverlayCard()` function powers Overview, Favorites, and Recent pages.

**Tech Stack:** Plain CommonJS Node 20+, Electron 28 IPC, vanilla DOM, Node built-in `node:test` (no new deps).

**Spec:** `docs/superpowers/specs/2026-04-12-bridge-sidebar-redesign.md`

---

## File Structure

| Path | Action | Purpose |
|---|---|---|
| `bridge/sidebarState.js` | **Create** | Pure data helpers: `pushRecent`, `toggleFavorite`, `pruneStaleIds`, `isFavorite`. No DOM, no IPC, no Electron. |
| `bridge/test-sidebarState.js` | **Create** | `node:test` suite with 14 unit tests. |
| `bridge/main.js` | **Modify** | Apply defaults for new settings keys after `loadSettings()`. Add `get-ui-state` (sync) + `save-ui-state` (async) IPC handlers. |
| `bridge/control-panel.html` | **Modify** | New sidebar markup (search field, Favorites/Recent rows, all groups collapsed by default). New `panel-favorites` + `panel-recent` content panels. New shared `renderOverlayCard()` + per-page render helpers. New `applySearchFilter()`, `pushRecent`-into-`navigateTo` integration, `toggleFavorite()`, `⌘K`/`Ctrl+K` hotkey. CSS additions for search input, cards, and empty states. |
| `bridge/package.json` | **Modify** | Bump `3.23.x` → `3.24.0`. |

---

## Task 1: Pure data helpers + tests

**Files:**
- Create: `bridge/sidebarState.js`
- Create: `bridge/test-sidebarState.js`

- [ ] **Step 1: Write the failing tests**

Create `bridge/test-sidebarState.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  pushRecent,
  toggleFavorite,
  pruneStaleIds,
  isFavorite,
} = require('./sidebarState');

test('pushRecent: adds to empty list', () => {
  assert.deepEqual(pushRecent([], 'fuel'), ['fuel']);
});

test('pushRecent: prepends to front', () => {
  assert.deepEqual(pushRecent(['standings'], 'fuel'), ['fuel', 'standings']);
});

test('pushRecent: dedupes existing entry by moving to front', () => {
  assert.deepEqual(
    pushRecent(['standings', 'fuel', 'weather'], 'fuel'),
    ['fuel', 'standings', 'weather']
  );
});

test('pushRecent: caps at default max=5', () => {
  const result = pushRecent(['a', 'b', 'c', 'd', 'e'], 'f');
  assert.equal(result.length, 5);
  assert.deepEqual(result, ['f', 'a', 'b', 'c', 'd']);
});

test('pushRecent: respects custom max', () => {
  assert.deepEqual(pushRecent(['a', 'b'], 'c', 2), ['c', 'a']);
});

test('pushRecent: ignores empty/null id', () => {
  assert.deepEqual(pushRecent(['a'], null), ['a']);
  assert.deepEqual(pushRecent(['a'], ''), ['a']);
});

test('pushRecent: does not mutate the input array', () => {
  const original = ['a', 'b'];
  pushRecent(original, 'c');
  assert.deepEqual(original, ['a', 'b']);
});

test('toggleFavorite: adds new favorite', () => {
  assert.deepEqual(toggleFavorite([], 'fuel'), ['fuel']);
});

test('toggleFavorite: removes existing favorite', () => {
  assert.deepEqual(toggleFavorite(['fuel'], 'fuel'), []);
});

test('toggleFavorite: preserves order when adding (newest at end)', () => {
  assert.deepEqual(
    toggleFavorite(['standings', 'fuel'], 'weather'),
    ['standings', 'fuel', 'weather']
  );
});

test('toggleFavorite: removes from middle without disturbing others', () => {
  assert.deepEqual(
    toggleFavorite(['standings', 'fuel', 'weather'], 'fuel'),
    ['standings', 'weather']
  );
});

test('pruneStaleIds: keeps only valid ids', () => {
  assert.deepEqual(
    pruneStaleIds(['standings', 'old1', 'fuel', 'old2'], ['standings', 'fuel', 'weather']),
    ['standings', 'fuel']
  );
});

test('pruneStaleIds: preserves order', () => {
  assert.deepEqual(
    pruneStaleIds(['fuel', 'standings'], ['standings', 'fuel', 'weather']),
    ['fuel', 'standings']
  );
});

test('isFavorite: returns true for present id', () => {
  assert.equal(isFavorite(['fuel', 'standings'], 'fuel'), true);
});

test('isFavorite: returns false for absent id', () => {
  assert.equal(isFavorite(['fuel'], 'standings'), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```
cd bridge && node --test test-sidebarState.js
```

Expected: `Cannot find module './sidebarState'` (the module doesn't exist yet).

- [ ] **Step 3: Create `sidebarState.js`**

Create `bridge/sidebarState.js`:

```js
'use strict';

// Pure data helpers for the Bridge control-panel sidebar UI state.
// No DOM, no IPC, no Electron — testable with node:test.

const RECENT_MAX_DEFAULT = 5;

function pushRecent(recent, overlayId, max = RECENT_MAX_DEFAULT) {
  if (!overlayId) return recent.slice();
  const filtered = recent.filter((id) => id !== overlayId);
  filtered.unshift(overlayId);
  return filtered.slice(0, max);
}

function toggleFavorite(favorites, overlayId) {
  if (!overlayId) return favorites.slice();
  const idx = favorites.indexOf(overlayId);
  if (idx >= 0) {
    return favorites.filter((id) => id !== overlayId);
  }
  return [...favorites, overlayId];
}

function pruneStaleIds(arr, validIds) {
  const valid = new Set(validIds);
  return arr.filter((id) => valid.has(id));
}

function isFavorite(favorites, overlayId) {
  return favorites.indexOf(overlayId) !== -1;
}

module.exports = {
  pushRecent,
  toggleFavorite,
  pruneStaleIds,
  isFavorite,
  RECENT_MAX_DEFAULT,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```
cd bridge && node --test test-sidebarState.js
```

Expected: 15 tests pass.

- [ ] **Step 5: Commit**

```bash
git add bridge/sidebarState.js bridge/test-sidebarState.js
git commit -m "feat(bridge): sidebar state helpers (pushRecent, toggleFavorite, pruneStaleIds)"
```

---

## Task 2: main.js — IPC handlers + settings defaults

**Files:**
- Modify: `bridge/main.js`

- [ ] **Step 1: Add settings defaults after `loadSettings()`**

Find the existing `settings = loadSettings();` line (around line 98). Immediately after the existing post-load setup (after the `setIncidentCountersEnabled` block from v3.23 and any existing migrations), add:

```js
  // Defaults for the v3.24 sidebar redesign — additive, no migration needed.
  if (!Array.isArray(settings.uiFavorites)) settings.uiFavorites = [];
  if (!Array.isArray(settings.uiRecent)) settings.uiRecent = [];
  if (!settings.uiSidebarGroups || typeof settings.uiSidebarGroups !== 'object') {
    settings.uiSidebarGroups = { race: true, car: true, track: true, stream: true };
  }
```

Place it AFTER any existing `try { ... } catch {}` migration blocks but BEFORE the `if (!settings.racingUsername)` login-window check.

- [ ] **Step 2: Add the two new IPC handlers**

In `bridge/main.js`, find an existing `ipcMain.on(...)` block (search for `ipcMain.on('toggle-overlay'` or similar). Add the two new handlers nearby:

```js
// UI state for the new sidebar (favorites, recent, group collapse)
ipcMain.on('get-ui-state', (event) => {
  event.returnValue = {
    uiFavorites: Array.isArray(settings.uiFavorites) ? settings.uiFavorites : [],
    uiRecent: Array.isArray(settings.uiRecent) ? settings.uiRecent : [],
    uiSidebarGroups: (settings.uiSidebarGroups && typeof settings.uiSidebarGroups === 'object')
      ? settings.uiSidebarGroups
      : { race: true, car: true, track: true, stream: true },
  };
});

ipcMain.on('save-ui-state', (event, patch) => {
  if (!patch || typeof patch !== 'object') return;
  if (Array.isArray(patch.uiFavorites)) settings.uiFavorites = patch.uiFavorites;
  if (Array.isArray(patch.uiRecent)) settings.uiRecent = patch.uiRecent;
  if (patch.uiSidebarGroups && typeof patch.uiSidebarGroups === 'object') {
    settings.uiSidebarGroups = { ...(settings.uiSidebarGroups || {}), ...patch.uiSidebarGroups };
  }
  try { saveSettings(settings); } catch (e) { console.error('[main] save-ui-state error:', e); }
});
```

- [ ] **Step 3: Syntax check**

Run:
```
node --check /Users/ricardosilva/vilela-notifications/.worktrees/sidebar-redesign/bridge/main.js
```

Expected: clean exit.

- [ ] **Step 4: Commit**

```bash
git add bridge/main.js
git commit -m "feat(bridge): IPC handlers + defaults for uiFavorites/uiRecent/uiSidebarGroups"
```

---

## Task 3: control-panel.html — sidebar markup rewrite

**Files:**
- Modify: `bridge/control-panel.html`

This task adds the search field, the two new sidebar entries (Favorites + Recent), the two new content panel divs (`panel-favorites`, `panel-recent`), and changes the four category accordions to default-collapsed. It does NOT yet wire up rendering, search filtering, or persistence — those land in later tasks.

- [ ] **Step 1: Add the search field at the very top of the sidebar**

Find this line (around line 298):

```html
    <div class="sidebar">
      <div class="sidebar-item active" data-panel="overview" onclick="navigateTo('overview')">
```

Replace with:

```html
    <div class="sidebar">
      <div class="sidebar-search-wrap">
        <input type="search" id="sidebar-search" class="sidebar-search-input" placeholder="🔎 Search overlays…" autocomplete="off" spellcheck="false">
        <div id="sidebar-search-empty" class="sidebar-search-empty" style="display:none;"></div>
      </div>
      <div class="sidebar-item active" data-panel="overview" onclick="navigateTo('overview')">
```

- [ ] **Step 2: Add the Favorites + Recent sidebar entries**

Find:

```html
      <div class="sidebar-item active" data-panel="overview" onclick="navigateTo('overview')">
        <span class="sidebar-icon">&#9638;</span> Overview
      </div>
      <div class="sidebar-divider"></div>
      <div class="sidebar-group-label" onclick="toggleSidebarGroup('race')">&#9660; Race</div>
```

Replace with:

```html
      <div class="sidebar-item active" data-panel="overview" onclick="navigateTo('overview')">
        <span class="sidebar-icon">&#9638;</span> Overview
      </div>
      <div class="sidebar-item" data-panel="favorites" onclick="navigateTo('favorites')">
        <span class="sidebar-icon" style="color:#f7c948;">&#9733;</span> Favorites
      </div>
      <div class="sidebar-item" data-panel="recent" onclick="navigateTo('recent')">
        <span class="sidebar-icon" style="color:#3ecf8e;">&#128340;</span> Recent
      </div>
      <div class="sidebar-divider"></div>
      <div class="sidebar-group-label" onclick="toggleSidebarGroup('race')">&#9654; Race</div>
```

(Note: the arrow on `Race` changes from `&#9660;` (▼ open) to `&#9654;` (▶ collapsed) since groups now default-collapsed.)

- [ ] **Step 3: Default all four categorized groups to collapsed**

Find the four `sidebar-group` divs (`group-race`, `group-car`, `group-track`, `group-stream`) and add the `collapsed` class to each. They currently look like:

```html
      <div class="sidebar-group" id="group-race">
```

Change to:

```html
      <div class="sidebar-group collapsed" id="group-race">
```

Do the same for `group-car`, `group-track`, `group-stream`.

Also update each group label arrow from `&#9660;` to `&#9654;`. Find:

```html
      <div class="sidebar-group-label" onclick="toggleSidebarGroup('car')">&#9660; Car</div>
      ...
      <div class="sidebar-group-label" onclick="toggleSidebarGroup('track')">&#9660; Track</div>
      ...
      <div class="sidebar-group-label" onclick="toggleSidebarGroup('stream')">&#9660; Stream</div>
```

Replace each `&#9660;` with `&#9654;` so all four group labels show the collapsed-arrow on first render.

- [ ] **Step 4: Add the new content panel divs**

Find this block (around line 424):

```html
      <!-- ═══ OVERVIEW PANEL ═══ -->
      <div class="content-panel active" id="panel-overview">
```

Immediately BEFORE the `<!-- ═══ OVERVIEW PANEL ═══ -->` comment, add:

```html
      <!-- ═══ FAVORITES PANEL ═══ -->
      <div class="content-panel" id="panel-favorites"></div>

      <!-- ═══ RECENT PANEL ═══ -->
      <div class="content-panel" id="panel-recent"></div>

```

- [ ] **Step 5: Add CSS for the search input + empty state + dim modifier**

Find the `.sidebar-footer` rule (around line 55) and add new rules immediately after it:

```css
    .sidebar-search-wrap { padding: 8px 10px 4px; }
    .sidebar-search-input {
      width: 100%;
      padding: 6px 10px;
      background: #0c0d14;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 5px;
      color: #c0bfd0;
      font-size: 11px;
      outline: none;
      font-family: inherit;
    }
    .sidebar-search-input:focus { border-color: rgba(145,70,255,0.4); }
    .sidebar-search-input::placeholder { color: #5c5b6e; }
    .sidebar-search-empty {
      font-size: 10px;
      color: #5c5b6e;
      padding: 6px 12px;
      font-style: italic;
    }
    .sidebar-item.search-dim { opacity: 0.35; }
    .sidebar-item.search-hidden { display: none; }
    .sidebar-group-label.search-hidden { display: none; }
```

- [ ] **Step 6: Visual smoke check**

Open the file in a browser via the test server to verify the markup renders without breaking:

```
node bridge/tests/serve.js
```

(Or just inspect by running `node --check` to validate that the inline JS still parses.)

Run:
```
node -e "const fs=require('fs'); const html=fs.readFileSync('bridge/control-panel.html','utf8'); console.log('search input:', html.includes('id=\"sidebar-search\"')); console.log('favorites entry:', html.includes('data-panel=\"favorites\"')); console.log('recent entry:', html.includes('data-panel=\"recent\"')); console.log('panel-favorites div:', html.includes('id=\"panel-favorites\"')); console.log('panel-recent div:', html.includes('id=\"panel-recent\"')); console.log('group-race collapsed:', html.includes('sidebar-group collapsed\" id=\"group-race\"'));"
```

Expected: all six checks print `true`.

- [ ] **Step 7: Commit**

```bash
git add bridge/control-panel.html
git commit -m "feat(bridge): sidebar markup — search field, favorites/recent rows, collapsed groups"
```

---

## Task 4: control-panel.html — UI state init + group collapse persistence

**Files:**
- Modify: `bridge/control-panel.html`

- [ ] **Step 1: Add a UI state cache + load helper near the top of the script**

In `bridge/control-panel.html`, find the top of the `<script>` block that defines `currentPanel` (search for `let currentPanel`). Just BEFORE that line, add:

```js
    // ─── UI state (favorites, recent, sidebar groups) ────────
    let uiState = { uiFavorites: [], uiRecent: [], uiSidebarGroups: { race: true, car: true, track: true, stream: true } };
    try {
      const fromMain = ipcRenderer.sendSync('get-ui-state');
      if (fromMain) uiState = fromMain;
    } catch (e) { /* renderer running outside electron — keep defaults */ }
    function saveUiState(patch) {
      try { ipcRenderer.send('save-ui-state', patch); } catch (e) {}
    }
```

- [ ] **Step 2: Apply the persisted group collapse state on init**

Find the existing `function toggleSidebarGroup(name)` block (around line 1022). Just BEFORE that function, add an init helper that applies the persisted state to the four groups:

```js
    function applyPersistedGroups() {
      ['race', 'car', 'track', 'stream'].forEach(name => {
        const group = document.getElementById('group-' + name);
        const label = group?.previousElementSibling;
        if (!group || !label) return;
        const collapsed = uiState.uiSidebarGroups && uiState.uiSidebarGroups[name] !== false;
        group.classList.toggle('collapsed', collapsed);
        label.innerHTML = (collapsed ? '\u25B6 ' : '\u25BC ') + name.charAt(0).toUpperCase() + name.slice(1);
      });
    }
    applyPersistedGroups();
```

- [ ] **Step 3: Make `toggleSidebarGroup` write to state**

Find the existing `toggleSidebarGroup` function and replace its body so the state save happens after every toggle:

```js
    function toggleSidebarGroup(name) {
      const group = document.getElementById('group-' + name);
      const label = group?.previousElementSibling;
      if (!group) return;
      group.classList.toggle('collapsed');
      const collapsed = group.classList.contains('collapsed');
      if (label) label.innerHTML = (collapsed ? '\u25B6 ' : '\u25BC ') + name.charAt(0).toUpperCase() + name.slice(1);
      // Persist
      if (!uiState.uiSidebarGroups) uiState.uiSidebarGroups = {};
      uiState.uiSidebarGroups[name] = collapsed;
      saveUiState({ uiSidebarGroups: uiState.uiSidebarGroups });
    }
```

- [ ] **Step 4: Manual smoke**

Run Bridge (`cd bridge && npm start` from the worktree). Open the control panel. Click the `Race` group label — it should expand. Close Bridge. Reopen Bridge. The `Race` group should still be expanded; the others still collapsed.

- [ ] **Step 5: Commit**

```bash
git add bridge/control-panel.html
git commit -m "feat(bridge): persist sidebar group collapse state across restarts"
```

---

## Task 5: control-panel.html — shared `renderOverlayCard()` helper + CSS

**Files:**
- Modify: `bridge/control-panel.html`

This task adds the renderer function that produces an HTML string for a single overlay card. It does NOT use the function yet — Tasks 6, 7, 8 wire it into Overview, Favorites, Recent.

- [ ] **Step 1: Add CSS for the new card layout**

Find the existing `.overview-card` rule (around line 94) and APPEND the following new rules after it (do not modify the existing `.overview-card` rule yet — Task 6 will replace its consumers):

```css
    /* ─── Shared overlay card (Overview / Favorites / Recent) ─ */
    .ov-card {
      background: #141520;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px;
      padding: 11px 13px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      transition: border-color 0.15s;
    }
    .ov-card:hover { border-color: rgba(145,70,255,0.3); }
    .ov-card-left {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      flex: 1;
    }
    .ov-card-icon { font-size: 17px; flex-shrink: 0; }
    .ov-card-name {
      font-size: 11px;
      font-weight: 600;
      color: #e8e6f0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ov-card-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .ov-card-btn {
      width: 26px;
      height: 26px;
      border-radius: 5px;
      background: rgba(255,255,255,0.04);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #8b8a9e;
      font-size: 13px;
      cursor: pointer;
      transition: all 0.15s;
      border: none;
      padding: 0;
      font-family: inherit;
    }
    .ov-card-btn:hover { background: rgba(145,70,255,0.18); color: #c0bfd0; }
    .ov-card-btn.gear:hover { color: #9146ff; }
    .ov-card-btn.star { color: #3a3a4e; font-size: 14px; }
    .ov-card-btn.star.filled { color: #f7c948; }
    .ov-card-coming-soon {
      font-size: 9px;
      color: #f79009;
      background: rgba(247,144,9,0.15);
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: 600;
      margin-left: 2px;
    }
    .ov-empty {
      text-align: center;
      padding: 40px 20px;
      color: #5c5b6e;
      font-size: 12px;
      background: #141520;
      border: 1px dashed rgba(255,255,255,0.06);
      border-radius: 8px;
    }
```

- [ ] **Step 2: Add the `renderOverlayCard()` helper**

Find the existing `function buildOverviewGrid()` block (around line 1051). Just BEFORE that function, add:

```js
    // ─── Shared overlay card renderer (Overview / Favorites / Recent) ─
    function renderOverlayCard(ov) {
      const isProximity = ov.id === 'proximity';
      const fav = uiState.uiFavorites && uiState.uiFavorites.indexOf(ov.id) !== -1;
      return `
        <div class="ov-card" data-overlay-id="${ov.id}">
          <div class="ov-card-left">
            <span class="ov-card-icon">${ov.icon}</span>
            <span class="ov-card-name">${ov.name}</span>
            ${isProximity ? '<span class="ov-card-coming-soon">Coming Soon</span>' : ''}
          </div>
          <div class="ov-card-actions">
            <label class="toggle">
              <input type="checkbox" id="toggle-${ov.id}" ${isProximity ? 'disabled' : ''} onclick="event.stopPropagation()" onchange="toggleOverlay('${ov.id}', this.checked)">
              <span class="slider"></span>
            </label>
            <button class="ov-card-btn gear" title="Open settings" onclick="event.stopPropagation(); navigateTo('${ov.id}');">⚙</button>
            <button class="ov-card-btn star ${fav ? 'filled' : ''}" title="${fav ? 'Remove from favorites' : 'Add to favorites'}" onclick="event.stopPropagation(); toggleFavorite('${ov.id}');">${fav ? '★' : '☆'}</button>
          </div>
        </div>
      `;
    }
```

- [ ] **Step 3: Syntax sanity**

Run:
```
node -e "const fs=require('fs'); const html=fs.readFileSync('bridge/control-panel.html','utf8'); console.log('renderOverlayCard:', /function renderOverlayCard/.test(html)); console.log('ov-card css:', /\.ov-card \{/.test(html));"
```

Expected: both `true`.

- [ ] **Step 4: Commit**

```bash
git add bridge/control-panel.html
git commit -m "feat(bridge): shared overlay card component (icon + toggle + gear + star)"
```

---

## Task 6: control-panel.html — Overview page upgrade

**Files:**
- Modify: `bridge/control-panel.html`

- [ ] **Step 1: Replace `buildOverviewGrid()`**

Find the existing `function buildOverviewGrid()` (around line 1051) and replace its entire body so it uses the new shared renderer:

```js
    // ─── Overview Grid ───────────────────────────────────────
    function buildOverviewGrid() {
      const grid = document.getElementById('overview-grid');
      if (!grid) return;
      grid.innerHTML = overlays.map(renderOverlayCard).join('');
    }
    buildOverviewGrid();
```

- [ ] **Step 2: Update `toggleOverlay` to leave star icons alone**

Find the existing `toggleOverlay` function (around line 1075). The current code does `document.getElementById('toggle-' + id)` and `document.getElementById('settings-toggle-' + id)` to keep both checkboxes in sync. Leave it AS-IS — the new card uses the same `toggle-${ov.id}` id, so the existing sync logic still works.

No change needed in this step. Skip to Step 3.

- [ ] **Step 3: Manual smoke**

Run Bridge from the worktree. Open the control panel → Overview tab. Verify:
- All overlays still appear in a 2-column grid.
- Each card now has the toggle PLUS a ⚙ gear button PLUS a ☆ star button.
- Clicking a toggle still enables/disables the overlay.
- Clicking the gear navigates to that overlay's settings panel (existing behavior — `navigateTo` already works).
- Clicking the star does nothing yet (Task 9 wires it up).

- [ ] **Step 4: Commit**

```bash
git add bridge/control-panel.html
git commit -m "feat(bridge): Overview page uses shared overlay card component"
```

---

## Task 7: control-panel.html — Favorites page

**Files:**
- Modify: `bridge/control-panel.html`

- [ ] **Step 1: Add `renderFavoritesPage()`**

Just AFTER the new `buildOverviewGrid()` definition (Task 6), add:

```js
    // ─── Favorites page ──────────────────────────────────────
    function renderFavoritesPage() {
      const panel = document.getElementById('panel-favorites');
      if (!panel) return;
      const favIds = (uiState.uiFavorites || []).filter(id => overlays.find(o => o.id === id));
      if (favIds.length === 0) {
        panel.innerHTML = `
          <div style="display:flex;align-items:center;gap:10px;font-size:16px;font-weight:700;color:#e8e6f0;margin-bottom:6px;">
            <span style="color:#f7c948;font-size:18px;">★</span> Favorites
          </div>
          <div style="font-size:11px;color:#5c5b6e;margin-bottom:18px;">Quick access to your starred overlays. Click ⚙ to open that overlay's settings.</div>
          <div class="ov-empty">No favorites yet — star any overlay to add it here.</div>
        `;
        return;
      }
      const cards = favIds
        .map(id => overlays.find(o => o.id === id))
        .filter(Boolean)
        .map(renderOverlayCard)
        .join('');
      panel.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;font-size:16px;font-weight:700;color:#e8e6f0;margin-bottom:6px;">
          <span style="color:#f7c948;font-size:18px;">★</span> Favorites
        </div>
        <div style="font-size:11px;color:#5c5b6e;margin-bottom:18px;">Quick access to your starred overlays. Click ⚙ to open that overlay's settings.</div>
        <div class="overview-grid">${cards}</div>
      `;
    }
```

- [ ] **Step 2: Re-render Favorites whenever it becomes the active panel**

Find the existing `function navigateTo(panelId)` (around line 1030). Inside the function body, AFTER the existing localStorage line (`localStorage.setItem('bridge_panel', panelId);`), add:

```js
      // Re-render dynamic pages
      if (panelId === 'favorites') renderFavoritesPage();
```

- [ ] **Step 3: Manual smoke**

Run Bridge. Open the control panel. Click the new `★ Favorites` sidebar entry. Verify:
- The panel-favorites content area shows the empty state: "No favorites yet — star any overlay to add it here."
- The header reads "★ Favorites" with the subtitle.

You won't be able to ADD favorites until Task 9. For now, just confirm the empty state renders.

- [ ] **Step 4: Commit**

```bash
git add bridge/control-panel.html
git commit -m "feat(bridge): Favorites page with empty state and shared cards"
```

---

## Task 8: control-panel.html — Recent page + pushRecent integration

**Files:**
- Modify: `bridge/control-panel.html`

- [ ] **Step 1: Require the sidebarState helpers**

Near the top of the `<script>` block, just BEFORE the `let uiState = ...` line you added in Task 4, add:

```js
    const { pushRecent: _pushRecentPure, toggleFavorite: _toggleFavoritePure, pruneStaleIds: _pruneStaleIds, isFavorite: _isFavorite } = require('./sidebarState');
```

- [ ] **Step 2: Add `renderRecentPage()`**

Just AFTER the `renderFavoritesPage()` definition from Task 7, add:

```js
    // ─── Recent page ─────────────────────────────────────────
    function renderRecentPage() {
      const panel = document.getElementById('panel-recent');
      if (!panel) return;
      const validIds = overlays.map(o => o.id);
      const recent = _pruneStaleIds(uiState.uiRecent || [], validIds);
      if (recent.length === 0) {
        panel.innerHTML = `
          <div style="display:flex;align-items:center;gap:10px;font-size:16px;font-weight:700;color:#e8e6f0;margin-bottom:6px;">
            <span style="color:#3ecf8e;font-size:18px;">🕒</span> Recent
          </div>
          <div style="font-size:11px;color:#5c5b6e;margin-bottom:18px;">Last 5 overlays you opened.</div>
          <div class="ov-empty">Nothing here yet — open an overlay's settings to start tracking.</div>
        `;
        return;
      }
      const cards = recent
        .map(id => overlays.find(o => o.id === id))
        .filter(Boolean)
        .map(renderOverlayCard)
        .join('');
      panel.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;font-size:16px;font-weight:700;color:#e8e6f0;margin-bottom:6px;">
          <span style="color:#3ecf8e;font-size:18px;">🕒</span> Recent
        </div>
        <div style="font-size:11px;color:#5c5b6e;margin-bottom:18px;">Last 5 overlays you opened.</div>
        <div class="overview-grid">${cards}</div>
      `;
    }
```

- [ ] **Step 3: Wire `pushRecent` into `navigateTo`**

In the existing `navigateTo(panelId)` function, immediately after the `if (panelId === 'favorites') renderFavoritesPage();` line you added in Task 7, add:

```js
      if (panelId === 'recent') renderRecentPage();
      // Track overlay panels in Recent (skip utility pages and dynamic pages)
      const RECENT_EXCLUDE = new Set(['overview', 'favorites', 'recent', 'account', 'updates', 'logs', 'about']);
      if (!RECENT_EXCLUDE.has(panelId) && overlays.find(o => o.id === panelId)) {
        uiState.uiRecent = _pushRecentPure(uiState.uiRecent || [], panelId);
        saveUiState({ uiRecent: uiState.uiRecent });
      }
```

- [ ] **Step 4: Manual smoke**

Run Bridge. Open the control panel. Click `Race` to expand → click `Standings` → click `Race` → click `Fuel` → click `Race` → click `Weather` → click the `🕒 Recent` sidebar entry. Verify:
- Recent page shows 3 cards in this order: Weather, Fuel, Standings (most-recent first).
- Cards have the toggle + gear + star.

Close Bridge. Reopen Bridge. Navigate to Recent. Verify the same 3 cards still appear (state persisted across restart).

- [ ] **Step 5: Commit**

```bash
git add bridge/control-panel.html
git commit -m "feat(bridge): Recent page with pushRecent tracking on overlay navigation"
```

---

## Task 9: control-panel.html — `toggleFavorite()` + star sync across pages

**Files:**
- Modify: `bridge/control-panel.html`

- [ ] **Step 1: Add the `toggleFavorite()` function**

Just AFTER `renderRecentPage()` from Task 8, add:

```js
    // ─── Toggle favorite (called from card star buttons) ─────
    function toggleFavorite(overlayId) {
      uiState.uiFavorites = _toggleFavoritePure(uiState.uiFavorites || [], overlayId);
      saveUiState({ uiFavorites: uiState.uiFavorites });
      // Re-render every page that shows cards so star icons stay in sync
      buildOverviewGrid();
      renderFavoritesPage();
      renderRecentPage();
    }
    window.toggleFavorite = toggleFavorite;
```

(The `window.toggleFavorite = toggleFavorite;` line is required because the inline `onclick="toggleFavorite(...)"` in `renderOverlayCard` needs the function on the global scope when invoked from a string template.)

- [ ] **Step 2: Manual smoke — round trip**

Run Bridge. Open Overview. Click the ☆ star on Standings — it should fill (★) and turn amber. Navigate to Favorites — Standings should appear there with a filled star. Click ★ on the Favorites card — it should disappear from Favorites, the empty state should reappear, and the star on the Overview Standings card should empty back to ☆.

Test from Recent: visit a few overlays so they appear in Recent → Recent → click ☆ on one of them → it appears in Favorites → click ★ in Favorites → it disappears from Favorites but stays in Recent (Recent is not affected by favorite state).

- [ ] **Step 3: Commit**

```bash
git add bridge/control-panel.html
git commit -m "feat(bridge): toggleFavorite + star sync across Overview/Favorites/Recent"
```

---

## Task 10: control-panel.html — search filter + Escape + ⌘K hotkey

**Files:**
- Modify: `bridge/control-panel.html`

- [ ] **Step 1: Add `applySearchFilter()`**

Just AFTER `toggleFavorite` from Task 9, add:

```js
    // ─── Sidebar search filter ──────────────────────────────
    function applySearchFilter(rawQuery) {
      const query = (rawQuery || '').trim().toLowerCase();
      const emptyEl = document.getElementById('sidebar-search-empty');
      const groupNames = ['race', 'car', 'track', 'stream'];

      if (!query) {
        // Restore: clear all dim/hidden, restore each group to its persisted collapse state
        document.querySelectorAll('.sidebar-item').forEach(el => {
          el.classList.remove('search-dim', 'search-hidden');
        });
        document.querySelectorAll('.sidebar-group-label').forEach(el => {
          el.classList.remove('search-hidden');
        });
        groupNames.forEach(name => {
          const group = document.getElementById('group-' + name);
          if (!group) return;
          const collapsed = uiState.uiSidebarGroups && uiState.uiSidebarGroups[name] !== false;
          group.classList.toggle('collapsed', collapsed);
        });
        if (emptyEl) emptyEl.style.display = 'none';
        return;
      }

      // Build the set of overlay ids that match the query (by name OR id)
      const matches = new Set(
        overlays
          .filter(o => o.name.toLowerCase().includes(query) || o.id.toLowerCase().includes(query))
          .map(o => o.id)
      );

      // Apply per-group: expand groups with at least one match, hide groups with zero
      let totalMatches = 0;
      groupNames.forEach(name => {
        const group = document.getElementById('group-' + name);
        const label = group?.previousElementSibling;
        if (!group || !label) return;
        const items = group.querySelectorAll('.sidebar-item');
        let groupMatches = 0;
        items.forEach(item => {
          const id = item.dataset.panel;
          if (matches.has(id)) {
            item.classList.remove('search-dim', 'search-hidden');
            groupMatches += 1;
          } else {
            item.classList.add('search-hidden');
            item.classList.remove('search-dim');
          }
        });
        totalMatches += groupMatches;
        if (groupMatches > 0) {
          group.classList.remove('collapsed');
          label.classList.remove('search-hidden');
        } else {
          label.classList.add('search-hidden');
          group.classList.add('collapsed');
        }
      });

      if (emptyEl) {
        if (totalMatches === 0) {
          emptyEl.textContent = `No overlays match "${rawQuery}"`;
          emptyEl.style.display = '';
        } else {
          emptyEl.style.display = 'none';
        }
      }
    }
```

- [ ] **Step 2: Wire the input + Escape handlers**

At the bottom of the existing `<script>` block (just before the closing `</script>` tag), add:

```js
    // Search field interactions
    (function () {
      const input = document.getElementById('sidebar-search');
      if (!input) return;
      input.addEventListener('input', (e) => applySearchFilter(e.target.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          if (input.value !== '') {
            input.value = '';
            applySearchFilter('');
          } else {
            input.blur();
          }
          e.preventDefault();
        }
      });
    })();
```

- [ ] **Step 3: Add the ⌘K / Ctrl+K global hotkey**

Just AFTER the search-field IIFE from Step 2, add:

```js
    // Global ⌘K / Ctrl+K → focus the sidebar search field
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        const input = document.getElementById('sidebar-search');
        if (input) {
          input.focus();
          input.select();
          e.preventDefault();
        }
      }
    });
```

- [ ] **Step 4: Manual smoke**

Run Bridge. Open the control panel. Click the search field and type `fuel` — every overlay row except Fuel should be hidden, the Car group label should be visible (containing the match), and Fuel should appear in the filtered list. Clear the search (or hit Escape) — every group should collapse back to its persisted state. Press `⌘K` (macOS) or `Ctrl+K` (Windows/Linux) from outside the search field — it should focus the search input.

Type `xyznotreal` — should show "No overlays match \"xyznotreal\"" inline below the input.

- [ ] **Step 5: Commit**

```bash
git add bridge/control-panel.html
git commit -m "feat(bridge): sidebar search filter + Escape clear + ⌘K hotkey"
```

---

## Task 11: Bridge version bump + final manual smoke + push release

**Files:**
- Modify: `bridge/package.json`

- [ ] **Step 1: Bump the version**

In `bridge/package.json`, change:

```json
  "version": "3.23.2",
```

to:

```json
  "version": "3.24.0",
```

(If the current version on main is something other than 3.23.2 by the time you start, bump from whatever it is to 3.24.0.)

- [ ] **Step 2: Run the unit tests one final time**

```
cd bridge && node --test test-sidebarState.js test-incidentTracker.js
```

Expected: 15 (sidebarState) + 29 (incidentTracker) = 44 tests pass.

- [ ] **Step 3: Final manual smoke checklist**

Run Bridge. Walk through every acceptance criterion from the spec:

- [ ] Sidebar fits the 1000×750 control panel without scrolling on first launch.
- [ ] All four categorized groups (Race, Car, Track, Stream) start collapsed.
- [ ] Type in the search field — non-matching rows hide, matching groups auto-expand.
- [ ] Clear the search — groups restore to their persisted state.
- [ ] ⌘K / Ctrl+K focuses the search field.
- [ ] Click `★ Favorites` in the sidebar — empty state shows.
- [ ] Click `🕒 Recent` in the sidebar — empty state shows.
- [ ] Click Overview — every overlay card shows toggle + gear + star.
- [ ] Click ⚙ on a card — navigates to that overlay's settings panel.
- [ ] Click ☆ on a card — fills to ★, the overlay appears in Favorites.
- [ ] Click ★ in Favorites — removes from Favorites, the Overview card star unfills.
- [ ] Click toggle on a card — flips the overlay window without navigating.
- [ ] Visit a few overlay panels — they appear in Recent in most-recent-first order.
- [ ] Visit Account / Updates / Logs / About — they do NOT appear in Recent.
- [ ] Toggle a sidebar group, restart Bridge — group collapse state survives.
- [ ] Star a few overlays, restart Bridge — favorites survive.
- [ ] Visit overlays, restart Bridge — recent list survives.
- [ ] First-launch user (delete `~/Documents/Atleta Bridge/settings.json` and restart) sees: empty Favorites, empty Recent, all groups collapsed, no errors.

- [ ] **Step 4: Commit the version bump**

```bash
git add bridge/package.json
git commit -m "v3.24.0: Bridge sidebar redesign — search + favorites + recent grid pages"
```

- [ ] **Step 5: Merge feature branch back to main and push**

If you're on a worktree with a feature branch, merge to main:

```bash
cd /Users/ricardosilva/vilela-notifications  # main worktree
git merge --no-ff feature/sidebar-redesign -m "merge: v3.24.0 Bridge sidebar redesign"
git push origin main
```

If you implemented directly on main, just `git push origin main`.

- [ ] **Step 6: Verify the GitHub Actions build kicks off**

```bash
gh run list --workflow=build-bridge.yml --limit 1
```

Expected: a new run for `v3.24.0` is `in_progress` or `completed`.

- [ ] **Step 7: Clean up worktree (if used)**

```bash
git worktree remove .worktrees/sidebar-redesign
git branch -d feature/sidebar-redesign
```

---

## Acceptance criteria

After all 11 tasks are complete:

- [ ] `cd bridge && node --test test-sidebarState.js` → 15 passing
- [ ] `cd bridge && node --test test-incidentTracker.js` → 29 passing (no regressions)
- [ ] Bridge launches without console errors
- [ ] Sidebar fits the 1000×750 control panel without scrolling on first launch
- [ ] Search field filters overlays live; ⌘K focuses; Escape clears
- [ ] Favorites page shows starred overlay cards or the empty state
- [ ] Recent page shows up to 5 most-recent overlays or the empty state
- [ ] Overview page uses the new shared card layout
- [ ] ⚙ gear opens individual overlay settings panel
- [ ] ★ star toggles favorite status, syncs across all three pages
- [ ] Toggle on a card flips overlay window on/off without navigating
- [ ] Visiting Account/Updates/Logs/About does NOT update Recent
- [ ] Group collapse state persists across Bridge restarts
- [ ] Favorites + Recent persist across Bridge restarts
- [ ] First-launch user sees clean empty state with no errors
- [ ] GitHub Actions build for `v3.24.0` published successfully
- [ ] Bridge version is `3.24.0`

---

## Self-review notes

Reviewed against the spec at `docs/superpowers/specs/2026-04-12-bridge-sidebar-redesign.md`:

- ✅ Search field, Favorites/Recent sidebar entries, content panels — Task 3
- ✅ Group collapse default + persistence — Tasks 3 + 4
- ✅ Search behavior (live filter, dim non-matching, auto-expand, no-results message) — Task 10
- ✅ ⌘K/Ctrl+K hotkey — Task 10
- ✅ Escape behavior — Task 10
- ✅ Card component with icon + name + toggle + gear + star — Task 5
- ✅ Card body click is non-interactive (no `onclick` on `.ov-card` itself) — Task 5
- ✅ Star sync across pages — Task 9
- ✅ Overview upgrade to shared card — Task 6
- ✅ Favorites page + empty state — Task 7
- ✅ Recent page + empty state — Task 8
- ✅ pushRecent excludes utility pages — Task 8
- ✅ uiFavorites / uiRecent / uiSidebarGroups defaults applied on load — Task 2
- ✅ get-ui-state / save-ui-state IPC — Task 2
- ✅ pruneStaleIds for stale overlay ids — Task 1 (helper) + Task 8 (used in renderRecentPage)
- ✅ Bridge version bump to 3.24.0 — Task 11
- ✅ Manual smoke checklist covers every acceptance criterion — Task 11

Type/method consistency:
- `pushRecent`, `toggleFavorite`, `pruneStaleIds`, `isFavorite` — identical signatures everywhere
- `uiState` shape `{ uiFavorites, uiRecent, uiSidebarGroups }` — identical at IPC, init, save, and read
- Sidebar group keys (`race`, `car`, `track`, `stream`) — identical in HTML, IPC defaults, applyPersistedGroups, toggleSidebarGroup, applySearchFilter
- IPC channel names (`get-ui-state`, `save-ui-state`) — identical in main.js handlers and renderer calls
- Card field ids (`toggle-${ov.id}`) — identical to existing convention so the existing `toggleOverlay` sync logic still works

Out-of-scope items confirmed not in plan: drag-to-reorder favorites, search across descriptions/tags, keyboard arrow nav in results, time-bucketed Recent, auto-pinning by frequency, sidebar collapse-to-icons mode, Race/Car/Track/Stream taxonomy changes.
