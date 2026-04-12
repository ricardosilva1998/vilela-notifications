# Pitwall Edit Mode — Design

**Date:** 2026-04-12
**Scope:** `src/views/racing-pitwall.ejs`
**Status:** Approved, ready for plan

## Problem

The Team Pitwall page uses gridstack.js to arrange nine overlay iframes in a free-form 12×10 grid. In principle the grid supports drag and resize, but in practice users cannot figure out how to rearrange panels:

1. **Drag targets are invisible.** Each panel is almost entirely covered by a live overlay iframe, and iframes swallow pointer events. The only draggable surface is the 1px panel border and a hidden 9×9 label in the top-left. First-time users don't know where to click.
2. **`float: false` fights the user.** Gridstack is configured with `float: false`, which auto-compacts panels upward. Moving a lower panel up causes the panels that were above to collapse downward, so attempts to place a specific panel in a specific spot (e.g. move Session Laps to the centre and push Race Duration + Weather to the bottom) get silently rearranged.
3. **Only three resize handles.** `resizable: { handles: 'e,se,s' }` — users can only grow panels down and to the right, not up or to the left.
4. **No clear affordance for the existing Lock Layout button.** It lives inside the ⚙ settings panel, is visually small, and its inverse (drag enabled) is not signposted anywhere.

Result: the panel layout feels effectively fixed, defeating the purpose of having a free-form grid.

## Goal

A user on `/racing/pitwall` can click a single obvious button in the top bar to enter **Edit Mode**, rearrange every panel freely (drag from anywhere on the tile, resize from any edge or corner, leave empty space wherever they want), click **Done** to exit, and have the layout persist across reloads.

Viewing mode (the default) must feel exactly like today — no borders, no grips, iframes fully clickable — so the watching experience isn't cluttered for users who never rearrange.

## Non-Goals

- **Track map zoom** — separate feature, separate brainstorm, separate spec.
- **Multiple named layouts** (e.g. "Race layout" vs "Practice layout"). The single persisted layout is enough for the current user request.
- **Snap-to-preset layouts** (1-column, 2-column, mobile). Free-form covers it.
- **Mobile/touch drag UX.** Pitwall is a desktop feature and the mockups assume mouse + trackpad.

## Design

### Top bar button

A new button is inserted in `.timing-bar` immediately before the existing `#settings-btn` (⚙).

- **Viewing mode:** label `✎ Edit Layout`, muted outline style matching the existing `.toolbar-btn`.
- **Edit mode:** label `✓ Done`, solid accent purple (`var(--accent)`) background with white text.
- Click toggles the mode.
- Escape key exits edit mode from anywhere in the page.

The existing "Lock Layout" button inside the settings panel is **removed**. Its entire state (`LOCK_KEY` in localStorage, `isLocked` variable, `.grid-stack.locked` CSS class) is deleted in the same change — the new Edit Mode toggle subsumes it. "Show / Hide Overlays" checkboxes and "Reset" button stay inside the ⚙ settings panel unchanged.

### Gridstack configuration changes

Two settings change at init time:

| Setting | Before | After |
|---|---|---|
| `float` | `false` | `true` |
| `resizable.handles` | `'e,se,s'` | `'n,e,s,w,ne,nw,se,sw'` |

`float: true` applies in both viewing and edit mode — it has no visible effect in viewing mode (which disables drag+resize), but ensures that when a user does customize, an accidental window resize can't silently re-pack their layout.

The grid starts with drag and resize **disabled** (viewing mode is the default). Entering edit mode calls `grid.enableMove(true); grid.enableResize(true);`. Exiting calls `grid.enableMove(false); grid.enableResize(false);`.

### Edit-mode visual state (CSS class `.pitwall-grid.editing`)

Applied to `#pitwall-grid` when edit mode is active.

Three new DOM elements per tile, added unconditionally inside `addWidget()` content template and gated via CSS to only show in edit mode:

1. **`.pitwall-drag-strip`** — a real `<div>` (not a pseudo-element) containing the ⋮⋮ grip glyph and the panel name taken from `PANEL_LABELS[item.id]` at addWidget time. Positioned `absolute; top:0; left:0; right:0; height:18px; z-index:4;` with purple background. `display: none` by default; `.editing .pitwall-drag-strip { display: flex; }`. `cursor: move`. Gridstack's drag handler attaches to the whole tile, so a click on this strip starts a drag just like a click anywhere else in the tile — but the strip gives the user a visible grab target.
2. **`.pitwall-iframe-shield`** — a transparent absolutely-positioned `<div>` sibling of the iframe that sits on top of it at full tile size (`inset: 0; z-index: 3;`). `display: none` by default; `.editing .pitwall-iframe-shield { display: block; }`. Intercepts clicks on the iframe region so gridstack receives them as drag events instead of the iframe swallowing them. When edit mode exits, the shield is hidden and iframes regain click interactivity — no iframe reload needed.
3. **Existing `.panel-label`** — the small absolutely-positioned name label rendered in viewing mode gets a new rule: `.editing .panel-label { display: none; }`. The drag strip carries the panel name in edit mode, so the small label would be redundant. Viewing mode behavior for `.panel-label` (the commit landed earlier that hides it when iframe is visible and shows it when placeholder is visible) is unchanged.

