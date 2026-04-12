# Team Broadcasting Sidebar Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Bridge Team Broadcasting section out of the Overview content panel into a dedicated `📡 Broadcasting` sidebar tab with a card-grid layout that re-renders on every visit.

**Architecture:** Single-file change inside `bridge/control-panel.html`. New sidebar entry + content panel + `renderBroadcastPage()` function + `toggleTeamBroadcast()` global. Reuses the existing `get-pitwall-teams` / `set-pitwall-broadcast` / `pitwall-teams` IPC channels (no main.js or pitwallUplink.js changes). The page is wired into `navigateTo('broadcast')` so it re-fetches state every visit, fixing the perceived staleness bug. Old Overview Team Broadcasting markup + JS is removed in a dedicated cleanup task so each task leaves the feature in a working state.

**Tech Stack:** Vanilla HTML/CSS/JS in `bridge/control-panel.html`. Electron 28 IPC. No new dependencies, no test infrastructure changes (no automated tests for the control-panel renderer).

**Spec:** `docs/superpowers/specs/2026-04-12-team-broadcasting-tab.md`

---

## File Structure

| Path | Action | Purpose |
|---|---|---|
| `bridge/control-panel.html` | **Modify** | All four tasks edit this file. T1 adds CSS. T2 adds the sidebar entry, content panel, renderer functions, and navigateTo wiring (parallel to the old code, both working). T3 removes the old Overview Team Broadcasting markup + JS. |
| `bridge/package.json` | **Modify** | T4 bumps `3.24.x` → `3.25.0`. |
| `bridge/main.js` | **No change** | Existing IPC handlers reused as-is. |
| `bridge/pitwallUplink.js` | **No change** | Existing persistence + cache reused as-is. |

---

## Task 1: CSS additions for the new tab

**Files:**
- Modify: `bridge/control-panel.html`

This task only appends CSS. No markup or JS changes. Pure additive — the new rules are namespaced (`.tb-*`) and don't override anything existing.

- [ ] **Step 1: Find the existing `.ov-empty` rule from v3.24.0**

Grep for it to confirm the location:

```
grep -n "\.ov-empty {" /Users/ricardosilva/vilela-notifications/.worktrees/team-broadcast/bridge/control-panel.html
```

Expected: one match inside the `<style>` block.

- [ ] **Step 2: Append the new CSS rules immediately after the `.ov-empty` rule**

Find the closing `}` of the `.ov-empty` rule and insert right after it:

```css
    /* ─── Team Broadcasting (📡 Broadcasting tab) ─────────── */
    .tb-status {
      display: flex;
      align-items: center;
      gap: 8px;
      background: #141520;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px;
      padding: 10px 14px;
      margin-bottom: 14px;
      font-size: 11px;
      color: #8b8a9e;
    }
    .tb-status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #3ecf8e;
      box-shadow: 0 0 6px rgba(62,207,142,0.5);
      flex-shrink: 0;
    }
    .tb-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .tb-card {
      background: #141520;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px;
      padding: 12px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      transition: border-color 0.15s;
    }
    .tb-card:hover { border-color: rgba(62,207,142,0.3); }
    .tb-card.live { border-color: rgba(62,207,142,0.4); }
    .tb-card-left {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      flex: 1;
    }
    .tb-card-icon {
      width: 32px;
      height: 32px;
      border-radius: 6px;
      background: rgba(62,207,142,0.12);
      color: #3ecf8e;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      flex-shrink: 0;
    }
    .tb-card-info {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .tb-card-name {
      font-size: 12px;
      font-weight: 700;
      color: #e8e6f0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tb-card-status {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #5c5b6e;
      font-weight: 600;
    }
    .tb-card.live .tb-card-status { color: #3ecf8e; }
    .tb-toggle {
      width: 36px;
      height: 20px;
      background: #1a1b2e;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 20px;
      position: relative;
      flex-shrink: 0;
      cursor: pointer;
      transition: all 0.2s;
    }
    .tb-toggle::after {
      content: '';
      position: absolute;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #fff;
      top: 2px;
      left: 2px;
      transition: 0.2s;
    }
    .tb-toggle.on { background: #3ecf8e; border-color: #3ecf8e; }
    .tb-toggle.on::after { left: 18px; }
```

- [ ] **Step 3: Sanity check**

