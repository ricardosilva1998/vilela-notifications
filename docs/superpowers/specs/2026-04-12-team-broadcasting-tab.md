# Team Broadcasting Sidebar Tab — Design Spec

**Date:** 2026-04-12
**Component:** `bridge/control-panel.html`
**Goal:** Move the existing Team Broadcasting section out of the Overview content panel into its own dedicated `📡 Broadcasting` sidebar tab, with one card per team and a re-render-on-navigate flow that fixes the perceived "I have to re-toggle every time" staleness bug.

## Problem

Today the Team Broadcasting section lives at the bottom of the Overview content panel as a flat list of checkboxes (`#team-broadcast-list`). It's only rendered once on script init via a synchronous `get-pitwall-teams` IPC call. If the user opens the control panel before `pitwallUplink` has finished its WebSocket auth handshake with the server, `availableTeams` is empty and the section renders as nothing — the user has to wait for the server to reply, see an empty section, navigate away, come back, and (since the renderer never re-runs on navigation) the cards still look stale until a `pitwall-teams` event happens to fire. Persistence on disk is correct, but the renderer doesn't reflect it on every visit.

The section is also visually buried inside Overview alongside the connection-status block, the overlay grid, the autohide toggle, and the Save/Reset buttons. It deserves its own home.

## Goals

1. New `📡 Broadcasting` sidebar entry (between `🕒 Recent` and the `Race` accordion) with its own content panel.
2. Card grid layout matching the Favorites/Recent pattern from v3.24.0 — one card per team.
3. Each card has icon + team name + status label + toggle. Live cards get a green border tint.
4. Status bar at the top of the page summarising connection state and active broadcasts.
5. Re-render the page on every `navigateTo('broadcast')` so toggles always show the latest persisted state — no more "I had to re-toggle".
6. Empty / loading / disabled states for: no teams, server disconnected, pitwall not configured.
7. Remove the section from the Overview panel (markup + init code).

## Non-goals (out of scope for v1)

- Server-side changes. The team payload from the WebSocket auth response is `{id, name}` only — no picture, no member count, no metadata — and we work with what's available.
- Per-team broadcasting settings (throttle rate, channel filter, etc.).
- Drag-to-reorder teams.
- Multi-select / select-all controls.
- Adding a "broadcast to all" master toggle.

## High-level design

Two changes inside `bridge/control-panel.html`:

1. **Sidebar markup** — add the new entry and a new empty content panel `#panel-broadcast`. Remove the old Team Broadcasting section from inside `#panel-overview`.
2. **Renderer logic** — add `renderBroadcastPage()` that pulls fresh state via `ipcRenderer.sendSync('get-pitwall-teams')` and renders the appropriate state (cards / empty / loading / disabled). Wire it into `navigateTo()` so every visit re-fetches. Repoint the existing `ipcRenderer.on('pitwall-teams', ...)` listener at the new function. Add new CSS for `.tb-card`, `.tb-card-icon`, `.tb-card-info`, `.tb-toggle`, `.tb-status`.

No changes to `bridge/main.js`, `bridge/pitwallUplink.js`, or the server. The existing `get-pitwall-teams` / `set-pitwall-broadcast` / `pitwall-teams` IPC channels are reused as-is.

## Sidebar layout (after this change)

```
┌─────────────────────────────┐
│ 🔎 Search overlays…        │
├─────────────────────────────┤
│ ⊞ Overview                  │
│ ★ Favorites                 │
│ 🕒 Recent                   │
│ 📡 Broadcasting             │  ← NEW
├─────────────────────────────┤
│ ▶ Race                      │
│ ▶ Car                       │
│ ▶ Track                     │
│ ▶ Stream                    │
│         (spacer)            │
├─────────────────────────────┤
│ 👤 Account                  │
│ 🔄 Updates                  │
│ 📄 Logs                     │
│ ⓘ About                     │
└─────────────────────────────┘
```

The new entry uses `data-panel="broadcast"`, sits between Recent and the divider that precedes the categorized accordions, and uses a `📡` icon coloured `#3ecf8e` to match the broadcasting accent.

## Content page layout

### Header
```
📡 Team Broadcasting
Toggle which teams can see your live telemetry on Pitwall. Settings persist across restarts.
```

### Status bar (shown when pitwall state is `connected` or `disconnected` with cached teams)
```
●  Connected to Pitwall · 4 teams · 2 broadcasting
```