Other edit-mode CSS:

- `.editing .grid-stack-item-content` — 2px solid `var(--accent)` border, `cursor: move`.
- `.editing .ui-resizable-e, .editing .ui-resizable-w, .editing .ui-resizable-n, .editing .ui-resizable-s` — visible 6×14 purple edge handles.
- `.editing .ui-resizable-ne, .editing .ui-resizable-nw, .editing .ui-resizable-se, .editing .ui-resizable-sw` — visible 10×10 purple corner dots with white border.

Viewing mode: none of the above applies. Panels have the existing subtle 1px border, no grips, no shield, and the iframe is fully interactive for clicks into standings rows etc.

### Why the iframe shield is the linchpin

Without an overlay element on top of the iframe, mouse events on the iframe body never bubble up to the parent document, so gridstack's drag detection never fires on any click inside the iframe region — which is 99% of the tile's surface. This is the root cause of the user's "drag handles feel invisible" complaint. The shield is a transparent `<div>` sibling of the iframe inside `.grid-stack-item-content`, sized to fill the tile, and only shown in edit mode. It has no visual presence but captures all clicks in the iframe region, letting gridstack handle them as drag-start events on the parent `.grid-stack-item`. When edit mode exits, the shield is hidden and iframes regain pointer event interactivity with no reload.

### State and persistence

- Layout persistence: **unchanged.** The existing `grid.on('change', saveCurrentLayout)` handler already writes the layout to `localStorage` under `LAYOUT_KEY` on every move or resize. This continues to fire in edit mode.
- Mode state: **not persisted.** Every page load starts in viewing mode. A user who reloads mid-rearrange finds themselves back in viewing mode; their layout changes are already saved. Rationale: viewing mode is the primary use case and the cost of re-clicking "Edit Layout" is trivial.
- Hidden panels: **unchanged.** Still stored in `HIDDEN_KEY`.

### Keyboard shortcut

Escape exits edit mode. Handled via a single `window.addEventListener('keydown', ...)` registered at page load, filtered to `event.key === 'Escape' && document.body.classList.contains('pitwall-editing')`.

No shortcut for *entering* edit mode — the explicit button is the discoverable path.

### Re-render on navigate

Not applicable — the pitwall page is a single SPA-free page with no route navigation. Reloads reset to viewing mode via the default state.

## Code changes

One file: `src/views/racing-pitwall.ejs`.

Approximate delta:
- **Remove:** `isLocked` variable, `LOCK_KEY` const, lock-layout button in `buildSettingsPanel()`, `toggleLock()` function, `.grid-stack.locked` CSS rules, init-time `grid.enableMove(false); grid.enableResize(false)` gated on `isLocked`.
- **Add:** `isEditing` variable (ephemeral, not persisted), `✎ Edit Layout` button element in `.timing-bar`, `toggleEditMode()` function, Escape key listener, `.pitwall-iframe-shield` div in `addWidget()` content template, CSS block for `.pitwall-grid.editing`, `grid.enableMove(false)` + `grid.enableResize(false)` at init (always, because viewing mode is the default).
- **Change:** gridstack init — `float: false` → `float: true`, `handles: 'e,se,s'` → `handles: 'n,e,s,w,ne,nw,se,sw'`.

No changes to `pitwallRelay.js`, no changes to Bridge, no changes to any overlay HTML files. No migration — the localStorage schema for `LAYOUT_KEY` and `HIDDEN_KEY` stays identical. `LOCK_KEY` (string `'pitwall-locked-v1'`) is orphaned in anyone's localStorage but harmless.

## Error handling

Nothing new. Gridstack handles invalid layouts (e.g. overlapping after window resize) internally. Edit mode is a pure CSS + state toggle with no failure modes.

## Testing

Manual check on `/racing/pitwall`:

1. Default state: top bar shows `✎ Edit Layout` button. No panel borders. Clicking into standings row does not move the panel.
2. Click `✎ Edit Layout`: button swaps to `✓ Done`. All visible panels grow purple borders, drag strips appear on top, resize handles appear on all edges.
3. Drag a panel from its body: gridstack should pick up the drag, the panel moves, other panels stay where they were (`float: true`).
4. Resize from each of the 8 handles: all work.
5. Click `✓ Done`: borders and strips disappear, iframes become clickable again. Layout persists — reload the page and the new layout is still there.
6. Repeat step 2 and press Escape: exits edit mode.
7. Hide a panel via the ⚙ Show/Hide checkboxes: still works. Edit mode doesn't touch hidden panels.

No automated tests — `racing-pitwall.ejs` isn't covered by the existing Playwright suite and a single EJS view with client-side only interactions has low ROI for test infra. Manual verification on production Railway is the deployment workflow.

## Open questions

None. Design is fully specified.
