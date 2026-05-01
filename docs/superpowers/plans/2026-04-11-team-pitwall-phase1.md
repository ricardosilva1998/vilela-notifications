# Team Pitwall Phase 1 — Database + Team Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Racing users create a team, invite teammates by username, accept/decline invites, join via invite code, and manage membership — all through a web UI.

**Architecture:** Three new DB tables (`teams`, `team_members`, `team_invites`) in `src/db.js`. One new route file (`src/routes/racing-team.js`) mounted at `/racing/team` behind the existing Racing auth wall. One new EJS view (`src/views/racing-team.ejs`). Dashboard quick-link card added. Each user can be in at most one team.

**Tech Stack:** Express v5 routes, better-sqlite3 queries, EJS server-rendered views, existing CSS design system.

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/db.js` | 3 new tables, indexes, 12 query functions |
| Create | `src/routes/racing-team.js` | 9 route handlers for team CRUD |
| Create | `src/views/racing-team.ejs` | Team dashboard UI |
| Modify | `src/views/racing-dashboard.ejs` | Add "My Team" quick-link card |
| Modify | `src/server.js` | Mount `/racing/team` routes |

---

### Task 1: Database Tables + Query Functions

**Files:**
- Modify: `src/db.js` (add tables after line ~986, add query functions before `module.exports`, add exports)

- [ ] **Step 1: Add the three team tables after the `auth_log` table creation block (~line 986)**

Add this code after `try { db.exec('CREATE INDEX IF NOT EXISTS idx_auth_log_ip ON auth_log(ip)'); } catch(e) {}`:

```javascript
// ── Teams (Pitwall Phase 1) ───────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES racing_users(id),
    invite_code TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS team_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES racing_users(id),
    role TEXT NOT NULL DEFAULT 'member',
    joined_at DATETIME DEFAULT (datetime('now')),
    UNIQUE(team_id, user_id)
  )