- Green dot (`#3ecf8e`) when `connected`.
- Amber dot (`#f79009`) when `disconnected` (with cached teams visible).
- Status bar is hidden entirely when state is `disabled` (replaced by the disabled-state message — see below).

### Card grid

2-column CSS grid (`grid-template-columns: 1fr 1fr; gap: 10px`). One card per team in the order returned by `pitwallUplink.getAvailableTeams()`.

Card markup:

```html
<div class="tb-card [live]">
  <div class="tb-card-left">
    <div class="tb-card-icon">📡</div>
    <div class="tb-card-info">
      <div class="tb-card-name">Atleta Racing GT3</div>
      <div class="tb-card-status">● Broadcasting</div>  <!-- or "Off" -->
    </div>
  </div>
  <div class="tb-toggle [on]" data-team-id="3"></div>
</div>
```

- `.tb-card.live` gets a green border tint (`border-color: rgba(62,207,142,0.4)`).
- The toggle is a click target (not a real `<input>`); clicking it adds/removes `.on` immediately and fires `set-pitwall-broadcast` IPC with the new full set of broadcasting team ids.
- Card body is non-interactive — only the toggle responds.

### Empty / loading / disabled states

| Pitwall state | Teams cached? | Behavior |
|---|---|---|
| `disabled` (no `racingUserId` / `pitwallToken` in settings) | n/a | Show inline message in place of the status bar + grid: *"Pitwall not configured — log out and log back in to enable team broadcasting."* |
| `disconnected` | yes | Status bar shows amber dot + *"Reconnecting to Pitwall…"*. Grid renders normally. Toggling still works (sets local broadcastTeamIds; queues for next connect — already how `pitwallUplink.setBroadcastTeams` works). |
| `disconnected` | no | Status bar shows amber dot + *"Connecting to Pitwall…"*. Grid is replaced with a subtle skeleton (single-line dimmed `Loading…` message — no spinner). |
| `connected` | yes | Status bar shows green dot + *"Connected to Pitwall · N teams · M broadcasting"*. Grid renders normally. |
| `connected` | 0 teams | Status bar shows green dot + *"Connected to Pitwall · 0 teams"*. Empty state card replaces the grid: *"You're not in any teams yet — join one at atletanotifications.com/racing/teams"* with the URL as a clickable `<a>` opening externally via `electron.shell.openExternal`. |

State is decoded from the existing `get-pitwall-teams` IPC response which already returns `{ teams, broadcastIds, status }`.

## Renderer logic

A single new function `renderBroadcastPage()`:

```js
function renderBroadcastPage() {
  const panel = document.getElementById('panel-broadcast');
  if (!panel) return;
  let state;
  try { state = ipcRenderer.sendSync('get-pitwall-teams'); }
  catch (e) { state = { status: 'disabled', teams: [], broadcastIds: [] }; }

  const header = `
    <div class="br-content-h"><span class="icon" style="color:#3ecf8e;">📡</span> Team Broadcasting</div>
    <div class="br-content-sub">Toggle which teams can see your live telemetry on Pitwall. Settings persist across restarts.</div>
  `;

  if (state.status === 'disabled') {
    panel.innerHTML = header + '<div class="ov-empty">Pitwall not configured — log out and log back in to enable team broadcasting.</div>';
    return;
  }

  const teams = Array.isArray(state.teams) ? state.teams : [];
  const broadcastSet = new Set(state.broadcastIds || []);
  const dotColor = state.status === 'connected' ? '#3ecf8e' : '#f79009';
  const statusText = teams.length === 0
    ? (state.status === 'connected' ? 'Connected to Pitwall · 0 teams' : 'Connecting to Pitwall…')
    : (state.status === 'connected'
        ? `Connected to Pitwall · ${teams.length} team${teams.length === 1 ? '' : 's'} · ${broadcastSet.size} broadcasting`
        : `Reconnecting to Pitwall…`);

  const statusBar = `
    <div class="tb-status">
      <div class="tb-status-dot" style="background:${dotColor};box-shadow:0 0 6px ${dotColor}80;"></div>
      <span>${statusText}</span>
    </div>
  `;

  if (teams.length === 0) {
    if (state.status === 'connected') {
      panel.innerHTML = header + statusBar + '<div class="ov-empty">You\'re not in any teams yet — join one at <a href="#" id="tb-join-link" style="color:#3ecf8e;">atletanotifications.com/racing/teams</a></div>';
      const link = document.getElementById('tb-join-link');
      if (link) link.addEventListener('click', (e) => { e.preventDefault(); try { require('electron').shell.openExternal('https://atletanotifications.com/racing/teams'); } catch (err) {} });
    } else {
      panel.innerHTML = header + statusBar + '<div class="ov-empty" style="font-style:italic;color:#5c5b6e;">Loading…</div>';
    }
    return;
  }

  const cards = teams.map(t => {
    const on = broadcastSet.has(t.id);
    const safeName = (t.name || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `
      <div class="tb-card ${on ? 'live' : ''}">
        <div class="tb-card-left">
          <div class="tb-card-icon">📡</div>
          <div class="tb-card-info">
            <div class="tb-card-name">${safeName}</div>
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