Run:
```
node -e "const fs=require('fs'); const html=fs.readFileSync('/Users/ricardosilva/vilela-notifications/.worktrees/team-broadcast/bridge/control-panel.html','utf8'); ['\\.tb-status \\{','\\.tb-grid \\{','\\.tb-card \\{','\\.tb-card-icon','\\.tb-toggle\\.on'].forEach(s => console.log(s+':', new RegExp(s).test(html)));"
```

Expected: all five checks print `true`.

Also confirm the script still parses:
```
node -e "const fs=require('fs'); const html=fs.readFileSync('/Users/ricardosilva/vilela-notifications/.worktrees/team-broadcast/bridge/control-panel.html','utf8'); const m = html.match(/<script>([\s\S]*?)<\/script>/); try { new Function(m[1]); console.log('script parses ok'); } catch(e) { console.error('PARSE ERROR:', e.message); process.exit(1); }"
```

Expected: `script parses ok`.

- [ ] **Step 4: Commit**

```bash
git add bridge/control-panel.html
git commit -m "feat(bridge): CSS for team broadcasting card grid + toggle"
```

---

## Task 2: Add sidebar entry, content panel, renderer functions, navigateTo wiring

**Files:**
- Modify: `bridge/control-panel.html`

This task adds the new tab in PARALLEL with the existing Overview section. The old Team Broadcasting code keeps working until Task 3 cleans it up. After this task, both UIs render simultaneously — the user can see the new tab AND the old section. That's intentional so each commit leaves the feature working.

- [ ] **Step 1: Add the `📡 Broadcasting` sidebar entry**

Find the existing Recent sidebar entry (added in v3.24.0):

```html
      <div class="sidebar-item" data-panel="recent" onclick="navigateTo('recent')">
        <span class="sidebar-icon" style="color:#3ecf8e;">&#128340;</span> Recent
      </div>
      <div class="sidebar-divider"></div>
```

Replace with:

```html
      <div class="sidebar-item" data-panel="recent" onclick="navigateTo('recent')">
        <span class="sidebar-icon" style="color:#3ecf8e;">&#128340;</span> Recent
      </div>
      <div class="sidebar-item" data-panel="broadcast" onclick="navigateTo('broadcast')">
        <span class="sidebar-icon" style="color:#3ecf8e;">&#128225;</span> Broadcasting
      </div>
      <div class="sidebar-divider"></div>
```

(`&#128225;` is the 📡 satellite-antenna glyph U+1F4E1.)

- [ ] **Step 2: Add the new content panel div**

Find the existing `panel-recent` content panel div (added in v3.24.0):

```html
      <!-- ═══ RECENT PANEL ═══ -->
      <div class="content-panel" id="panel-recent"></div>
```

Insert immediately after it:

```html

      <!-- ═══ BROADCASTING PANEL ═══ -->
      <div class="content-panel" id="panel-broadcast"></div>
```

- [ ] **Step 3: Add the `renderBroadcastPage()` function**

Find the existing `renderRecentPage()` function (added in v3.24.0). Just AFTER its closing `}` and before `function toggleFavorite`, add:

