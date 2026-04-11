# Team Pitwall — Live Telemetry Sharing Design Spec

## Context

Users want to create racing teams and share live telemetry with teammates. A "Pitwall" page on the web shows all overlays (standings, inputs, fuel, relative, wind, trackmap, weather, pit strategy, lap compare, session laps, pit duration, race duration) as if viewing the driver's screen — enabling remote spotting, strategy, and coaching.

## Architecture

```
Driver's Bridge → WebSocket → Server (relay) → WebSocket → Teammate's Browser
```

Bridge streams throttled telemetry to the server. Server validates team membership and relays to pitwall viewers. Overlay HTML files are reused in iframes with a query-param-based WebSocket URL override.

## Database Schema

### `teams` table
- id, name, owner_id (FK racing_users), invite_code (UNIQUE), created_at

### `team_members` table
- id, team_id (FK teams CASCADE), user_id (FK racing_users), role ('owner'|'member'), joined_at
- UNIQUE(team_id, user_id)

### `team_invites` table
- id, team_id (FK teams CASCADE), invited_user_id (FK racing_users), invited_by (FK racing_users), status ('pending'|'accepted'|'declined'), created_at

## Routes

### Team Management (`/racing/team/*`)
- GET `/racing/team` — team dashboard
- POST `/racing/team/create` — create team
- POST `/racing/team/invite` — invite by username
- POST `/racing/team/invite/:id/accept` — accept invite
- POST `/racing/team/invite/:id/decline` — decline invite
- POST `/racing/team/kick/:userId` — remove member (owner only)
- POST `/racing/team/leave` — leave team
- POST `/racing/team/delete` — delete team (owner only)
- GET `/racing/team/join/:code` — join via invite code

### Pitwall
- GET `/racing/pitwall` — pitwall page with overlay iframes

## WebSocket Protocol

### Bridge → Server (`/ws/bridge`)
```
{ type: 'auth', bridge_id, racing_user_id }
{ type: 'telemetry', channel, data }
```

### Browser → Server (`/ws/pitwall`)
```
{ type: 'subscribe', channels: [...], driverId: N }
{ type: 'view-driver', userId: N }
```

### Server → Browser
```
{ type: 'auth-ok', teamId, activeDrivers: [...] }
{ type: 'data', channel, data }
{ type: 'driver-online/offline', userId, username }
```

## Throttle Rates (Bridge → Server)

| Channel | Local Hz | Relay Hz |
|---------|----------|----------|
| inputs | 30 | 10 |
| fuel | 30 | 1 |
| wind | 30 | 2 |
| session | 30 | 1 |
| trackmap | 30 | 6 |
| relative | 6 | 6 |
| standings | 1 | 1 |
| proximity | 30 | skip |

## Overlay Dual-Mode

One-line change per overlay:
```javascript
const BRIDGE_URL = new URLSearchParams(window.location.search).get('ws') || 'ws://localhost:9100';
```

Pitwall iframes load: `/pitwall/overlays/standings.html?ws=wss://atletanotifications.com/ws/pitwall&driver=N`

## Implementation Phases

1. Database + Team Management (web UI)
2. WebSocket Relay Infrastructure (server)
3. Bridge Uplink (pitwallUplink.js)
4. Overlay Dual-Mode + Pitwall Page
5. Polish (heartbeat, reconnection, edge cases)

## Key Files

- `src/db.js` — 3 new tables
- `src/services/pitwallRelay.js` — new relay module
- `src/routes/racing-team.js` — new team routes
- `src/views/racing-team.ejs` — new team page
- `src/views/pitwall.ejs` — new pitwall page
- `bridge/pitwallUplink.js` — new Bridge uplink
- `bridge/telemetry.js` — add pitwallUplink.send() calls
- `bridge/overlays/*.html` — 1-line URL change per file