A new `toggleTeamBroadcast(teamId)` function that:
1. Reads the current set of broadcasting ids from `uiState`-style cache (or by re-fetching `get-pitwall-teams`)
2. Toggles `teamId` in/out of the set
3. Calls `ipcRenderer.send('set-pitwall-broadcast', newIds)`
4. Re-renders the page so the green border + status update immediately

```js
window.toggleTeamBroadcast = function (teamId) {
  let state;
  try { state = ipcRenderer.sendSync('get-pitwall-teams'); } catch { return; }
  const current = new Set(state.broadcastIds || []);
  if (current.has(teamId)) current.delete(teamId);
  else current.add(teamId);
  const newIds = Array.from(current);
  ipcRenderer.send('set-pitwall-broadcast', newIds);
  renderBroadcastPage();
};
```

`window.toggleTeamBroadcast = ...` is required because the inline `onclick` from the card template runs in the global scope.

### `navigateTo` integration

Add one line to the existing `navigateTo()` function in `bridge/control-panel.html`, alongside the `if (panelId === 'favorites') renderFavoritesPage();` and `if (panelId === 'recent') renderRecentPage();` lines added in v3.24.0:

```js
if (panelId === 'broadcast') renderBroadcastPage();
```

### Existing `pitwall-teams` IPC listener

The existing `ipcRenderer.on('pitwall-teams', ...)` listener (currently calls `renderTeamBroadcast(data.teams, data.broadcastIds)`) is repointed at `renderBroadcastPage()`:

```js
ipcRenderer.on('pitwall-teams', () => renderBroadcastPage());
```

This way, server-pushed updates (e.g. another teammate joins, your token is invalidated, etc.) re-render automatically.

## Removed from Overview

Delete from `#panel-overview`:

```html
<div class="section-header" style="margin-top:14px;">Team Broadcasting</div>
<div id="team-broadcast-section" style="margin-bottom:8px;">
  <p style="font-size:11px;color:#5a5970;margin-bottom:8px;">Select which teams can see your telemetry on Pitwall:</p>
  <div id="team-broadcast-list" style="display:flex;flex-direction:column;gap:4px;">
    <p style="font-size:11px;color:#5a5970;font-style:italic;">Connecting...</p>
  </div>
</div>
```

Delete from the script block:

- The `function renderTeamBroadcast(teams, broadcastIds) { ... }` definition
- The `var pitwallState = ipcRenderer.sendSync('get-pitwall-teams');` block + the `if (pitwallState.status === 'disabled')` / `else if` branches that operate on `#team-broadcast-list`
- The `window.updateBroadcastTeams = function () { ... }` definition
- The existing `ipcRenderer.on('pitwall-teams', ...)` handler is REPLACED (not deleted) — see above

The new `renderBroadcastPage()`, `toggleTeamBroadcast()`, and the repointed `pitwall-teams` listener replace all of it.

## CSS additions

Append after the existing `.ov-empty` rule from v3.24.0:

```css
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

## Edge cases

| Case | Behavior |
|---|---|
| User opens the control panel before pitwall has authed | The first navigation to `broadcast` shows the loading state. When `pitwall-teams` IPC fires after auth, the listener re-renders the page automatically. |
| User toggles a card while disconnected | The toggle update is sent to main via `set-pitwall-broadcast`, which calls `pitwallUplink.setBroadcastTeams` — that already saves to `settings.json` AND queues `set-teams` for the next reconnect. UI re-renders immediately to reflect the local intent. |
| Server pushes `teams-updated` while the user is on a different tab | The `pitwall-teams` listener calls `renderBroadcastPage()`, which checks the panel exists and writes innerHTML — harmless even if the panel isn't visible. |
| User has zero teams | Empty state with the join URL (clickable, opens externally). |
| User clicks the team name (not the toggle) | Nothing happens. Card body is non-interactive by design — matches the Favorites/Recent card behavior. |
| User reloads the control panel | Same as fresh open: navigateTo() runs for the saved panel and re-fetches state. |
| Existing user upgrading from 3.24.x | No migration needed. The old Overview section is gone; the new sidebar entry appears; persisted `pitwallBroadcastTeamIds` continues to work because the IPC contract didn't change. |
| User searches "broadcast" in the sidebar search field | The search field excludes the Broadcasting entry from the search results (it's not in the categorized accordion groups; the existing search filter only operates on rows inside `.sidebar-group` divs). Acceptable — the entry is always visible in the sidebar anyway. |

## Files touched

| File | Change | Estimated scope |
|---|---|---|
| `bridge/control-panel.html` | Sidebar entry + new content panel + `renderBroadcastPage()` + `toggleTeamBroadcast()` + navigateTo wiring + repoint pitwall-teams listener + new CSS. Remove old Team Broadcasting section from Overview + delete old `renderTeamBroadcast` / `updateBroadcastTeams` / init code. | ~190 lines added, ~30 deleted |
| `bridge/main.js` | No change. | 0 |
| `bridge/pitwallUplink.js` | No change. | 0 |
| `bridge/package.json` | Bump 3.24.0 → **3.25.0**. | 1 line |
| Tests | No automated test infrastructure for the control-panel renderer. Manual smoke checklist in the implementation plan. | n/a |

## Acceptance criteria

- [ ] New `📡 Broadcasting` sidebar entry appears between Recent and the categorized accordions.
- [ ] Clicking it navigates to a content page with header + (sometimes) status bar + (always) cards or empty/disabled state.
- [ ] When pitwall is connected and the user is in 1+ teams: cards render in a 2-column grid with name + status label + toggle.
- [ ] Cards with broadcasting on get the green border tint and `● Broadcasting` status.
- [ ] Toggling a card immediately fires `set-pitwall-broadcast` IPC and re-renders the page.
- [ ] Status bar accurately reports `N teams · M broadcasting`.
- [ ] When pitwall is connected with 0 teams: empty state with clickable join URL.
- [ ] When pitwall is disconnected with cached teams: cards still render, status bar shows amber + "Reconnecting…", toggling still queues for next connect.
- [ ] When pitwall is disconnected with no cached teams: loading state.
- [ ] When pitwall is disabled (no racing user): "Pitwall not configured" message.
- [ ] Visiting Broadcasting → Race → Broadcasting renders fresh state (re-fetches via IPC every visit).
- [ ] Server-pushed `pitwall-teams` events re-render the page automatically.
- [ ] Closing and reopening the control panel preserves toggle state (already works via existing settings.json persistence; no regression).
- [ ] Updating Bridge to a new version preserves toggle state (same — no regression).
- [ ] The old Overview Team Broadcasting section is gone (markup + init code removed).
- [ ] Bridge version is `3.25.0`.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Removing the old Overview section breaks any other code that references `#team-broadcast-list` or `updateBroadcastTeams` | Grep the file before deleting; only the listed sites reference these. |
| `renderBroadcastPage()` is called before `pitwallUplink` has authed | The function correctly handles the disconnected/no-cache case (loading state). The `pitwall-teams` event will re-render once teams arrive. |
| The new `toggleTeamBroadcast` global collides with anything else | Namespace is dedicated. The `tb-` CSS prefix and `toggleTeamBroadcast` function name are unique. |
| The "broadcasting" panel id collides with an overlay id | None of the existing overlays use the id `broadcast`. Verified via grep against the OVERLAYS array. |
| The new CSS clashes with existing `.toggle` class on cards | The new `.tb-toggle` is namespaced — does not extend or override the existing `.toggle` rule used by overlay cards. |

## Versioning

- Bridge: **3.24.x → 3.25.0** (minor — new feature, backwards-compatible).
- Server: unaffected.
