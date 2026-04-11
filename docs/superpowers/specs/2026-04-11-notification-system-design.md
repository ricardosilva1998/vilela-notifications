# Racing Notification System Design Spec

## Overview

Persistent notification system for Racing users. Notifications are stored in the database, shown via a bell icon in the header nav bar, and dismissable individually or all at once.

## Database

### `notifications` table

```sql
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES racing_users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  link TEXT,
  action_type TEXT,
  action_id INTEGER,
  is_read INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT (datetime('now'))
)
```

Index on `user_id` + `is_read` for fast unread counts. Index on `created_at` for cleanup.

Dismissed notifications are hard-deleted (not soft-deleted). Auto-cleanup: delete notifications older than 30 days on startup and periodically.

## Notification Types

| Type | Trigger Location | Title | Message Example | Link | Inline Action |
|------|-----------------|-------|-----------------|------|---------------|
| `team_invite` | `createTeamInvite()` in db.js | Team invite | "Ricardo invited you to Team Alpha" | `/racing/team` | Accept / Decline (action_type='team_invite', action_id=invite.id) |
| `team_join` | `acceptTeamInvite()` / `joinTeamByCode()` in db.js | Teammate joined | "João joined the team" | `/racing/team` | No |
| `team_leave` | Leave/kick routes in racing-team.js | Teammate left | "João left the team" | `/racing/team` | No |
| `race_result` | `updateSessionFinish()` when session_type='race' in db.js/API | Race result | "P3 at Watkins Glen — VRS Sprint (+47 iR)" | `/api/session/:id` | No |
| `irating_milestone` | `updateSessionFinish()` when iRating crosses a threshold | iRating milestone | "You reached 2000 iRating!" | `/racing/account` | No |
| `bridge_update` | Admin panel button | Bridge update | "Atleta Bridge v3.16 is available — update in the app" | null | No |
| `announcement` | Admin panel form | (custom) | (custom) | (optional custom link) | No |
| `session_shared` | When a teammate sets a session to public | Session shared | "Ricardo shared a race session at Spa" | `/api/session/:id` | No |

### iRating Milestones

Thresholds: 1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000. Triggered when a race result's `irating_change` pushes the driver's total across a threshold. Only fires once per threshold (check if notification with same type+message already exists for user).

## Header Bell UI

Replaces the current live-query team invite approach in the session middleware and header.ejs.

- Bell icon in nav-right, left of user avatar (already exists — refactor to use stored notifications)
- Red badge shows unread count (notifications where is_read=0)
- Click opens dropdown (320px wide, max-height 400px, scrollable)
- Dropdown header: "Notifications" on left, "Dismiss all" link on right
- Each notification item shows:
  - Unread blue dot (left) if is_read=0
  - Icon per type (team=people, race=flag, irating=trophy, bridge=download, announcement=megaphone, session=share)
  - Title (bold) + message
  - Time ago (e.g., "2h ago")
  - Dismiss X button (right)
  - For action_type='team_invite': Accept/Decline buttons below message
- Clicking a notification (not on dismiss/action buttons) navigates to its link and marks it read
- Empty state: "No notifications"

## API Endpoints

All behind racing auth wall, mounted in racing-team.js or a new racing-notifications route:

- `POST /racing/notifications/:id/read` — mark single notification as read
- `POST /racing/notifications/:id/dismiss` — delete single notification
- `POST /racing/notifications/dismiss-all` — delete all notifications for user
- `GET /racing/notifications/count` — returns `{ count: N }` for unread count (for future polling/SPA use)

## Admin Panel

New section in Racing Admin (`/racing/admin`):

### Send Announcement
- Title input (required)
- Message textarea (required)
- Link input (optional)
- "Send to all" button — creates a notification for every racing user

### Bridge Update Notification
- Version string input (e.g., "3.16")
- Message input (optional, defaults to "Atleta Bridge vX.XX is available — update in the app")
- "Notify users" button — creates a notification for every racing user that has a bridge_id

## Notification Creation Helper

A `createNotification(userId, type, title, message, link, actionType, actionId)` function in db.js. Also a `createNotificationForAllUsers(type, title, message, link)` and `createNotificationForBridgeUsers(type, title, message, link)` for admin broadcast.

A `notifyTeamMembers(teamId, excludeUserId, type, title, message, link)` helper for team-scoped notifications (sends to all team members except the actor).

## Trigger Integration Points

- **Team invite created** (`src/routes/racing-team.js` POST `/invite`): call `createNotification(target.id, 'team_invite', ...)`
- **Team invite accepted** (`src/routes/racing-team.js` POST `/invite/:id/accept`): call `notifyTeamMembers(...)` with 'team_join'
- **Join by code** (`src/routes/racing-team.js` GET `/join/:code`): call `notifyTeamMembers(...)` with 'team_join'
- **Member kicked** (`src/routes/racing-team.js` POST `/kick/:userId`): create notification for kicked user + `notifyTeamMembers(...)` with 'team_leave'
- **Member left** (`src/routes/racing-team.js` POST `/leave`): call `notifyTeamMembers(...)` with 'team_leave'
- **Race finished** (`src/routes/api.js` PATCH `/api/session/:id/finish`): create 'race_result' for the user, check irating milestone
- **Session made public** (`src/routes/api.js` or racing.js where `updateSessionPublic` is called): create 'session_shared' for teammates
- **Admin announcement/bridge update** (`src/routes/racing.js` admin section): broadcast to all users / bridge users

## Cleanup

On server startup and every 24 hours: `DELETE FROM notifications WHERE created_at < datetime('now', '-30 days')`.

## Migration from Current System

Remove the live `getPendingInvitesForUser` call from the session middleware in server.js. Replace `res.locals.notifications` with a query for unread notifications from the `notifications` table. Update header.ejs to render from stored notifications instead of the current invite-specific format.
