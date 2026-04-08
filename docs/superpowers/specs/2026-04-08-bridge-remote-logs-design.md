# Bridge Remote Logs & Bug Report Agent

## Overview

Enable the Atleta Bridge Electron app to upload logs to the server so they can be viewed from the web dashboard and analyzed by a scheduled Claude Code agent that detects potential bugs and proposes fixes for user review.

## Goals

1. Bridge uploads log lines to the server periodically (every 60s)
2. Users view their Bridge logs on the iRacing dashboard tab
3. Logs accessible via API for debugging sessions
4. Scheduled agent analyzes logs, identifies potential bugs, and stores findings
5. Users review agent findings on the iRacing tab — approve or dismiss each one
6. Approved fixes are implemented in the next dev session

## Architecture

```
Bridge (Windows)
  │
  │ POST /api/bridge-logs (every 60s, new lines since last upload)
  ▼
Server (Railway)
  │
  ├── bridge_logs table (7-day retention)
  ├── bridge_bug_reports table
  │
  ├── GET /api/bridge-logs/:bridgeId     ← API access for debugging
  ├── GET /api/bridge-bug-reports        ← dashboard reads findings
  ├── PATCH /api/bridge-bug-reports/:id  ← approve/dismiss from UI
  │
  ▼
Dashboard (iRacing tab)
  ├── Bridge Logs card (log viewer)
  └── Bug Reports card (findings list with approve/dismiss)

Scheduled Claude Code Agent (cron, every few hours)
  │
  ├── GET /api/bridge-logs/:bridgeId     ← fetches recent logs
  ├── Analyzes for error patterns
  └── POST /api/bridge-bug-reports       ← stores findings
```

## Database

### bridge_logs table

```sql
CREATE TABLE IF NOT EXISTS bridge_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bridge_id TEXT NOT NULL,
  lines TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bridge_logs_lookup
  ON bridge_logs (bridge_id, created_at);
```

- `bridge_id`: UUID generated on Bridge first launch
- `lines`: plain text batch of log lines (newline-separated)
- 7-day auto-cleanup alongside existing overlay event cleanup

### bridge_bug_reports table

```sql
CREATE TABLE IF NOT EXISTS bridge_bug_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bridge_id TEXT NOT NULL,
  error_pattern TEXT NOT NULL,
  explanation TEXT NOT NULL,
  suggested_fix TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bridge_bug_reports_lookup
  ON bridge_bug_reports (bridge_id, status);
```

- `status`: `pending` | `approved` | `dismissed`
- `error_pattern`: the log lines that triggered the finding
- `explanation`: why the agent thinks it's a bug
- `suggested_fix`: description of proposed code change

## API Endpoints

All endpoints are public (no auth), matching existing Bridge→Server pattern (track-map, track-stats, live-session).

### POST /api/bridge-logs

Upload a batch of log lines from the Bridge.

```json
{
  "bridgeId": "550e8400-e29b-41d4-a716-446655440000",
  "lines": "[2026-04-08T12:00:00Z] [TELEMETRY] connected to iRacing\n[2026-04-08T12:00:01Z] [MAIN] overlay opened\n..."
}
```

Response: `200 { ok: true }`

Validation: `bridgeId` required (string), `lines` required (string, max 1MB).

### GET /api/bridge-logs/:bridgeId

Fetch recent logs for a Bridge instance. Returns last 24h by default.

Query params:
- `hours` (optional, default 24, max 168) — how far back to fetch

Response:
```json
{
  "logs": [
    { "id": 1, "lines": "...", "created_at": "2026-04-08T12:00:00Z" },
    { "id": 2, "lines": "...", "created_at": "2026-04-08T12:01:00Z" }
  ]
}
```

### POST /api/bridge-bug-reports

Agent stores a finding.

```json
{
  "bridgeId": "550e8400-e29b-41d4-a716-446655440000",
  "errorPattern": "[2026-04-08T12:00:05Z] [TELEMETRY] Error: Cannot read property 'position' of undefined",
  "explanation": "The telemetry reader accesses driver.position without checking if the driver object exists. This happens when a driver disconnects mid-session and the standings array has a null entry.",
  "suggestedFix": "In bridge/telemetry.js, add a null check for driver objects in the standings loop before accessing .position. Filter out null/undefined entries from the drivers array."
}
```

Response: `200 { ok: true, id: 42 }`

### GET /api/bridge-bug-reports

Fetch bug reports. Used by dashboard.

Query params:
- `bridgeId` (required) — which Bridge instance
- `status` (optional) — filter by status (`pending`, `approved`, `dismissed`)

