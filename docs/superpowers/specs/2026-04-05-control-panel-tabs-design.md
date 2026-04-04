# Control Panel Tabs & Card Grid Redesign

## Context

The Bridge control panel is a single scrollable page with a vertical list of overlay toggles. It needs tabs to separate overlays from updates/release notes, and the overlay items should be 2-column cards. The window needs to be wider to fit the grid.

## Design

### Window Size

- Current: 420x640 (in `main.js` BrowserWindow config)
- New: **540x640** — wider to fit 2-column card grid comfortably

### Tab System

Two tabs below the status card, above content:
- **Overlays** (default) — overlay card grid + lock button + auto-hide
- **Updates** — update banner + version + release notes history

Tab persistence via `localStorage` (consistent with web dashboard pattern).

### Overlays Tab

2-column CSS grid of compact cards. Each card:
- Icon + name (left)
- Gear icon + toggle switch (right)
- Same hover border effect as current items
- All 8 overlays fit without scrolling

Customize panel still appears below the grid when gear is clicked (same behavior as current).

### Updates Tab

Three sections:
1. **Update banner** (green, only visible when update available) — version, description, Download button, progress bar during download, Install & Restart when ready
2. **Version line** — "Installed: v1.0.42" + "Check for Updates" button
3. **Release notes** — scrollable list of past versions with bullet-point changelogs fetched from GitHub releases via `electron-updater` or hardcoded from a local changelog

### Release Notes Data

For initial implementation: release notes are hardcoded in the HTML as a `RELEASE_NOTES` array. Future enhancement could fetch from GitHub Releases API, but that adds complexity and network dependency.

### Files to Modify

- `bridge/main.js` — change window width from 420 to 540
- `bridge/control-panel.html` — tab UI, card grid, updates tab content, all styling