`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id)'); } catch(e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS team_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    invited_user_id INTEGER NOT NULL REFERENCES racing_users(id),
    invited_by INTEGER NOT NULL REFERENCES racing_users(id),
    status TEXT NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT (datetime('now'))
  )
`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_team_invites_user ON team_invites(invited_user_id)'); } catch(e) {}
```

- [ ] **Step 2: Add prepared statements and query functions**

Add these before the `module.exports = {` block:

```javascript
// ── Team queries ──────────────────────────────────────────────────
const _getTeamById = db.prepare('SELECT * FROM teams WHERE id = ?');
const _getTeamByOwnerId = db.prepare('SELECT * FROM teams WHERE owner_id = ?');
const _getTeamMembership = db.prepare(`
  SELECT tm.*, t.name AS team_name, t.owner_id, t.invite_code
  FROM team_members tm JOIN teams t ON tm.team_id = t.id
  WHERE tm.user_id = ?
`);
const _getTeamMembers = db.prepare(`
  SELECT tm.*, ru.username, ru.display_name, ru.iracing_name, ru.avatar, ru.bridge_id
  FROM team_members tm JOIN racing_users ru ON tm.user_id = ru.id
  WHERE tm.team_id = ? ORDER BY tm.role = 'owner' DESC, tm.joined_at ASC
`);
const _getPendingInvitesForUser = db.prepare(`
  SELECT ti.*, t.name AS team_name, inv.username AS invited_by_name
  FROM team_invites ti
  JOIN teams t ON ti.team_id = t.id
  JOIN racing_users inv ON ti.invited_by = inv.id
  WHERE ti.invited_user_id = ? AND ti.status = 'pending'
`);
const _getPendingInvitesForTeam = db.prepare(`
  SELECT ti.*, ru.username AS invited_username
  FROM team_invites ti JOIN racing_users ru ON ti.invited_user_id = ru.id
  WHERE ti.team_id = ? AND ti.status = 'pending'
`);
const _getTeamInviteById = db.prepare('SELECT * FROM team_invites WHERE id = ?');
const _insertTeam = db.prepare('INSERT INTO teams (name, owner_id, invite_code) VALUES (?, ?, ?)');
const _insertTeamMember = db.prepare('INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)');
const _insertTeamInvite = db.prepare('INSERT INTO team_invites (team_id, invited_user_id, invited_by) VALUES (?, ?, ?)');
const _updateTeamInviteStatus = db.prepare('UPDATE team_invites SET status = ? WHERE id = ?');
const _deleteTeamMember = db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?');
const _deleteTeam = db.prepare('DELETE FROM teams WHERE id = ?');
const _getTeamByInviteCode = db.prepare('SELECT * FROM teams WHERE invite_code = ?');
const _hasPendingInvite = db.prepare('SELECT id FROM team_invites WHERE team_id = ? AND invited_user_id = ? AND status = \'pending\'');
const _countTeamMembers = db.prepare('SELECT COUNT(*) AS count FROM team_members WHERE team_id = ?');

function createTeam(name, ownerId) {
  const code = require('crypto').randomBytes(4).toString('hex');
  const result = _insertTeam.run(name, ownerId, code);
  _insertTeamMember.run(result.lastInsertRowid, ownerId, 'owner');
  return result.lastInsertRowid;
}

function getTeamForUser(userId) {
  return _getTeamMembership.get(userId) || null;
}

function getTeamMembers(teamId) {
  return _getTeamMembers.all(teamId);
}

function getPendingInvitesForUser(userId) {
  return _getPendingInvitesForUser.all(userId);
}

function getPendingInvitesForTeam(teamId) {
  return _getPendingInvitesForTeam.all(teamId);
}

function getTeamInviteById(id) {
  return _getTeamInviteById.get(id) || null;
}

function createTeamInvite(teamId, invitedUserId, invitedBy) {
  const existing = _hasPendingInvite.get(teamId, invitedUserId);
  if (existing) return null;
  return _insertTeamInvite.run(teamId, invitedUserId, invitedBy).lastInsertRowid;
}

function acceptTeamInvite(inviteId) {
  const invite = _getTeamInviteById.get(inviteId);
  if (!invite || invite.status !== 'pending') return false;
  // Check user isn't already in a team
  const existing = _getTeamMembership.get(invite.invited_user_id);
  if (existing) return false;
  _updateTeamInviteStatus.run('accepted', inviteId);
  _insertTeamMember.run(invite.team_id, invite.invited_user_id, 'member');
  return true;
}

function declineTeamInvite(inviteId) {
  _updateTeamInviteStatus.run('declined', inviteId);
}

function removeTeamMember(teamId, userId) {
  _deleteTeamMember.run(teamId, userId);
}

function deleteTeam(teamId) {
  _deleteTeam.run(teamId);
}

function joinTeamByCode(code, userId) {
  const team = _getTeamByInviteCode.get(code);
  if (!team) return null;
  const existing = _getTeamMembership.get(userId);
  if (existing) return null;
  _insertTeamMember.run(team.id, userId, 'member');
  return team;
}

function getTeamById(teamId) {
  return _getTeamById.get(teamId) || null;
}

function getTeamMemberCount(teamId) {
  return _countTeamMembers.get(teamId).count;
}
```

- [ ] **Step 3: Add exports to `module.exports`**

Add these entries to the `module.exports` object (after the existing racing user exports):

```javascript
  createTeam,
  getTeamForUser,
  getTeamMembers,
  getPendingInvitesForUser,
  getPendingInvitesForTeam,
  getTeamInviteById,
  createTeamInvite,
  acceptTeamInvite,
  declineTeamInvite,
  removeTeamMember,
  deleteTeam: deleteTeamFn,
  joinTeamByCode,
  getTeamById,
  getTeamMemberCount,
```

**Important:** The existing `module.exports` already has a `deleteTeam` (but it does not — verify). If there's a name collision, rename the team function to `deleteTeamFn` in the function definition and export as `deleteTeam: deleteTeamFn`. Actually — there's no existing `deleteTeam` in the exports. But the local function name `deleteTeam` shadows the `_deleteTeam` prepared statement. So rename the function:

```javascript
function deleteTeamById(teamId) {
  _deleteTeam.run(teamId);
}
```

And export as:
```javascript
  deleteTeamById,
```

- [ ] **Step 4: Verify the app starts with new tables**

Run: `npm run dev`
Expected: Server starts without errors. Check console for no SQL errors.

- [ ] **Step 5: Commit**

```bash
git add src/db.js
git commit -m "feat(pitwall): add teams, team_members, team_invites tables + query functions"
```

---

### Task 2: Team Routes

**Files:**
- Create: `src/routes/racing-team.js`

- [ ] **Step 1: Create the route file with all 9 handlers**

Create `src/routes/racing-team.js`:

```javascript
const express = require('express');
const db = require('../db');
const router = express.Router();

// All routes require Racing login (auth wall is in racing.js before this is mounted)

// GET /racing/team — team dashboard
router.get('/', (req, res) => {
  const membership = db.getTeamForUser(req.racingUser.id);
  const pendingInvites = db.getPendingInvitesForUser(req.racingUser.id);

  if (!membership) {
    return res.render('racing-team', {
      streamer: req.streamer || null,
      racingUser: req.racingUser,
      team: null,
      members: [],
      teamInvites: [],
      pendingInvites,
      error: req.query.error || null,
      msg: req.query.msg || null,
    });
  }

  const members = db.getTeamMembers(membership.team_id);
  const teamInvites = membership.role === 'owner' ? db.getPendingInvitesForTeam(membership.team_id) : [];

  res.render('racing-team', {
    streamer: req.streamer || null,
    racingUser: req.racingUser,
    team: membership,
    members,
    teamInvites,
    pendingInvites,
    error: req.query.error || null,
    msg: req.query.msg || null,
  });
});

// POST /racing/team/create
router.post('/create', (req, res) => {
  const name = (req.body.team_name || '').trim();
  if (!name || name.length < 2 || name.length > 40) {
    return res.redirect('/racing/team?error=' + encodeURIComponent('Team name must be 2-40 characters'));
  }
  // Check user isn't already in a team
  const existing = db.getTeamForUser(req.racingUser.id);
  if (existing) {
    return res.redirect('/racing/team?error=' + encodeURIComponent('You are already in a team'));
  }
  db.createTeam(name, req.racingUser.id);
  res.redirect('/racing/team?msg=' + encodeURIComponent('Team created!'));
});

// POST /racing/team/invite — invite by username
router.post('/invite', (req, res) => {
  const username = (req.body.username || '').trim();
  if (!username) {
    return res.redirect('/racing/team?error=' + encodeURIComponent('Username required'));
  }
  const membership = db.getTeamForUser(req.racingUser.id);
  if (!membership || membership.role !== 'owner') {
    return res.redirect('/racing/team?error=' + encodeURIComponent('Only the team owner can invite'));
  }
  const target = db.getRacingUserByUsername(username);
  if (!target) {
    return res.redirect('/racing/team?error=' + encodeURIComponent('User not found'));
  }
  if (target.id === req.racingUser.id) {
    return res.redirect('/racing/team?error=' + encodeURIComponent('Cannot invite yourself'));
  }
  const targetMembership = db.getTeamForUser(target.id);
  if (targetMembership) {
    return res.redirect('/racing/team?error=' + encodeURIComponent('That user is already in a team'));
  }
  const result = db.createTeamInvite(membership.team_id, target.id, req.racingUser.id);
  if (!result) {
    return res.redirect('/racing/team?error=' + encodeURIComponent('Invite already pending'));
  }
  res.redirect('/racing/team?msg=' + encodeURIComponent('Invite sent to ' + target.username));
});

// POST /racing/team/invite/:id/accept
router.post('/invite/:id/accept', (req, res) => {
  const invite = db.getTeamInviteById(parseInt(req.params.id));
  if (!invite || invite.invited_user_id !== req.racingUser.id || invite.status !== 'pending') {
    return res.redirect('/racing/team?error=' + encodeURIComponent('Invalid invite'));
  }
  const ok = db.acceptTeamInvite(invite.id);
  if (!ok) {
    return res.redirect('/racing/team?error=' + encodeURIComponent('Could not accept invite — you may already be in a team'));
  }
  res.redirect('/racing/team?msg=' + encodeURIComponent('Welcome to the team!'));
});

// POST /racing/team/invite/:id/decline
router.post('/invite/:id/decline', (req, res) => {
  const invite = db.getTeamInviteById(parseInt(req.params.id));
  if (!invite || invite.invited_user_id !== req.racingUser.id || invite.status !== 'pending') {
    return res.redirect('/racing/team?error=' + encodeURIComponent('Invalid invite'));
  }
  db.declineTeamInvite(invite.id);
  res.redirect('/racing/team?msg=' + encodeURIComponent('Invite declined'));
});

// POST /racing/team/kick/:userId — remove member (owner only)
router.post('/kick/:userId', (req, res) => {
  const membership = db.getTeamForUser(req.racingUser.id);
  if (!membership || membership.role !== 'owner') {
    return res.redirect('/racing/team?error=' + encodeURIComponent('Only the team owner can remove members'));
  }
  const targetId = parseInt(req.params.userId);
  if (targetId === req.racingUser.id) {
    return res.redirect('/racing/team?error=' + encodeURIComponent('Cannot remove yourself — use delete team'));
  }
  db.removeTeamMember(membership.team_id, targetId);
  res.redirect('/racing/team?msg=' + encodeURIComponent('Member removed'));
});

// POST /racing/team/leave
router.post('/leave', (req, res) => {
  const membership = db.getTeamForUser(req.racingUser.id);
  if (!membership) {
    return res.redirect('/racing/team');
  }
  if (membership.role === 'owner') {
    return res.redirect('/racing/team?error=' + encodeURIComponent('Owner cannot leave — delete the team or transfer ownership'));
  }
  db.removeTeamMember(membership.team_id, req.racingUser.id);
  res.redirect('/racing/team?msg=' + encodeURIComponent('You left the team'));
});

// POST /racing/team/delete — delete team (owner only)
router.post('/delete', (req, res) => {
  const membership = db.getTeamForUser(req.racingUser.id);
  if (!membership || membership.role !== 'owner') {
    return res.redirect('/racing/team?error=' + encodeURIComponent('Only the team owner can delete the team'));
  }
  db.deleteTeamById(membership.team_id);
  res.redirect('/racing/team?msg=' + encodeURIComponent('Team deleted'));
});

// GET /racing/team/join/:code — join via invite code
router.get('/join/:code', (req, res) => {
  const existing = db.getTeamForUser(req.racingUser.id);
  if (existing) {
    return res.redirect('/racing/team?error=' + encodeURIComponent('You are already in a team'));
  }
  const team = db.joinTeamByCode(req.params.code, req.racingUser.id);
  if (!team) {
    return res.redirect('/racing/team?error=' + encodeURIComponent('Invalid invite code or you are already in a team'));
  }
  res.redirect('/racing/team?msg=' + encodeURIComponent('Joined ' + team.name + '!'));
});

module.exports = router;
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/racing-team.js
git commit -m "feat(pitwall): add team management routes — create, invite, accept, kick, leave, delete, join"
```

---

### Task 3: Mount Team Routes in Server

**Files:**
- Modify: `src/server.js:149-152`

- [ ] **Step 1: Add the team route import and mount**

In `src/server.js`, after line 150 (`const racingRoutes = require('./routes/racing');`), add:

```javascript
const racingTeamRoutes = require('./routes/racing-team');
```

After line 152 (`app.use('/racing', racingRoutes);`), add:

```javascript
app.use('/racing/team', (req, res, next) => {
  if (!req.racingUser) return res.redirect('/racing');
  next();
}, racingTeamRoutes);
```

**Note:** The team routes must be mounted BEFORE the general `/racing` routes would catch them, but since Express v5 is prefix-based and `/racing/team` is more specific, mounting right after `/racing` works. Actually — `/racing/team` routes go through the `/racing` router first. The `/racing` router has an auth wall at line 37 (`router.use(...)`) but the `GET /` handler runs before it and won't match `/team`. So we need to mount `/racing/team` as a separate top-level mount BEFORE `/racing`:

Change the mount order in `src/server.js`. The final order should be:

```javascript
const racingAuthRoutes = require('./routes/racing-auth');
const racingRoutes = require('./routes/racing');
const racingTeamRoutes = require('./routes/racing-team');
app.use('/racing/auth', authLimiter, racingAuthRoutes);
app.use('/racing/team', (req, res, next) => {
  if (!req.racingUser) return res.redirect('/racing');
  next();
}, racingTeamRoutes);
app.use('/racing', racingRoutes);
```

- [ ] **Step 2: Verify server starts**

Run: `npm run dev`
Expected: No errors on startup.

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "feat(pitwall): mount /racing/team routes with auth wall"
```

---

### Task 4: Team Dashboard View

**Files:**
- Create: `src/views/racing-team.ejs`

- [ ] **Step 1: Create the team dashboard EJS view**

Create `src/views/racing-team.ejs`:

```html
<%- include('header', { title: 'Team — Atleta', streamer: streamer }) %>
<div style="padding:24px 0;max-width:800px;">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
    <div>
      <h1 style="font-size:28px;font-weight:800;margin-bottom:4px;">My Team</h1>
      <p style="color:var(--text-secondary);font-size:14px;">
        <a href="/racing" style="color:var(--text-muted);text-decoration:none;">&larr; Racing</a>
      </p>
    </div>
  </div>

  <% if (error) { %>
    <div style="background:rgba(240,68,56,0.1);border:1px solid rgba(240,68,56,0.2);border-radius:8px;padding:12px 16px;margin-bottom:16px;color:#f04438;font-size:13px;"><%= error %></div>
  <% } %>
  <% if (msg) { %>
    <div style="background:rgba(62,207,142,0.1);border:1px solid rgba(62,207,142,0.2);border-radius:8px;padding:12px 16px;margin-bottom:16px;color:#3ecf8e;font-size:13px;"><%= msg %></div>
  <% } %>

  <% if (pendingInvites && pendingInvites.length > 0) { %>
    <div class="card" style="padding:20px;margin-bottom:20px;border:1px solid rgba(247,201,72,0.2);">
      <h3 style="font-size:15px;font-weight:700;margin-bottom:12px;color:#f7c948;">Pending Invites</h3>
      <% pendingInvites.forEach(function(inv) { %>
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
          <div>
            <span style="font-weight:600;"><%= inv.team_name %></span>
            <span style="color:var(--text-muted);font-size:12px;margin-left:8px;">invited by <%= inv.invited_by_name %></span>
          </div>
          <div style="display:flex;gap:8px;">
            <form method="POST" action="/racing/team/invite/<%= inv.id %>/accept" style="margin:0;">
              <button type="submit" style="background:#3ecf8e;color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;">Accept</button>
            </form>
            <form method="POST" action="/racing/team/invite/<%= inv.id %>/decline" style="margin:0;">
              <button type="submit" style="background:rgba(240,68,56,0.15);color:#f04438;border:none;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;">Decline</button>
            </form>
          </div>
        </div>
      <% }); %>
    </div>
  <% } %>

  <% if (!team) { %>
    <!-- No team — create or join -->
    <div class="card" style="padding:32px;text-align:center;margin-bottom:20px;">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5" style="margin-bottom:12px;">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
      <h3 style="font-size:16px;font-weight:700;margin-bottom:4px;">No Team Yet</h3>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:20px;">Create a team or join one with an invite code.</p>

      <div style="display:flex;gap:16px;justify-content:center;flex-wrap:wrap;">
        <form method="POST" action="/racing/team/create" style="display:flex;gap:8px;align-items:center;">
          <input type="text" name="team_name" placeholder="Team name" required minlength="2" maxlength="40"
            style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:8px 12px;color:var(--text-primary);font-size:13px;width:180px;">
          <button type="submit" style="background:var(--accent);color:#fff;border:none;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;">Create Team</button>
        </form>
      </div>

      <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border);">
        <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px;">Have an invite code?</p>
        <form style="display:flex;gap:8px;justify-content:center;align-items:center;" onsubmit="event.preventDefault(); var c = this.querySelector('input').value.trim(); if(c) window.location='/racing/team/join/' + encodeURIComponent(c);">
          <input type="text" placeholder="Paste invite code" style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:8px 12px;color:var(--text-primary);font-size:13px;width:160px;">
          <button type="submit" style="background:rgba(62,207,142,0.15);color:#3ecf8e;border:none;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;">Join</button>
        </form>
      </div>
    </div>
  <% } else { %>
    <!-- Team info -->
    <div class="card" style="padding:20px;margin-bottom:20px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <div>
          <h2 style="font-size:20px;font-weight:800;"><%= team.team_name %></h2>
          <p style="color:var(--text-muted);font-size:12px;"><%= members.length %> member<%= members.length !== 1 ? 's' : '' %></p>
        </div>
        <% if (team.role === 'owner') { %>
          <div style="display:flex;gap:8px;align-items:center;">
            <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:6px 12px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text-secondary);user-select:all;cursor:text;" title="Share this code to invite teammates"><%= team.invite_code %></div>
            <button onclick="navigator.clipboard.writeText('<%= team.invite_code %>');this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)" style="background:rgba(145,70,255,0.15);color:var(--accent);border:none;border-radius:6px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;">Copy</button>
          </div>
        <% } %>
      </div>

      <!-- Members list -->
      <div style="border-top:1px solid var(--border);padding-top:12px;">
        <% members.forEach(function(m) { %>
          <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.03);">
            <div style="display:flex;align-items:center;gap:10px;">
              <div style="width:32px;height:32px;border-radius:50%;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;">
                <% if (m.avatar) { %>
                  <img src="<%= m.avatar %>" style="width:100%;height:100%;object-fit:cover;">
                <% } else { %>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="var(--text-muted)"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>
                <% } %>
              </div>
              <div>
                <span style="font-weight:600;font-size:14px;"><%= m.display_name || m.username %></span>
                <% if (m.iracing_name) { %><span style="color:var(--text-muted);font-size:11px;margin-left:6px;"><%= m.iracing_name %></span><% } %>
                <% if (m.role === 'owner') { %>
                  <span style="background:rgba(247,201,72,0.15);color:#f7c948;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;margin-left:6px;">OWNER</span>
                <% } %>
              </div>
            </div>
            <% if (team.role === 'owner' && m.user_id !== racingUser.id) { %>
              <form method="POST" action="/racing/team/kick/<%= m.user_id %>" style="margin:0;" onsubmit="return confirm('Remove <%= m.username %> from the team?')">
                <button type="submit" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:11px;padding:4px 8px;border-radius:4px;transition:all 0.15s;" onmouseover="this.style.color='#f04438';this.style.background='rgba(240,68,56,0.1)'" onmouseout="this.style.color='var(--text-muted)';this.style.background='none'">&times; Remove</button>
              </form>
            <% } %>
          </div>
        <% }); %>
      </div>
    </div>

    <% if (team.role === 'owner') { %>
      <!-- Invite form -->
      <div class="card" style="padding:20px;margin-bottom:20px;">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:12px;">Invite Teammate</h3>
        <form method="POST" action="/racing/team/invite" style="display:flex;gap:8px;align-items:center;">
          <input type="text" name="username" placeholder="Racing username" required
            style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:8px 12px;color:var(--text-primary);font-size:13px;flex:1;">
          <button type="submit" style="background:var(--accent);color:#fff;border:none;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;">Send Invite</button>
        </form>

        <% if (teamInvites && teamInvites.length > 0) { %>
          <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px;">
            <p style="color:var(--text-muted);font-size:11px;margin-bottom:8px;">Pending invites:</p>
            <% teamInvites.forEach(function(ti) { %>
              <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;">
                <span style="font-size:13px;"><%= ti.invited_username %></span>
                <span style="color:var(--text-muted);font-size:11px;">pending</span>
              </div>
            <% }); %>
          </div>
        <% } %>
      </div>

      <!-- Invite code share -->
      <div class="card" style="padding:20px;margin-bottom:20px;">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:8px;">Invite Link</h3>
        <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px;">Share this link — anyone with a Racing account can join your team directly.</p>
        <div style="display:flex;gap:8px;align-items:center;">
          <input type="text" readonly value="<%= typeof APP_URL !== 'undefined' ? APP_URL : '' %>/racing/team/join/<%= team.invite_code %>" id="invite-link"
            style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:8px 12px;color:var(--text-secondary);font-size:12px;flex:1;font-family:'JetBrains Mono',monospace;"
            onclick="this.select()">
          <button onclick="navigator.clipboard.writeText(document.getElementById('invite-link').value);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy Link',1500)"
            style="background:rgba(145,70,255,0.15);color:var(--accent);border:none;border-radius:6px;padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;">Copy Link</button>
        </div>
      </div>
    <% } %>

    <!-- Leave / Delete -->
    <div style="display:flex;gap:12px;margin-top:8px;">
      <% if (team.role !== 'owner') { %>
        <form method="POST" action="/racing/team/leave" onsubmit="return confirm('Leave the team?')">
          <button type="submit" style="background:rgba(240,68,56,0.1);color:#f04438;border:1px solid rgba(240,68,56,0.2);border-radius:6px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;">Leave Team</button>
        </form>
      <% } else { %>
        <form method="POST" action="/racing/team/delete" onsubmit="return confirm('Delete the team? This cannot be undone.')">
          <button type="submit" style="background:rgba(240,68,56,0.1);color:#f04438;border:1px solid rgba(240,68,56,0.2);border-radius:6px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;">Delete Team</button>
        </form>
      <% } %>
    </div>
  <% } %>
</div>
<%- include('footer') %>
```

- [ ] **Step 2: Pass APP_URL to the view from the route**

In `src/routes/racing-team.js`, update the two `res.render` calls to include `APP_URL`:

In the `router.get('/')` handler, add `APP_URL: process.env.APP_URL || ''` to both render calls. For the team-exists render:

```javascript
  res.render('racing-team', {
    streamer: req.streamer || null,
    racingUser: req.racingUser,
    team: membership,
    members,
    teamInvites,
    pendingInvites,
    error: req.query.error || null,
    msg: req.query.msg || null,
    APP_URL: process.env.APP_URL || '',
  });
```

And for the no-team render:

```javascript
    return res.render('racing-team', {
      streamer: req.streamer || null,
      racingUser: req.racingUser,
      team: null,
      members: [],
      teamInvites: [],
      pendingInvites,
      error: req.query.error || null,
      msg: req.query.msg || null,
      APP_URL: process.env.APP_URL || '',
    });
```

- [ ] **Step 3: Commit**

```bash
git add src/views/racing-team.ejs src/routes/racing-team.js
git commit -m "feat(pitwall): add team dashboard view with create/join/invite/kick/leave UI"
```

---

### Task 5: Add Team Quick-Link to Racing Dashboard

**Files:**
- Modify: `src/views/racing-dashboard.ejs:11-47` (quick links grid)
- Modify: `src/routes/racing.js:7-24` (pass team data to view)

- [ ] **Step 1: Pass team membership to the dashboard view**

In `src/routes/racing.js`, inside the `router.get('/')` handler where `req.racingUser` is truthy (around line 9), add before the `return res.render`:

```javascript
    const teamMembership = db.getTeamForUser(req.racingUser.id);
    const pendingTeamInvites = db.getPendingInvitesForUser(req.racingUser.id);
```

Update the render call to include both:

```javascript
    return res.render('racing-dashboard', {
      streamer: req.streamer || null,
      racingUser: req.racingUser,
      sessions: recentSessions,
      team: teamMembership,
      pendingTeamInvites: pendingTeamInvites,
    });
```

- [ ] **Step 2: Add the Team quick-link card in the dashboard grid**

In `src/views/racing-dashboard.ejs`, after the Account card (line 33, before the `<% if (isAdmin) { %>` block), add:

```html
    <a href="/racing/team" class="card" style="padding:16px;text-decoration:none;color:inherit;<%= (typeof pendingTeamInvites !== 'undefined' && pendingTeamInvites && pendingTeamInvites.length > 0) ? 'border:1px solid rgba(247,201,72,0.3);' : '' %>">
      <div style="display:flex;align-items:center;gap:10px;">
        <div style="width:36px;height:36px;border-radius:8px;background:rgba(59,130,246,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        </div>
        <div>
          <h3 style="font-size:14px;margin-bottom:2px;">
            My Team
            <% if (typeof pendingTeamInvites !== 'undefined' && pendingTeamInvites && pendingTeamInvites.length > 0) { %>
              <span style="background:#f7c948;color:#000;font-size:10px;font-weight:700;padding:1px 5px;border-radius:8px;margin-left:4px;"><%= pendingTeamInvites.length %></span>
            <% } %>
          </h3>
          <p style="color:var(--text-muted);font-size:11px;">
            <% if (typeof team !== 'undefined' && team) { %><%= team.team_name %><% } else { %>Create or join a team<% } %>
          </p>
        </div>
      </div>
    </a>
```

- [ ] **Step 3: Verify the full flow in the browser**

Run: `npm run dev`
Navigate to `/racing` (logged in). Verify:
1. Team quick-link card appears in the grid
2. Clicking it goes to `/racing/team`
3. Can create a team
4. Invite code is shown
5. Can copy the invite link

- [ ] **Step 4: Commit**

```bash
git add src/routes/racing.js src/views/racing-dashboard.ejs
git commit -m "feat(pitwall): add My Team quick-link card to racing dashboard with invite badge"
```

---

### Task 6: Manual Testing & Edge Cases

- [ ] **Step 1: Test team creation flow**

1. Log in as a Racing user, go to `/racing/team`
2. Create a team with name "Test Racing Team"
3. Verify team page shows: team name, you as owner, invite code

- [ ] **Step 2: Test invite code join flow**

1. Open a second browser / incognito with a different Racing account
2. Navigate to `/racing/team/join/<invite-code>`
3. Verify the second user joins the team
4. Verify both users appear in the members list

- [ ] **Step 3: Test invite by username flow**

1. As owner, type a third user's username in the invite form
2. Log in as that user, verify pending invite appears with yellow border
3. Accept the invite, verify team membership

- [ ] **Step 4: Test remove and leave flows**

1. As owner, remove a member — verify they disappear
2. As a non-owner member, leave the team — verify redirect

- [ ] **Step 5: Test delete team flow**

1. As owner, delete the team
2. Verify all members lose their team (cascade delete)

- [ ] **Step 6: Test edge cases**

1. Try creating a second team while already in one — should get error
2. Try joining via code while already in a team — should get error
3. Try inviting a user who's already in a team — should get error
4. Try inviting yourself — should get error
5. Owner tries to leave — should get error message

- [ ] **Step 7: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(pitwall): address edge cases found during manual testing"
```
