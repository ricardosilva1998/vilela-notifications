# Bridge Sidebar Redesign — Design Spec

**Date:** 2026-04-12
**Component:** `bridge/control-panel.html` + `bridge/main.js` + `bridge/settings.js`
**Goal:** Replace the always-expanded category accordions with a search-first sidebar plus dedicated Favorites and Recent grid pages, so the user can reach the overlay they want in one click instead of scrolling/closing groups.

## Problem

The Bridge control panel currently lists ~22 sidebar entries inside four always-expanded category accordions (Race / Car / Track / Stream) plus Overview and four bottom utility tabs. The vertical content is taller than the 706 px usable height of the 1000×750 control panel window, forcing the user to scroll. There is no persistence of accordion state, no search, and no shortcut to recently or frequently used overlays. Editing any single overlay's settings requires either remembering which group it's in or scanning the full list every time.

## Goals

1. Reduce sidebar height so it fits the window without scrolling on first launch.
2. Make the most-used overlays one click away (Favorites + Recent).
3. Provide instant text-based navigation (Search).
4. Preserve the existing browse-by-category model as a fallback for users who think in those terms.
5. Add a `⚙ settings` shortcut from any card so the user can jump straight from a grid to a single overlay's settings.
6. Persist all UI state (favorites, recent, group collapse) across Bridge restarts.

## Non-goals (out of scope for v1)

- Drag-to-reorder favorites — favorites are stored in click-add order.
- Search matching against descriptions, tags, or content beyond the overlay name.
- Keyboard arrow navigation through filtered results.
- "Recently used today" / "Recently used ever" time bucketing — Recent is a flat top-5 list.
- Auto-pinning of frequently used overlays — favorites are explicit only.
- Sidebar collapse-to-icons mode.
- Drop-and-replace of the Race/Car/Track/Stream taxonomy.

## High-level design

Three things change in the control panel:

1. **The sidebar** gets a search field at the top, two new entries (★ Favorites, 🕒 Recent) above the existing accordions, and the four category accordions default to collapsed with persisted state. Bottom utility tabs (Account / Updates / Logs / About) are anchored at the bottom and unchanged.

2. **Three card-grid pages** (Overview, Favorites, Recent) share a single card component with: icon + name + enable toggle + ⚙ gear (jump to overlay settings) + ★ star (toggle favorite). The existing Overview tab is upgraded to use this component.

3. **Persisted UI state** — three new keys on `settings.json`: `uiFavorites`, `uiRecent`, `uiSidebarGroups`. All three default to empty / all-collapsed and migrate cleanly for existing users (additive only, no breaking changes).

## Sidebar layout

```
┌─────────────────────────────┐
│ 🔎 Search overlays…        │
├─────────────────────────────┤
│ ⊞ Overview                  │
│ ★ Favorites                 │
│ 🕒 Recent                   │
├─────────────────────────────┤
│ ▶ Race                      │
│ ▶ Car                       │
│ ▶ Track                     │
│ ▶ Stream                    │
│                             │
│         (spacer)            │
├─────────────────────────────┤
│ 👤 Account                  │
│ 🔄 Updates                  │
│ 📄 Logs                     │
│ ⓘ About                     │
└─────────────────────────────┘
```

### Search field

- New `<input type="search">` at the top of the sidebar.
- Live filter, no Enter required.
- Matches the overlay `name` from the `overlays` array via case-insensitive substring.
- Excludes Overview, Favorites, Recent, and the four utility tabs from search results — they aren't overlays.
- When the field is non-empty:
  - Auto-expands every group containing at least one match (so the user sees results in their original category context).
  - Dims (50% opacity, no border-left highlight) every row that doesn't match.
  - The category labels (`Race`, `Car`, etc.) for groups with no matches stay visible but the group body is hidden.
  - If zero matches across all groups, shows an inline `No overlays match "<query>"` message under the search field.