```js
    // ─── Broadcasting page ───────────────────────────────────
    function renderBroadcastPage() {
      const panel = document.getElementById('panel-broadcast');
      if (!panel) return;
      let state;
      try { state = ipcRenderer.sendSync('get-pitwall-teams'); }
      catch (e) { state = { status: 'disabled', teams: [], broadcastIds: [] }; }

      const header = `
        <div style="display:flex;align-items:center;gap:10px;font-size:16px;font-weight:700;color:#e8e6f0;margin-bottom:6px;">
          <span style="color:#3ecf8e;font-size:18px;">📡</span> Team Broadcasting
        </div>
        <div style="font-size:11px;color:#5c5b6e;margin-bottom:18px;">Toggle which teams can see your live telemetry on Pitwall. Settings persist across restarts.</div>
      `;

      if (state.status === 'disabled') {
        panel.innerHTML = header + '<div class="ov-empty">Pitwall not configured — log out and log back in to enable team broadcasting.</div>';
        return;
      }

      const teams = Array.isArray(state.teams) ? state.teams : [];
      const broadcastSet = new Set(state.broadcastIds || []);
      const isConnected = state.status === 'connected';
      const dotColor = isConnected ? '#3ecf8e' : '#f79009';
      let statusText;
      if (teams.length === 0) {
        statusText = isConnected ? 'Connected to Pitwall · 0 teams' : 'Connecting to Pitwall…';
      } else {
        statusText = isConnected
          ? `Connected to Pitwall · ${teams.length} team${teams.length === 1 ? '' : 's'} · ${broadcastSet.size} broadcasting`
          : 'Reconnecting to Pitwall…';
      }

      const statusBar = `
        <div class="tb-status">
          <div class="tb-status-dot" style="background:${dotColor};box-shadow:0 0 6px ${dotColor}80;"></div>
          <span>${statusText}</span>
        </div>
      `;

      if (teams.length === 0) {
        if (isConnected) {
          panel.innerHTML = header + statusBar + '<div class="ov-empty">You\'re not in any teams yet — join one at <a href="#" id="tb-join-link" style="color:#3ecf8e;">atletanotifications.com/racing/teams</a></div>';
          const link = document.getElementById('tb-join-link');
          if (link) {
            link.addEventListener('click', (e) => {
              e.preventDefault();
              try { require('electron').shell.openExternal('https://atletanotifications.com/racing/teams'); } catch (err) {}
            });
          }
        } else {
          panel.innerHTML = header + statusBar + '<div class="ov-empty" style="font-style:italic;color:#5c5b6e;">Loading…</div>';
        }
        return;
      }

      const escapeName = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const cards = teams.map(t => {
        const on = broadcastSet.has(t.id);
        return `
          <div class="tb-card ${on ? 'live' : ''}">
            <div class="tb-card-left">
              <div class="tb-card-icon">📡</div>
              <div class="tb-card-info">
                <div class="tb-card-name">${escapeName(t.name)}</div>
                <div class="tb-card-status">${on ? '● Broadcasting' : 'Off'}</div>
              </div>
            </div>
            <div class="tb-toggle ${on ? 'on' : ''}" data-team-id="${t.id}" onclick="toggleTeamBroadcast(${t.id})"></div>
          </div>
        `;
      }).join('');

      panel.innerHTML = header + statusBar + `<div class="tb-grid">${cards}</div>`;
    }
```

- [ ] **Step 4: Add the `toggleTeamBroadcast()` function**

Just AFTER `renderBroadcastPage()`, add:

```js
    // ─── Toggle team broadcast (called from card toggle clicks) ─
    function toggleTeamBroadcast(teamId) {
      let state;
      try { state = ipcRenderer.sendSync('get-pitwall-teams'); }
      catch (e) { return; }
      const current = new Set(state.broadcastIds || []);
      if (current.has(teamId)) current.delete(teamId);
      else current.add(teamId);
      const newIds = Array.from(current);
      try { ipcRenderer.send('set-pitwall-broadcast', newIds); } catch (e) {}
      renderBroadcastPage();
    }
    window.toggleTeamBroadcast = toggleTeamBroadcast;
```

(`window.toggleTeamBroadcast = ...` is required because the inline `onclick="toggleTeamBroadcast(...)"` from the card template needs the function on the global scope.)

- [ ] **Step 5: Wire `renderBroadcastPage()` into `navigateTo`**

Find the existing block in `navigateTo()` from v3.24.0:

```js
      // Re-render dynamic pages
      if (panelId === 'favorites') renderFavoritesPage();
      if (panelId === 'recent') renderRecentPage();
```

Add a third line after `recent`:

```js
      // Re-render dynamic pages
      if (panelId === 'favorites') renderFavoritesPage();
      if (panelId === 'recent') renderRecentPage();
      if (panelId === 'broadcast') renderBroadcastPage();
```

- [ ] **Step 6: Sanity check**

Run all checks:

```
node -e "const fs=require('fs'); const html=fs.readFileSync('/Users/ricardosilva/vilela-notifications/.worktrees/team-broadcast/bridge/control-panel.html','utf8'); console.log('sidebar entry:', html.includes('data-panel=\"broadcast\"')); console.log('panel-broadcast div:', html.includes('id=\"panel-broadcast\"')); console.log('renderBroadcastPage:', /function renderBroadcastPage/.test(html)); console.log('toggleTeamBroadcast:', /function toggleTeamBroadcast/.test(html)); console.log('window.toggleTeamBroadcast:', /window\\.toggleTeamBroadcast/.test(html)); console.log('navigateTo wires broadcast:', /panelId === 'broadcast'.*renderBroadcastPage/.test(html));"
```

