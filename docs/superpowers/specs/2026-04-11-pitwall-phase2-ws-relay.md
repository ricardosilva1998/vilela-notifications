# Team Pitwall Phase 2 — WebSocket Relay Infrastructure

## Overview

Server-side WebSocket relay that accepts telemetry from Bridge apps and forwards it to browser-based pitwall viewers. Two WebSocket paths on the same HTTP server.

## Architecture

```
Bridge App → wss://atletanotifications.com/ws/bridge
               ↓ auth (username/password)
               ↓ validate team membership
               ↓ store latest data per-channel per-user
Browser    → wss://atletanotifications.com/ws/pitwall
               ↓ auth (session cookie)
               ↓ subscribe to channels + select driver
               ← receive throttled telemetry relay
```

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/services/pitwallRelay.js` | WebSocket relay module — both bridge and pitwall WS servers |
| Modify | `src/server.js` | Capture and export `http.Server` from `app.listen()` |
| Modify | `src/index.js` | Pass HTTP server to `pitwallRelay.init()` |

## WebSocket Server Setup

Attach to the existing HTTP server using `ws` library path-based routing. Two `WebSocket.Server` instances with `noServer: true`, handling upgrade manually based on URL path.

```javascript
const bridgeWss = new WebSocketServer({ noServer: true });
const pitwallWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws/bridge') {
    bridgeWss.handleUpgrade(req, socket, head, ws => bridgeWss.emit('connection', ws, req));
  } else if (req.url === '/ws/pitwall') {
    pitwallWss.handleUpgrade(req, socket, head, ws => pitwallWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});
```

## Bridge Connection Protocol (`/ws/bridge`)

### Auth Flow

1. Bridge connects to `/ws/bridge`
2. Bridge sends: `{ type: 'auth', username: '...', password: '...' }`
3. Server validates credentials via `bcrypt.compare()` against `racing_users` table
4. Server checks user is in a team via `getTeamForUser(userId)`
5. If valid: send `{ type: 'auth-ok', userId, teamId }`, mark driver as online
6. If invalid: send `{ type: 'auth-error', reason: '...' }`, close connection
7. Must auth within 10 seconds or connection is closed

### Telemetry Flow

After auth, Bridge sends: `{ type: 'telemetry', channel: 'fuel', data: {...} }`

Server stores the latest data per-channel per-userId in an in-memory Map:
```
driverData: Map<userId, Map<channel, { data, timestamp }>>
```

On each telemetry message, server checks if enough time has passed since last relay for that channel (throttle), then relays to all pitwall viewers watching that driver.

### Disconnect

When a Bridge disconnects, mark driver offline and broadcast `{ type: 'driver-offline', userId, username }` to all pitwall viewers in the same team.

## Pitwall Viewer Protocol (`/ws/pitwall`)

### Auth Flow

1. Browser connects to `/ws/pitwall`
2. Server parses session cookie from the upgrade request headers
3. Looks up `racing_user_id` from the sessions table
4. Validates user is in a team via `getTeamForUser(userId)`
5. If valid: send `{ type: 'auth-ok', teamId, activeDrivers: [{userId, username}, ...] }`
6. If invalid: send `{ type: 'auth-error', reason: '...' }`, close connection

### Subscription Flow

Viewer sends: `{ type: 'subscribe', channels: ['standings', 'fuel', 'relative'], driverId: 5 }`

Server stores subscription state per viewer. Only relays data for the selected driver on the subscribed channels.

Viewer can change driver: `{ type: 'view-driver', driverId: 7 }`

When driver changes, server sends the latest cached data for all subscribed channels immediately (so the viewer doesn't have to wait for the next telemetry tick).

### Server → Viewer Messages

```
{ type: 'auth-ok', teamId, activeDrivers: [{userId, username}, ...] }
{ type: 'auth-error', reason: '...' }
{ type: 'data', channel: 'fuel', data: {...} }
{ type: 'driver-online', userId, username }
{ type: 'driver-offline', userId, username }
```

## Throttle Rates

Server-side throttle per channel — minimum interval between relays to pitwall viewers.

| Channel | Bridge sends at | Relay to pitwall at |
|---------|----------------|-------------------|
| standings | 1 Hz | 1 Hz (1000ms) |
| relative | 2 Hz | 2 Hz (500ms) |
| fuel | 10 Hz | 1 Hz (1000ms) |
| wind | 10 Hz | 2 Hz (500ms) |
| trackmap | 2 Hz | 2 Hz (500ms) |
| inputs | 30 Hz | 10 Hz (100ms) |
| session | 1 Hz | 1 Hz (1000ms) |
| proximity | skip | skip |

Throttle tracked per-driver per-channel: `lastRelayTime: Map<userId, Map<channel, timestamp>>`.

## In-Memory State

```javascript
// Active bridge connections: userId → { ws, teamId, username }
const bridgeClients = new Map();

// Active pitwall viewers: ws → { userId, teamId, watchingDriverId, channels: Set }
const pitwallClients = new Map();

// Latest telemetry per driver: userId → Map<channel, { data, timestamp }>
const driverData = new Map();

// Last relay time per viewer per channel: ws → Map<channel, timestamp>
const lastRelayTime = new Map();
```

## Online Status Integration

When a Bridge authenticates successfully:
- Store in `bridgeClients`
- Broadcast `{ type: 'driver-online', userId, username }` to all pitwall viewers in the same team
- Update the pitwall page's driver list (frontend will handle this)

When a Bridge disconnects:
- Remove from `bridgeClients`
- Clean up `driverData` for that user
- Broadcast `{ type: 'driver-offline', userId, username }` to team's pitwall viewers

## Pitwall Page Updates (racing-pitwall.ejs)

Update the pitwall page to:
- Connect to `wss://host/ws/pitwall` on load
- Show online/offline status dots (green = online, gray = offline) from `activeDrivers` list
- When clicking a driver card, send `{ type: 'view-driver', driverId: N }`
- Display a connection status indicator (connecting/connected/disconnected)

No overlay iframes in this phase — just the driver list with live status and selection. Phase 4 adds the overlay iframes.

## Error Handling

- Auth timeout: close connection after 10 seconds if no auth message
- Invalid JSON: ignore message
- Bridge disconnect: clean up driver data and notify viewers
- Pitwall disconnect: clean up viewer subscriptions
- Server restart: all connections lost, clients reconnect (Phase 5 adds reconnection logic)

## Cookie Parsing

Parse the `session` cookie from the upgrade request's `cookie` header. Use the same cookie name as the Express session middleware. Look up the session in `db.getSession(sid)` to get `racing_user_id`.

```javascript
function parseSessionCookie(req) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/(?:^|;\s*)session=([^;]+)/);
  return match ? match[1] : null;
}
```

## Module Interface

```javascript
// src/services/pitwallRelay.js
module.exports = {
  init(httpServer),        // attach WS servers to HTTP server
  getActiveDrivers(teamId), // returns [{userId, username}] for online drivers
  getDriverCount(),         // total connected bridges (for admin/stats)
  getViewerCount(),         // total connected pitwall viewers
};
```