- Clearing the field (Escape, or deleting all chars) restores every group to its persisted collapsed/expanded state and removes the dim styling.
- **`⌘K` / `Ctrl+K` shortcut** focuses the search field from anywhere in the control panel.
- **`Escape`** when the search field is focused: clears the field if it has content, or unfocuses if already empty.

### Favorites and Recent sidebar entries

- Both are single sidebar items (not accordions). Clicking either navigates to its grid page in the content area.
- Visual style matches the existing `.sidebar-item` (same padding, font, hover, active states).
- ★ Favorites uses the existing star glyph in `#f7c948`.
- 🕒 Recent uses the clock glyph in `#3ecf8e`.
- These sit between Overview and the categorized groups, separated from each by `.sidebar-divider`.

### Categorized groups (Race / Car / Track / Stream)

- Stay in their current order.
- All four default to **collapsed** on first launch.
- Each group's collapsed/expanded state is persisted independently in `settings.uiSidebarGroups` (see Persisted state below).
- Toggling a group does not affect any other group.
- The existing `toggleSidebarGroup()` function is updated to write the new state to settings on every toggle.

### Bottom utility tabs

- Account, Updates, Logs, About are unchanged in position, behavior, and styling.
- They are NOT included in search results.
- Visiting them does NOT add them to Recent.

## Card-grid pages

Three pages share the same card component: **Overview**, **Favorites**, **Recent**. They differ only in which overlays they show and the page title.

### Card component

```
┌─────────────────────────────────────┐
│  🏁  Standings    [⚪ ON]  ⚙  ★    │
└─────────────────────────────────────┘
```

| Element | Behavior |
|---|---|
| Card body | Non-interactive. No click handler. |
| Icon (left) | Decorative; pulled from the `overlays` array entry's existing icon. |
| Name (left) | The overlay's `name` from the `overlays` array. |
| Enable toggle | Existing `.toggle` style. Click flips the overlay window on/off via existing `toggleOverlay(overlayId, checked)` IPC. Stops click propagation (no-op since card body is non-interactive, but defensive). |
| ⚙ Gear | Clicking calls `navigateTo(overlayId)` (existing function). Stops click propagation. Tooltip: `Open settings`. |
| ★ Star | Filled (`#f7c948`) if the overlay id is in `settings.uiFavorites`, empty (`#3a3a4e`) otherwise. Click toggles favorite status via new `toggleFavorite(overlayId)` function. Stops click propagation. Tooltip: `Add to favorites` / `Remove from favorites`. |

CSS layout: 2-column grid (`grid-template-columns: 1fr 1fr; gap: 10px`), reusing the existing `.overview-grid` pattern. Card uses the existing `.overview-card` colors and border-radius for consistency.

### Per-page differences

| Page | Title block | Cards shown | Order | Empty state |
|---|---|---|---|---|
| Overview | Existing connection-status block + "Overlays" section header | All entries from the `overlays` array (full set) | Same order as the `overlays` array | Never empty (always shows all overlays) |
| Favorites | `★ Favorites` h3 + subtitle "Quick access to your starred overlays" | Only overlays whose id is in `settings.uiFavorites` | Order added (newest at end) | "No favorites yet — star any overlay to add it here" centered placeholder |
| Recent | `🕒 Recent` h3 + subtitle "Last 5 overlays you opened" | Up to 5 overlays from `settings.uiRecent` | Most-recent first (front of array) | "Nothing here yet — open an overlay's settings to start tracking" centered placeholder |

### Tracking rules

**Adding to Recent** (new function `pushRecent(overlayId)`):

- Called from `navigateTo(overlayId)` whenever the target panel is an OVERLAY (not Overview, Favorites, Recent, Account, Updates, Logs, About).
- Removes any existing entry with the same id.
- Unshifts the id to the front of `settings.uiRecent`.
- Trims `settings.uiRecent` to 5 entries.
- Persists immediately via `save-ui-state` IPC.

**Adding to / removing from Favorites** (new function `toggleFavorite(overlayId)`):