Expected: all six print `true`.

Plus the script-parse check:

```
node -e "const fs=require('fs'); const html=fs.readFileSync('/Users/ricardosilva/vilela-notifications/.worktrees/team-broadcast/bridge/control-panel.html','utf8'); const m = html.match(/<script>([\s\S]*?)<\/script>/); try { new Function(m[1]); console.log('script parses ok'); } catch(e) { console.error('PARSE ERROR:', e.message); process.exit(1); }"
```

Expected: `script parses ok`.

- [ ] **Step 7: Commit**

```bash
git add bridge/control-panel.html
git commit -m "feat(bridge): Broadcasting sidebar tab with card grid and re-render on navigate"
```

---

## Task 3: Remove the old Overview Team Broadcasting section + JS

**Files:**
- Modify: `bridge/control-panel.html`

Now that the new tab works, remove the dead code from the Overview panel and its accompanying once-on-init JS.

- [ ] **Step 1: Delete the markup block from `#panel-overview`**

Find this block (currently around line 518 inside `<div class="content-panel active" id="panel-overview">`):

```html
        <div class="section-header" style="margin-top:14px;">Team Broadcasting</div>
        <div id="team-broadcast-section" style="margin-bottom:8px;">
          <p style="font-size:11px;color:#5a5970;margin-bottom:8px;">Select which teams can see your telemetry on Pitwall:</p>
          <div id="team-broadcast-list" style="display:flex;flex-direction:column;gap:4px;">
            <p style="font-size:11px;color:#5a5970;font-style:italic;">Connecting...</p>
          </div>
        </div>
```

Delete it entirely.

- [ ] **Step 2: Delete the old `renderTeamBroadcast` function and its init code**

Find this block (currently around line 2290 inside the script):

```js
    // ── Team broadcast UI (via IPC to main process) ────────
    function renderTeamBroadcast(teams, broadcastIds) {
      const container = document.getElementById('team-broadcast-list');
      if (!container) return;
      if (!teams || teams.length === 0) {
        container.innerHTML = '<p style="font-size:11px;color:#5a5970;font-style:italic;">No teams — join a team at atletanotifications.com/racing/teams</p>';
        return;
      }
      const broadcastSet = new Set(broadcastIds || []);
      container.innerHTML = teams.map(function(t) {
        return '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#c4c3d4;cursor:pointer;padding:4px 0;">' +
          '<input type="checkbox" data-team-id="' + t.id + '" ' + (broadcastSet.has(t.id) ? 'checked' : '') + ' onchange="updateBroadcastTeams()" style="accent-color:#3ecf8e;">' +
          '<span>' + (t.name||'').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</span>' +
          (broadcastSet.has(t.id) ? '<span style="width:6px;height:6px;border-radius:50%;background:#3ecf8e;flex-shrink:0;"></span>' : '') +
        '</label>';
      }).join('');
    }

    // Get current state from main process
    var pitwallState = ipcRenderer.sendSync('get-pitwall-teams');
    if (pitwallState.status === 'disabled') {
      document.getElementById('team-broadcast-list').innerHTML = '<p style="font-size:11px;color:#5a5970;font-style:italic;">Not configured — log out and log back in</p>';
    } else if (pitwallState.teams && pitwallState.teams.length > 0) {
      renderTeamBroadcast(pitwallState.teams, pitwallState.broadcastIds);
    }

    // Listen for updates from main process
    ipcRenderer.on('pitwall-teams', function(event, data) {
      renderTeamBroadcast(data.teams, data.broadcastIds);
    });

    window.updateBroadcastTeams = function() {
      const checks = document.querySelectorAll('#team-broadcast-list input[type=checkbox]');
      const ids = [];
      checks.forEach(function(cb) {
        if (cb.checked) ids.push(parseInt(cb.dataset.teamId));
      });
      ipcRenderer.send('set-pitwall-broadcast', ids);
    };
```

Replace it ENTIRELY with this single line that re-points the IPC listener at the new render function:

