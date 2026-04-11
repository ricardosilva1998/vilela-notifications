# Multi-Team Support + Avatar Crop Editor — Design Spec

**Date:** 2026-04-11
**Status:** Approved

---

## Feature 1: Multi-Team Support

### Overview

Evolve Team Pitwall from single-team-per-user to simultaneous multi-team membership (max 5 teams). Drivers control which teams receive their telemetry per-session. Pitwall viewers pick a team before entering.

### Architecture: Bridge-Centric Multi-Broadcast (Option C)

No schema migration needed. The `team_members` table already supports multi-team via `UNIQUE(team_id, user_id)` — the single-team restriction is enforced purely in application code.

### Database & API Layer

**db.js:**
- Add `getTeamsForUser(userId)` — returns array of all memberships (keep `getTeamForUser()` for backward compat during transition)
- `acceptTeamInvite()` — remove "already in a team" guard, replace with `if (membershipCount >= 5) return false`
- `joinTeamByCode()` — same: replace single-team guard with max-teams cap (5)

**Routes (racing-team.js):**
- `POST /create` — replace "already in a team" check with max-5 check
- `POST /invite` — remove "target already in a team" block; still prevent duplicate invites to same team
- `GET /join/:code` — replace "already in a team" with max-teams cap
- `GET /` — becomes teams list page: fetch all teams, render cards

**pitwallRelay.js:**
- `authBridge()` — return `teams: [{ id, name }]` array instead of single `teamId`. Auth succeeds even with 0 teams (local overlays still work)
- Bridge client state: `{ ws, teamIds: Set, username }` instead of `{ ws, teamId, username }`
- New message type `set-teams` — Bridge sends `{ type: 'set-teams', teamIds: [1, 3] }` to select broadcast targets. Can update mid-session without reconnecting
- `relayToViewers()` — check `driverClient.teamIds.has(viewer.teamId)` instead of `===`
- `broadcastToTeamViewers()` — called per team in the set for driver-online/offline events
- Pitwall viewer auth — `getTeamsForUser()` returns all teams. Viewer sends `{ type: 'select-team', teamId }` after auth to pick which team to watch

**Bridge uplink (pitwallUplink.js):**
- Auth message unchanged: `{ type: 'auth', userId, token }`
- Server responds: `{ type: 'auth-ok', teams: [{ id, name }, ...] }`
- Bridge sends `{ type: 'set-teams', teamIds: [...] }` after auth
- Can update selection mid-session

### Bridge UI — Team Selector

**Location:** Control panel Overview tab, "Broadcasting to" section.

**Behavior:**
- On auth-ok, receives teams list from server
- Checkboxes for each team, all unchecked by default (not broadcasting until opted in)
- Checking a team sends `set-teams` message over uplink WebSocket
- Green dot indicator next to actively broadcasting teams
- No teams: "No teams yet — join or create a team at atletanotifications.com/racing/teams"

**Settings persistence:** `pitwallBroadcastTeamIds` array in `settings.json`. Restored on next launch after auth. Stale team IDs (user left team) silently removed.

**No team required to use Bridge.** Auth works without team membership. All local overlays function regardless.

### Web UI — Teams Page

**Teams list (`/racing/teams`):**
- Replaces `/racing/team` (redirect old URL for backward compat)
- Grid of team cards: team name, member count, user's role, online driver count
- Each card links to `/racing/teams/:id` (team detail/management)
- "Create Team" and "Join Team" buttons at top
- Pending invites as banner above grid (accept/decline)

**Team detail (`/racing/teams/:id`):**
- Same management UI as current `/racing/team` scoped to one team
- Member list, invite form (username autocomplete), invite code, leave/delete/kick
- Owner sees pending outbound invites

**Racing dashboard update:**
- "Team" quick-link card becomes "Teams" card showing count (e.g., "3 Teams"), links to `/racing/teams`
- Sidebar: "Team" → "Teams"

### Pitwall Entry

- 0 teams: message with link to `/racing/teams`
- 1 team: skip selector, go straight to pitwall (current behavior)
- 2+ teams: team picker screen — cards per team with online driver count. Click to enter pitwall scoped to that team
- Inside pitwall: team name in header, "Switch Team" link to go back to picker

---

## Feature 2: Avatar Crop Editor

### Overview

Replace the auto-crop avatar upload with an interactive crop editor modal using Cropper.js. Users can pan and zoom to select the crop area before uploading.

### Library

Cropper.js — vanilla JS, no dependencies, ~40KB. Loaded from CDN.

### Flow

1. User clicks "Change Photo" on `/racing/account`
2. File input triggers — on file select, modal opens with image loaded into Cropper.js
3. Cropper configured: aspect ratio 1:1, zoom/pan enabled, drag to reposition
4. Modal: "Cancel" and "Save" buttons
5. On Save: Cropper outputs 128x128 canvas → `toDataURL('image/jpeg', 0.8)` → POST to `/racing/account/avatar`
6. Modal closes, avatar preview updates immediately

### Modal Design

- Dark overlay backdrop, centered card (~400px wide)
- Image preview area with Cropper.js controls (drag to pan, scroll to zoom)
- Matches app design system (CSS custom properties from `header.ejs`)
- No rotate/flip — crop and zoom only

### Implementation Scope

- All changes in `racing-account.ejs`: modal HTML, Cropper.js CSS/JS from CDN, replace `uploadAvatar()` with crop flow
- No backend changes — same endpoint, same base64 format, same 128x128 output
- No new files needed