- If the id is already in `settings.uiFavorites`, splice it out.
- Otherwise, push it to the end.
- Persists immediately via `save-ui-state` IPC.
- Re-renders the Favorites grid (if currently visible) and updates every visible ★ icon for that overlay id.

## Persisted state — `settings.json` schema

Three new top-level keys are added. All are additive — existing keys are unchanged.

```json
{
  "uiFavorites": ["standings", "raceduration", "fuel"],
  "uiRecent": ["weather", "voicechat", "standings", "fuel", "drivercard"],
  "uiSidebarGroups": {
    "race": false,
    "car": true,
    "track": true,
    "stream": true
  }
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `uiFavorites` | `string[]` | `[]` | Overlay ids in the order they were starred. Newest at the end. |
| `uiRecent` | `string[]` | `[]` | Overlay ids, most-recent first. Capped at 5 entries on every push. |
| `uiSidebarGroups` | `Record<string, boolean>` | `{ race: true, car: true, track: true, stream: true }` | Per-group collapse state. `true` = collapsed, `false` = expanded. |

Defaults are applied in `bridge/main.js` after `loadSettings()` so existing users get the new keys without manual migration.

### IPC

Two new IPC channels in `bridge/main.js`:

- `get-ui-state` (sync) → returns `{ uiFavorites, uiRecent, uiSidebarGroups }` from current `settings`.
- `save-ui-state` (async, fire-and-forget) → receives `{ uiFavorites?, uiRecent?, uiSidebarGroups? }` and merges into `settings`, then calls `saveSettings(settings)`. Partial payloads accepted (renderer can save just one key at a time).

The renderer calls these from a small new helper module that wraps the IPC behind `getUiState()` / `saveUiState(patch)` for cleanliness.

## Edge cases

| Case | Behavior |
|---|---|
| Stale id in `uiFavorites` (overlay was renamed or removed from the `overlays` array) | Skip during render. Next time `toggleFavorite` runs, the array gets cleaned of any unknown ids before save. |
| Stale id in `uiRecent` | Same — skip during render, prune on next `pushRecent`. |
| Empty `uiFavorites` | Favorites page shows the empty-state placeholder. Sidebar entry stays visible. |
| Empty `uiRecent` | Recent page shows the empty-state placeholder. |
| User visits Account / Updates / Logs / About | Not added to Recent. |
| Search with no results | Shows `No overlays match "<query>"` inline below the search field. All group bodies hidden. |
| Search with single character query | Matches as normal — no minimum length. |
| User presses Escape with empty search field | Field unfocuses (no other side effect). |
| User presses Escape with non-empty field | Field clears, focus stays in the field. Groups restore to persisted state. |
| `⌘K` / `Ctrl+K` from anywhere in the panel | Focuses the search field. |
| Existing user upgrades (no `uiFavorites` / `uiRecent` / `uiSidebarGroups` in their settings) | Defaults applied on `loadSettings()`. Empty favorites + empty recent + all groups collapsed. The transition is invisible — they just see the new sidebar with everything tucked away. |
| User had a category accordion expanded in v3.23 | They will see all four collapsed in v3.24 because the new persisted state did not exist before. Acceptable: new feature, fresh defaults. |
| Renderer rebuild (`buildSettingsPanels()`) | Cards re-render from the latest `uiFavorites` / `uiRecent` after every settings change so star fills stay in sync across all three pages. |
| Toggling overlay enable from a card | Reuses existing `toggleOverlay(id, checked)` IPC — no behavior change to overlay enable/disable, just a new place to click it. |
| Two cards visible for the same overlay (Overview + Favorites + Recent simultaneously? — only Overview AND Favorites can be visible at once since they're separate pages, but Search can show the same id in multiple groups) | Each card is independent; they all read the same `uiFavorites` so star state is synchronized. |

## Files touched

| File | Change | Estimated scope |
|---|---|---|
| `bridge/control-panel.html` | Sidebar markup rewrite (search field, new entries, group defaults). New `panel-favorites` and `panel-recent` content panels. New shared `renderOverlayCard()` helper. New `renderFavoritesPage()` and `renderRecentPage()` functions. New `applySearchFilter()` function. New `toggleFavorite()` function. New `pushRecent()` function. Wire `pushRecent` into `navigateTo`. New `⌘K` global keydown listener. New CSS for the search field, new card layout, empty states. Migrate `toggleSidebarGroup` to write `uiSidebarGroups`. | ~280 lines added, ~40 modified |
| `bridge/main.js` | New IPC handlers `get-ui-state` / `save-ui-state`. Apply defaults for `uiFavorites` / `uiRecent` / `uiSidebarGroups` after `loadSettings()`. | ~30 lines added |
| `bridge/settings.js` | No change — new keys are just additional top-level fields. | 0 |
| `bridge/package.json` | Version bump 3.23.x → **3.24.0** (minor; new feature). | 1 line |
| Tests | No automated test infrastructure for the control-panel renderer. The implementation plan includes a manual smoke checklist (open Bridge, verify each page, star/unstar, recent push, search, group collapse, restart and verify persistence). | n/a |

## Acceptance criteria

- [ ] Sidebar fits in the 1000×750 control panel window without scrolling on first launch.
- [ ] All four categorized groups default to collapsed.
- [ ] Search field filters overlays live, dims non-matching rows, auto-expands matching groups, restores state on clear.
- [ ] `⌘K` (macOS) / `Ctrl+K` (Windows/Linux) focuses the search field.
- [ ] Favorites page shows starred overlay cards in a grid; empty state visible with no favorites.
- [ ] Recent page shows up to 5 overlay cards in most-recent-first order; empty state visible on first launch.
- [ ] Overview page shows all overlays in the new card layout with toggle + gear + star.
- [ ] Clicking ⚙ on any card navigates to that overlay's settings panel.
- [ ] Clicking ★ on any card toggles favorite status; the star reflects the change on every visible card for that overlay.
- [ ] Clicking the toggle on a card flips the overlay window on/off without navigating.
- [ ] Visiting an overlay panel updates `uiRecent` (capped at 5).
- [ ] Visiting Account / Updates / Logs / About does NOT update `uiRecent`.
- [ ] Group collapse state persists across Bridge restarts.
- [ ] Favorites and Recent persist across Bridge restarts.
- [ ] Existing users upgrading from 3.23.x see no errors and a clean default state.
- [ ] Bridge version bumps to 3.24.0 in `bridge/package.json`.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| ⌘K conflicts with browser DevTools shortcut in Electron | Bridge is an installed app, not a browser tab — DevTools is opened via View menu, not a hotkey. ⌘K is free. |
| Search filter logic accidentally hides system tabs (Account etc.) | System tabs are not inside any of the categorized groups; the filter only acts on rows inside the four `.sidebar-group` elements. Verified by class scope. |
| Persisted `uiSidebarGroups` could grow if categories are renamed in the future | Group keys are short and limited to four. If a category is added/renamed, the unknown key in `uiSidebarGroups` is ignored, the new key gets the default. No migration code needed. |
| Card grid renders too narrow at 1000 px window | The two existing 2-col grid uses are stable at this width; cards collapse to a single column at < 480 px content width which never happens in the control panel. |
| User loses track of which overlay is favorited because the star is small | Filled star uses the same `#f7c948` amber that all UI accents use; it's high-contrast against the dark card. Tooltip on hover confirms state. |
| Recent always pushes on every navigation, even if user clicks the same overlay twice | The `removeIfPresent + unshift` pattern handles this — clicking Standings twice in a row leaves it as the single front entry, never duplicated. |
| Renderer has stale state after IPC save | Renderer re-renders the affected page after every state change instead of relying on backend echoes. |

## Versioning

- Bridge: **3.23.x → 3.24.0** (minor — new feature, backwards-compatible).
- Server: unaffected.