Response:
```json
{
  "reports": [
    {
      "id": 42,
      "error_pattern": "...",
      "explanation": "...",
      "suggested_fix": "...",
      "status": "pending",
      "created_at": "2026-04-08T14:00:00Z"
    }
  ]
}
```

### PATCH /api/bridge-bug-reports/:id

Update report status from dashboard.

```json
{
  "status": "approved"
}
```

Response: `200 { ok: true }`

## Bridge Changes

### settings.js — Bridge ID generation

On first load, if `settings.bridgeId` doesn't exist, generate a UUID and persist it:

```javascript
if (!settings.bridgeId) {
  settings.bridgeId = crypto.randomUUID();
  saveSettings();
}
```

### main.js — Log upload interval

New function `uploadLogs()`:
- Track last uploaded byte offset (in memory, reset to 0 on app start)
- Every 60s: read `~/atleta-bridge.log` from last offset
- If new content exists, POST to `/api/bridge-logs`
- Update offset on success
- Fail silently (log upload should never crash the app)

Uses native `https` module matching existing upload patterns (track-map, track-stats).

60s interval started alongside existing intervals in app ready handler.

### control-panel.html — Show Bridge ID

Add Bridge ID display in the Overview or About tab so users can find their ID for the dashboard. Small text, with copy button.

## Dashboard Changes

### dashboard.ejs — iRacing tab additions

Two new cards on the iRacing tab:

#### Bridge Logs Card

- Text input for Bridge ID (saved to localStorage for persistence)
- Log viewer area with monospace text, color-coded by log type:
  - Purple: `[VOICE]`, `[SPEECH]`
  - Red: `Error`, `error`, `ERR`
  - Green: `[TELEMETRY]`
  - Gray: `[DIAG]`
- Auto-refresh toggle (polls GET endpoint every 10s when active)
- "Copy All" button
- Shows last 24h by default

#### Bug Reports Card

- Shows reports for the entered Bridge ID
- Each report is a collapsible card:
  - Header: short summary (first line of error_pattern) + status badge + timestamp
  - Expanded: full error pattern (code block), explanation, suggested fix
  - Action buttons: "Approve" (green) / "Dismiss" (gray) — only shown for `pending` status
  - Approved items show green "Approved" badge
  - Dismissed items show gray "Dismissed" badge
- Reports sorted by created_at descending (newest first)
- Auto-refresh every 30s

## Scheduled Agent

A Claude Code scheduled agent (via `schedule` skill) that runs every 6 hours:

1. Fetches recent logs via `GET /api/bridge-logs/:bridgeId?hours=6`
2. Scans for error patterns: exceptions, stack traces, "Error:", "TypeError:", "ReferenceError:", unhandled rejections, repeated failures
3. Cross-references with the Bridge codebase to understand the likely cause
4. For each distinct error pattern found, checks existing bug reports to avoid duplicates
5. Creates a new report via `POST /api/bridge-bug-reports` with:
   - The relevant log lines
   - An explanation of what's likely going wrong and why
   - A concrete description of the code change needed to fix it

The agent needs to know which Bridge ID to monitor — this will be configured when setting up the schedule.

## Cleanup

Add to existing cleanup routine in `db.js` (or wherever overlay event cleanup runs):

```sql
DELETE FROM bridge_logs WHERE created_at < datetime('now', '-7 days');
DELETE FROM bridge_bug_reports WHERE status = 'dismissed' AND created_at < datetime('now', '-30 days');
```

Dismissed reports cleaned after 30 days. Approved/pending reports kept indefinitely (they represent actionable items).

## File Changes Summary

| File | Change |
|------|--------|
| `src/db.js` | Add `bridge_logs` + `bridge_bug_reports` tables, cleanup queries |
| `src/server.js` | Add 4 API endpoints (POST/GET logs, POST/GET/PATCH bug reports) |
| `src/views/dashboard.ejs` | Add Bridge Logs + Bug Reports cards to iRacing tab |
| `bridge/settings.js` | Generate `bridgeId` UUID on first launch |
| `bridge/main.js` | Add `uploadLogs()` on 60s interval |
| `bridge/control-panel.html` | Show Bridge ID in Overview/About |

## Out of Scope

- Authentication for Bridge endpoints (matches existing public pattern)
- Log line parsing/structuring server-side (stored as plain text)
- Auto-fixing code on approval (user triggers fix in dev session)
- Multiple Bridge instances per user (one UUID per install is sufficient)