```js
    // Server-pushed updates re-render the new Broadcasting tab
    ipcRenderer.on('pitwall-teams', () => renderBroadcastPage());
```

- [ ] **Step 3: Sanity check**

Confirm the old identifiers are gone but the new ones remain:

```
node -e "const fs=require('fs'); const html=fs.readFileSync('/Users/ricardosilva/vilela-notifications/.worktrees/team-broadcast/bridge/control-panel.html','utf8'); console.log('old renderTeamBroadcast removed:', !/function renderTeamBroadcast/.test(html)); console.log('old updateBroadcastTeams removed:', !/window\\.updateBroadcastTeams/.test(html)); console.log('old team-broadcast-list removed:', !/id=\"team-broadcast-list\"/.test(html)); console.log('new renderBroadcastPage still present:', /function renderBroadcastPage/.test(html)); console.log('new pitwall listener present:', /ipcRenderer\\.on\\('pitwall-teams', \\(\\) => renderBroadcastPage\\(\\)\\)/.test(html));"
```

Expected: all five print `true`.

Plus the script-parse check:

```
node -e "const fs=require('fs'); const html=fs.readFileSync('/Users/ricardosilva/vilela-notifications/.worktrees/team-broadcast/bridge/control-panel.html','utf8'); const m = html.match(/<script>([\s\S]*?)<\/script>/); try { new Function(m[1]); console.log('script parses ok'); } catch(e) { console.error('PARSE ERROR:', e.message); process.exit(1); }"
```

Expected: `script parses ok`.

- [ ] **Step 4: Commit**

```bash
git add bridge/control-panel.html
git commit -m "refactor(bridge): remove old Team Broadcasting section from Overview panel"
```

---

## Task 4: Bridge version bump + final manual smoke + push release

**Files:**
- Modify: `bridge/package.json`

- [ ] **Step 1: Run the unit tests one final time**

```
cd /Users/ricardosilva/vilela-notifications/.worktrees/team-broadcast/bridge && node --test test-sidebarState.js test-incidentTracker.js
```

Expected: 43 tests pass total (15 sidebarState + 28 incidentTracker). No regressions.

- [ ] **Step 2: Bump the version in `bridge/package.json`**

Find:

```json
  "version": "3.24.0",
```

(If the current version is something else by the time you start — e.g. 3.24.1 — bump from whatever it is to 3.25.0.)

Change to:

```json
  "version": "3.25.0",
```

- [ ] **Step 3: Final manual smoke checklist**

Run Bridge from the worktree (`cd bridge && npm start`) and walk through each acceptance criterion from the spec:

- [ ] New `📡 Broadcasting` sidebar entry appears between Recent and the categorized accordions
- [ ] Clicking it navigates to a content page with header + status bar + cards
- [ ] When pitwall is connected and the user is in 1+ teams: cards render in a 2-column grid with team name + status label + toggle
- [ ] Cards with broadcasting on get the green border tint and `● Broadcasting` status
- [ ] Toggling a card immediately fires `set-pitwall-broadcast` and re-renders the page (the toggle slides + the green border + the status bar count update)
- [ ] Status bar accurately reports `N teams · M broadcasting`
- [ ] When pitwall is connected with 0 teams: empty state with clickable join URL that opens in the system browser
- [ ] When pitwall is disconnected with cached teams: cards still render, status bar shows amber + "Reconnecting…", toggling still queues for next connect
- [ ] When pitwall is disabled (no racing user): "Pitwall not configured" message
- [ ] Visiting Broadcasting → Race → Broadcasting renders fresh state (re-fetches via IPC every visit)
- [ ] Server-pushed `pitwall-teams` events re-render the page automatically
- [ ] Closing and reopening the control panel preserves toggle state
- [ ] Restarting Bridge preserves toggle state
- [ ] The old Overview Team Broadcasting section is gone (markup + init code removed)

If you can't run Bridge in this environment (no Windows + no iRacing), skip the smoke and rely on the script-parse + content checks from Tasks 1–3. The maintainer will verify on Windows.

- [ ] **Step 4: Commit the version bump**

```bash
git add bridge/package.json
git commit -m "v3.25.0: Bridge team broadcasting sidebar tab"
```

- [ ] **Step 5: Merge feature branch back to main and push**

If you're on a worktree with a feature branch, merge to main:

```bash
cd /Users/ricardosilva/vilela-notifications  # main worktree
git merge --no-ff feature/team-broadcast -m "merge: v3.25.0 Bridge team broadcasting sidebar tab"
git push origin main
```

If you implemented directly on main, just `git push origin main`.

- [ ] **Step 6: Verify the GitHub Actions build kicks off**

```bash
gh run list --workflow=build-bridge.yml --limit 1
```

Expected: a new run for `v3.25.0` is `in_progress` or `completed`.

- [ ] **Step 7: Clean up worktree (if used)**

```bash
git worktree remove .worktrees/team-broadcast
git branch -d feature/team-broadcast
```

---

## Acceptance criteria

After all 4 tasks are complete:

- [ ] `cd bridge && node --test test-sidebarState.js test-incidentTracker.js` → 43 passing (no regressions)
- [ ] Bridge launches without console errors
- [ ] `📡 Broadcasting` sidebar entry exists between Recent and the categorized accordions
- [ ] Card grid renders with toggle + name + status per team
- [ ] Live cards have green border tint and `● Broadcasting` status text
- [ ] Toggling a card persists immediately and re-renders the page
- [ ] Status bar shows connection state and broadcast count
- [ ] Empty / loading / disabled states work as documented
- [ ] navigateTo('broadcast') re-fetches state every visit
- [ ] Server-pushed pitwall-teams events re-render automatically
- [ ] Old Overview Team Broadcasting section is gone
- [ ] No regressions in Favorites/Recent/Overview/group collapse
- [ ] GitHub Actions build for `v3.25.0` published successfully
- [ ] Bridge version is `3.25.0`

---

## Self-review notes

Reviewed against the spec at `docs/superpowers/specs/2026-04-12-team-broadcasting-tab.md`:

- ✅ New `📡 Broadcasting` sidebar entry between Recent and the categorized accordions — Task 2, Step 1
- ✅ New `panel-broadcast` content panel — Task 2, Step 2
- ✅ Card grid layout with icon + name + status + toggle — Task 2, Step 3 (renderBroadcastPage)
- ✅ Live cards get green border tint via `.tb-card.live` — Task 1 CSS + Task 2 renderer
- ✅ Status bar with green/amber dot and count — Task 2, Step 3
- ✅ Re-render on every navigateTo('broadcast') — Task 2, Step 5
- ✅ toggleTeamBroadcast updates state, persists via IPC, re-renders — Task 2, Step 4
- ✅ Empty state (0 teams) with clickable join link via `electron.shell.openExternal` — Task 2, Step 3
- ✅ Loading state (disconnected, no cache) — Task 2, Step 3
- ✅ Reconnecting state (disconnected, cache present) — Task 2, Step 3
- ✅ Disabled state (no pitwall token) — Task 2, Step 3
- ✅ Existing pitwall-teams listener re-pointed at renderBroadcastPage — Task 3, Step 2
- ✅ Old Overview Team Broadcasting section removed — Task 3, Step 1
- ✅ Old renderTeamBroadcast / updateBroadcastTeams / pitwallState init removed — Task 3, Step 2
- ✅ Bridge version bumped to 3.25.0 — Task 4, Step 2
- ✅ Manual smoke checklist covers every acceptance criterion — Task 4, Step 3

Type/method consistency:
- `renderBroadcastPage` and `toggleTeamBroadcast` named consistently across Tasks 2, 3, and the navigateTo wiring
- IPC channel names (`get-pitwall-teams`, `set-pitwall-broadcast`, `pitwall-teams`) match what main.js already exposes — verified by reading bridge/main.js during exploration
- State shape `{ status, teams, broadcastIds }` matches what `ipcMain.on('get-pitwall-teams')` returns in main.js
- CSS class names (`.tb-card`, `.tb-card-icon`, `.tb-card-info`, `.tb-card-name`, `.tb-card-status`, `.tb-toggle`, `.tb-status`, `.tb-status-dot`, `.tb-grid`) are namespaced under `.tb-` and don't collide with any existing classes
- The `.ov-empty` class reused in empty/disabled states was added in v3.24.0 — verified present

Out-of-scope items confirmed not in plan: server-side changes, team picture/banner display, per-team throttle settings, drag-to-reorder, multi-select / select-all controls, master broadcast toggle.
