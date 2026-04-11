# Multi-Team Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to be in multiple teams simultaneously (max 5), with drivers choosing which teams receive their telemetry and pitwall viewers picking a team before entering.

**Architecture:** No schema migration needed — `team_members` table already supports multi-team via `UNIQUE(team_id, user_id)`. The single-team restriction is enforced purely in application code. We remove those guards, add a max-teams cap, update the relay to support multi-team broadcast, and build new UI for teams list + pitwall team picker.

**Tech Stack:** Node.js, Express, SQLite (better-sqlite3), EJS, WebSocket (ws), Electron (Bridge)

**Spec:** `docs/superpowers/specs/2026-04-11-multi-team-avatar-crop-design.md`

---

### Task 1: Add `getTeamsForUser()` and `countTeamsForUser()` to db.js

**Files:**
- Modify: `src/db.js:3723-3770` (team queries section)
- Modify: `src/db.js:4191-4204` (exports)

- [ ] **Step 1: Add prepared statement and functions**

After `_getTeamMembership` (line 3728), add:

```js
const _getTeamMemberships = db.prepare(`
  SELECT tm.*, t.name AS team_name, t.owner_id, t.invite_code
  FROM team_members tm JOIN teams t ON tm.team_id = t.id
  WHERE tm.user_id = ?
  ORDER BY tm.joined_at ASC
`);
const _countUserTeams = db.prepare('SELECT COUNT(*) AS count FROM team_members WHERE user_id = ?');
```

After `getTeamForUser()` (line 3770), add:

```js
function getTeamsForUser(userId) {
  return _getTeamMemberships.all(userId);
}

function countTeamsForUser(userId) {
  return _countUserTeams.get(userId).count;
}
```

- [ ] **Step 2: Export the new functions**

In the `module.exports` object (around line 4191), after `getTeamForUser,` add:

```js
  getTeamsForUser,
  countTeamsForUser,
```

- [ ] **Step 3: Remove single-team guard from `acceptTeamInvite()`**

Replace the function at line 3794-3805:

```js
function acceptTeamInvite(inviteId) {
  const txn = db.transaction(() => {
    const invite = _getTeamInviteById.get(inviteId);
    if (!invite || invite.status !== 'pending') return false;
    const teamCount = _countUserTeams.get(invite.invited_user_id).count;
    if (teamCount >= 5) return false;
    _updateTeamInviteStatus.run('accepted', inviteId);
    _insertTeamMember.run(invite.team_id, invite.invited_user_id, 'member');
    return true;
  });
  return txn();
}
```

- [ ] **Step 4: Remove single-team guard from `joinTeamByCode()`**

Replace the function at line 3819-3829:

```js
function joinTeamByCode(code, userId) {
  const txn = db.transaction(() => {
    const team = _getTeamByInviteCode.get(code);
    if (!team) return null;
    const teamCount = _countUserTeams.get(userId).count;
    if (teamCount >= 5) return null;
    _insertTeamMember.run(team.id, userId, 'member');
    return team;
  });
  return txn();
}
```

- [ ] **Step 5: Verify the app starts**

Run: `npm run dev` (Ctrl+C after startup)
Expected: No crashes, no SQL errors in console.

- [ ] **Step 6: Commit**

```bash
git add src/db.js
git commit -m "feat(teams): add getTeamsForUser/countTeamsForUser, replace single-team guards with max-5 cap"
```

---

### Task 2: Update racing-team routes for multi-team

**Files:**
- Modify: `src/routes/racing-team.js`

- [ ] **Step 1: Update `POST /create` to use max-teams cap**

Replace lines 43-53 (the create route):

```js
router.post('/create', (req, res) => {
  const name = (req.body.team_name || '').trim();
  if (!name || name.length < 2 || name.length > 40) {
    return res.redirect('/racing/teams?error=' + encodeURIComponent('Team name must be 2-40 characters'));
  }
  const teamCount = db.countTeamsForUser(req.racingUser.id);
  if (teamCount >= 5) {
    return res.redirect('/racing/teams?error=' + encodeURIComponent('You can be in a maximum of 5 teams'));
  }
  db.createTeam(name, req.racingUser.id);
  res.redirect('/racing/teams?msg=' + encodeURIComponent('Team created!'));
});
```

- [ ] **Step 2: Update `POST /invite` to remove single-team block for target**

Replace lines 57-83 (the invite route). Remove the `targetMembership` check entirely:

```js
router.post('/:teamId/invite', (req, res) => {
  const teamId = parseInt(req.params.teamId);
  const username = (req.body.username || '').trim();
  if (!username) {
    return res.redirect('/racing/teams/' + teamId + '?error=' + encodeURIComponent('Username required'));
  }
  const membership = db.getTeamsForUser(req.racingUser.id).find(t => t.team_id === teamId);
  if (!membership || membership.role !== 'owner') {
    return res.redirect('/racing/teams?error=' + encodeURIComponent('Only the team owner can invite'));
  }
  const target = db.getRacingUserByUsername(username);
  if (!target) {
    return res.redirect('/racing/teams/' + teamId + '?error=' + encodeURIComponent('User not found'));
  }
  if (target.id === req.racingUser.id) {
    return res.redirect('/racing/teams/' + teamId + '?error=' + encodeURIComponent('Cannot invite yourself'));
  }
  const targetTeamCount = db.countTeamsForUser(target.id);
  if (targetTeamCount >= 5) {
    return res.redirect('/racing/teams/' + teamId + '?error=' + encodeURIComponent('That user is already in 5 teams'));
  }
  const result = db.createTeamInvite(teamId, target.id, req.racingUser.id);
  if (!result) {
    return res.redirect('/racing/teams/' + teamId + '?error=' + encodeURIComponent('Invite already pending'));
  }
  db.createNotification(target.id, 'team_invite', 'Team invite', req.racingUser.username + ' invited you to ' + membership.team_name, '/racing/teams', 'team_invite', result);
  res.redirect('/racing/teams/' + teamId + '?msg=' + encodeURIComponent('Invite sent to ' + target.username));
});
```

- [ ] **Step 3: Rewrite all routes to use `/teams` and `/teams/:teamId` patterns**

Replace the entire file with the multi-team version. Key changes:
- `GET /` → teams list page (all teams + pending invites)
- `GET /:teamId` → team detail/management page
- `POST /create` → create team (max-5 cap)
- `POST /:teamId/invite` → invite to specific team
- `POST /invite/:id/accept` → accept invite (max-5 cap checked in db.js)
- `POST /invite/:id/decline` → decline invite (unchanged logic)
- `POST /:teamId/kick/:userId` → kick from specific team
- `POST /:teamId/leave` → leave specific team
- `POST /:teamId/delete` → delete specific team (owner only)
- `GET /join/:code` → join via code (max-5 cap)
- `GET /search` → autocomplete (unchanged)

Full file:

```js
const express = require('express');
const db = require('../db');
const router = express.Router();

// GET /racing/teams — teams list
router.get('/', (req, res) => {
  const teams = db.getTeamsForUser(req.racingUser.id);
  const pendingInvites = db.getPendingInvitesForUser(req.racingUser.id);

  // Enrich teams with member counts
  const enrichedTeams = teams.map(t => ({
    ...t,
    member_count: db.getTeamMemberCount(t.team_id),
  }));

  res.render('racing-teams', {
    streamer: req.streamer || null,
    racingUser: req.racingUser,
    teams: enrichedTeams,
    pendingInvites,
    error: req.query.error || null,
    msg: req.query.msg || null,
    APP_URL: process.env.APP_URL || '',
  });
});

// GET /racing/teams/:teamId — team detail
router.get('/:teamId', (req, res) => {
  const teamId = parseInt(req.params.teamId);
  const membership = db.getTeamsForUser(req.racingUser.id).find(t => t.team_id === teamId);
  if (!membership) {
    return res.redirect('/racing/teams?error=' + encodeURIComponent('Team not found'));
  }
  const members = db.getTeamMembers(teamId);
  const teamInvites = membership.role === 'owner' ? db.getPendingInvitesForTeam(teamId) : [];

  res.render('racing-team-detail', {
    streamer: req.streamer || null,
    racingUser: req.racingUser,
    team: membership,
    members,
    teamInvites,
    error: req.query.error || null,
    msg: req.query.msg || null,
    APP_URL: process.env.APP_URL || '',
  });
});

// POST /racing/teams/create
router.post('/create', (req, res) => {
  const name = (req.body.team_name || '').trim();
  if (!name || name.length < 2 || name.length > 40) {
    return res.redirect('/racing/teams?error=' + encodeURIComponent('Team name must be 2-40 characters'));
  }
  const teamCount = db.countTeamsForUser(req.racingUser.id);
  if (teamCount >= 5) {
    return res.redirect('/racing/teams?error=' + encodeURIComponent('You can be in a maximum of 5 teams'));
  }
  db.createTeam(name, req.racingUser.id);
  res.redirect('/racing/teams?msg=' + encodeURIComponent('Team created!'));
});

// POST /racing/teams/:teamId/invite
router.post('/:teamId/invite', (req, res) => {
  const teamId = parseInt(req.params.teamId);
  const username = (req.body.username || '').trim();
  if (!username) {
    return res.redirect('/racing/teams/' + teamId + '?error=' + encodeURIComponent('Username required'));
  }
  const membership = db.getTeamsForUser(req.racingUser.id).find(t => t.team_id === teamId);
  if (!membership || membership.role !== 'owner') {
    return res.redirect('/racing/teams?error=' + encodeURIComponent('Only the team owner can invite'));
  }
  const target = db.getRacingUserByUsername(username);
  if (!target) {
    return res.redirect('/racing/teams/' + teamId + '?error=' + encodeURIComponent('User not found'));
  }
  if (target.id === req.racingUser.id) {
    return res.redirect('/racing/teams/' + teamId + '?error=' + encodeURIComponent('Cannot invite yourself'));
  }
  const targetTeamCount = db.countTeamsForUser(target.id);
  if (targetTeamCount >= 5) {
    return res.redirect('/racing/teams/' + teamId + '?error=' + encodeURIComponent('That user is already in 5 teams'));
  }
  const result = db.createTeamInvite(teamId, target.id, req.racingUser.id);
  if (!result) {
    return res.redirect('/racing/teams/' + teamId + '?error=' + encodeURIComponent('Invite already pending'));
  }
  db.createNotification(target.id, 'team_invite', 'Team invite', req.racingUser.username + ' invited you to ' + membership.team_name, '/racing/teams', 'team_invite', result);
  res.redirect('/racing/teams/' + teamId + '?msg=' + encodeURIComponent('Invite sent to ' + target.username));
});

// POST /racing/teams/invite/:id/accept
router.post('/invite/:id/accept', (req, res) => {
  const invite = db.getTeamInviteById(parseInt(req.params.id));
  if (!invite || invite.invited_user_id !== req.racingUser.id || invite.status !== 'pending') {
    return res.redirect('/racing/teams?error=' + encodeURIComponent('Invalid invite'));
  }
  const ok = db.acceptTeamInvite(invite.id);
  if (!ok) {
    return res.redirect('/racing/teams?error=' + encodeURIComponent('Could not accept invite — you may already be in 5 teams'));
  }
  db.dismissNotificationByAction('team_invite', invite.id, req.racingUser.id);
  const membership = db.getTeamsForUser(req.racingUser.id).find(t => t.team_id === invite.team_id);
  if (membership) {
    db.notifyTeamMembers(membership.team_id, req.racingUser.id, 'team_join', 'Teammate joined', req.racingUser.username + ' joined the team', '/racing/teams/' + membership.team_id);
  }
  res.redirect('/racing/teams?msg=' + encodeURIComponent('Welcome to the team!'));
});

// POST /racing/teams/invite/:id/decline
router.post('/invite/:id/decline', (req, res) => {
  const invite = db.getTeamInviteById(parseInt(req.params.id));
  if (!invite || invite.invited_user_id !== req.racingUser.id || invite.status !== 'pending') {
    return res.redirect('/racing/teams?error=' + encodeURIComponent('Invalid invite'));
  }
  db.declineTeamInvite(invite.id);
  db.dismissNotificationByAction('team_invite', invite.id, req.racingUser.id);
  res.redirect('/racing/teams?msg=' + encodeURIComponent('Invite declined'));
});

// POST /racing/teams/:teamId/kick/:userId
router.post('/:teamId/kick/:userId', (req, res) => {
  const teamId = parseInt(req.params.teamId);
  const membership = db.getTeamsForUser(req.racingUser.id).find(t => t.team_id === teamId);
  if (!membership || membership.role !== 'owner') {
    return res.redirect('/racing/teams?error=' + encodeURIComponent('Only the team owner can remove members'));
  }
  const targetId = parseInt(req.params.userId);
  if (targetId === req.racingUser.id) {
    return res.redirect('/racing/teams/' + teamId + '?error=' + encodeURIComponent('Cannot remove yourself — use delete team'));
  }
  const kickedUser = db.getRacingUserById(targetId);
  db.removeTeamMember(teamId, targetId);
  if (kickedUser) {
    db.createNotification(targetId, 'team_leave', 'Removed from team', 'You were removed from ' + membership.team_name, '/racing/teams', null, null);
    db.notifyTeamMembers(teamId, targetId, 'team_leave', 'Teammate left', kickedUser.username + ' was removed from the team', '/racing/teams/' + teamId);
  }
  res.redirect('/racing/teams/' + teamId + '?msg=' + encodeURIComponent('Member removed'));
});

// POST /racing/teams/:teamId/leave
router.post('/:teamId/leave', (req, res) => {
  const teamId = parseInt(req.params.teamId);
  const membership = db.getTeamsForUser(req.racingUser.id).find(t => t.team_id === teamId);
  if (!membership) {
    return res.redirect('/racing/teams');
  }
  if (membership.role === 'owner') {
    return res.redirect('/racing/teams/' + teamId + '?error=' + encodeURIComponent('Owner cannot leave — delete the team or transfer ownership'));
  }
  db.notifyTeamMembers(teamId, req.racingUser.id, 'team_leave', 'Teammate left', req.racingUser.username + ' left the team', '/racing/teams/' + teamId);
  db.removeTeamMember(teamId, req.racingUser.id);
  res.redirect('/racing/teams?msg=' + encodeURIComponent('You left the team'));
});

// POST /racing/teams/:teamId/delete
router.post('/:teamId/delete', (req, res) => {
  const teamId = parseInt(req.params.teamId);
  const membership = db.getTeamsForUser(req.racingUser.id).find(t => t.team_id === teamId);
  if (!membership || membership.role !== 'owner') {
    return res.redirect('/racing/teams?error=' + encodeURIComponent('Only the team owner can delete the team'));
  }
  db.deleteTeamById(teamId);
  res.redirect('/racing/teams?msg=' + encodeURIComponent('Team deleted'));
});

// GET /racing/teams/join/:code
router.get('/join/:code', (req, res) => {
  const teamCount = db.countTeamsForUser(req.racingUser.id);
  if (teamCount >= 5) {
    return res.redirect('/racing/teams?error=' + encodeURIComponent('You can be in a maximum of 5 teams'));
  }
  const team = db.joinTeamByCode(req.params.code, req.racingUser.id);
  if (!team) {
    return res.redirect('/racing/teams?error=' + encodeURIComponent('Invalid invite code'));
  }
  db.notifyTeamMembers(team.id, req.racingUser.id, 'team_join', 'Teammate joined', req.racingUser.username + ' joined the team', '/racing/teams/' + team.id);
  res.redirect('/racing/teams?msg=' + encodeURIComponent('Joined ' + team.name + '!'));
});

// GET /racing/teams/search?q=...
router.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const results = db.searchRacingUsers(q)
    .filter(u => u.id !== req.racingUser.id)
    .map(u => ({ username: u.username, display_name: u.display_name, iracing_name: u.iracing_name }));
  res.json(results);
});

module.exports = router;
```

- [ ] **Step 4: Update server.js mount path**

In `src/server.js`, change line 166-169 from:

```js
app.use('/racing/team', (req, res, next) => {
  if (!req.racingUser) return res.redirect('/racing');
  next();
}, racingTeamRoutes);
```

To:

```js
app.use('/racing/teams', (req, res, next) => {
  if (!req.racingUser) return res.redirect('/racing');
  next();
}, racingTeamRoutes);
// Redirect old URL
app.get('/racing/team', (req, res) => res.redirect('/racing/teams'));
```

- [ ] **Step 5: Verify the app starts**

Run: `npm run dev` (Ctrl+C after startup)
Expected: No crashes. Note: views don't exist yet, that's fine — routes are wired.

- [ ] **Step 6: Commit**

```bash
git add src/routes/racing-team.js src/server.js
git commit -m "feat(teams): rewrite team routes for multi-team with /teams/:teamId pattern"
```

---

### Task 3: Create teams list view (`racing-teams.ejs`)

**Files:**
- Create: `src/views/racing-teams.ejs`

- [ ] **Step 1: Create the teams list view**

This replaces the old `racing-team.ejs` as the main teams page. Shows all teams as cards, pending invites banner, and create/join UI.

```html
<%- include('header', { title: 'Teams — Atleta', streamer: streamer }) %>
<div style="padding:24px 0;max-width:800px;">
  <a href="/racing" style="text-decoration:none;display:inline-flex;align-items:center;gap:6px;background:none;border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:6px 14px;color:rgba(255,255,255,0.6);font-size:13px;margin-bottom:16px;">&#8592; Back</a>
  <h1 style="font-size:28px;font-weight:800;margin-bottom:24px;">My Teams</h1>

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
            <form method="POST" action="/racing/teams/invite/<%= inv.id %>/accept" style="margin:0;">
              <button type="submit" style="background:#3ecf8e;color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;">Accept</button>
            </form>
            <form method="POST" action="/racing/teams/invite/<%= inv.id %>/decline" style="margin:0;">
              <button type="submit" style="background:rgba(240,68,56,0.15);color:#f04438;border:none;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;">Decline</button>
            </form>
          </div>
        </div>
      <% }); %>
    </div>
  <% } %>

  <% if (teams.length > 0) { %>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px;margin-bottom:24px;">
      <% teams.forEach(function(t) { %>
        <a href="/racing/teams/<%= t.team_id %>" class="card" style="padding:20px;text-decoration:none;color:inherit;transition:all 0.15s;border:1px solid <%= t.role === 'owner' ? 'rgba(247,201,72,0.15)' : 'transparent' %>;">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <div>
              <h3 style="font-size:16px;font-weight:700;margin-bottom:4px;"><%= t.team_name %></h3>
              <p style="color:var(--text-muted);font-size:12px;"><%= t.member_count %> member<%= t.member_count !== 1 ? 's' : '' %></p>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <% if (t.role === 'owner') { %>
                <span style="background:rgba(247,201,72,0.15);color:#f7c948;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;">OWNER</span>
              <% } %>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--text-muted)" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
            </div>
          </div>
        </a>
      <% }); %>
    </div>
  <% } %>

  <% if (teams.length < 5) { %>
    <div class="card" style="padding:24px;margin-bottom:20px;">
      <h3 style="font-size:15px;font-weight:700;margin-bottom:12px;">Create or Join a Team</h3>
      <div style="display:flex;gap:16px;flex-wrap:wrap;">
        <form method="POST" action="/racing/teams/create" style="display:flex;gap:8px;align-items:center;">
          <input type="text" name="team_name" placeholder="Team name" required minlength="2" maxlength="40"
            style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:8px 12px;color:var(--text-primary);font-size:13px;width:180px;">
          <button type="submit" style="background:var(--accent);color:#fff;border:none;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;">Create Team</button>
        </form>
      </div>
      <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border);">
        <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px;">Have an invite code?</p>
        <form style="display:flex;gap:8px;align-items:center;" onsubmit="event.preventDefault(); var c = this.querySelector('input').value.trim(); if(c) window.location='/racing/teams/join/' + encodeURIComponent(c);">
          <input type="text" placeholder="Paste invite code" style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:8px 12px;color:var(--text-primary);font-size:13px;width:160px;">
          <button type="submit" style="background:rgba(62,207,142,0.15);color:#3ecf8e;border:none;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;">Join</button>
        </form>
      </div>
      <p style="color:var(--text-muted);font-size:11px;margin-top:12px;"><%= teams.length %>/5 teams</p>
    </div>
  <% } else { %>
    <p style="color:var(--text-muted);font-size:12px;margin-bottom:20px;">You're in 5/5 teams (maximum reached)</p>
  <% } %>
</div>
<%- include('footer') %>
```

- [ ] **Step 2: Verify the page renders**

Run: `npm run dev`, navigate to `/racing/teams` (must be logged in as racing user).
Expected: Page renders with teams list or empty state with create/join form.

- [ ] **Step 3: Commit**

```bash
git add src/views/racing-teams.ejs
git commit -m "feat(teams): add teams list view with multi-team cards"
```

---

### Task 4: Create team detail view (`racing-team-detail.ejs`)

**Files:**
- Create: `src/views/racing-team-detail.ejs`

- [ ] **Step 1: Create the team detail view**

This is the per-team management page — member list, invite, kick, leave/delete. Adapted from the old `racing-team.ejs` but scoped to one team with updated form actions.

```html
<%- include('header', { title: team.team_name + ' — Atleta', streamer: streamer }) %>
<div style="padding:24px 0;max-width:800px;">
  <a href="/racing/teams" style="text-decoration:none;display:inline-flex;align-items:center;gap:6px;background:none;border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:6px 14px;color:rgba(255,255,255,0.6);font-size:13px;margin-bottom:16px;">&#8592; All Teams</a>

  <% if (error) { %>
    <div style="background:rgba(240,68,56,0.1);border:1px solid rgba(240,68,56,0.2);border-radius:8px;padding:12px 16px;margin-bottom:16px;color:#f04438;font-size:13px;"><%= error %></div>
  <% } %>
  <% if (msg) { %>
    <div style="background:rgba(62,207,142,0.1);border:1px solid rgba(62,207,142,0.2);border-radius:8px;padding:12px 16px;margin-bottom:16px;color:#3ecf8e;font-size:13px;"><%= msg %></div>
  <% } %>

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
            <form method="POST" action="/racing/teams/<%= team.team_id %>/kick/<%= m.user_id %>" style="margin:0;" onsubmit="return confirm('Remove <%= m.username %> from the team?')">
              <button type="submit" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:11px;padding:4px 8px;border-radius:4px;transition:all 0.15s;" onmouseover="this.style.color='#f04438';this.style.background='rgba(240,68,56,0.1)'" onmouseout="this.style.color='var(--text-muted)';this.style.background='none'">&times; Remove</button>
            </form>
          <% } %>
        </div>
      <% }); %>
    </div>
  </div>

  <% if (team.role === 'owner') { %>
    <div class="card" style="padding:20px;margin-bottom:20px;">
      <h3 style="font-size:15px;font-weight:700;margin-bottom:12px;">Invite Teammate</h3>
      <form method="POST" action="/racing/teams/<%= team.team_id %>/invite" style="display:flex;gap:8px;align-items:center;position:relative;" id="invite-form">
        <div style="position:relative;flex:1;">
          <input type="text" name="username" placeholder="Racing username" required autocomplete="off" id="invite-input"
            style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:8px 12px;color:var(--text-primary);font-size:13px;width:100%;box-sizing:border-box;">
          <div id="invite-dropdown" style="display:none;position:absolute;top:100%;left:0;right:0;margin-top:4px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;overflow:hidden;z-index:100;box-shadow:0 8px 24px rgba(0,0,0,0.4);max-height:240px;overflow-y:auto;"></div>
        </div>
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

    <div class="card" style="padding:20px;margin-bottom:20px;">
      <h3 style="font-size:15px;font-weight:700;margin-bottom:8px;">Invite Link</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px;">Share this link — anyone with a Racing account can join your team directly.</p>
      <div style="display:flex;gap:8px;align-items:center;">
        <input type="text" readonly value="<%= APP_URL %>/racing/teams/join/<%= team.invite_code %>" id="invite-link"
          style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:8px 12px;color:var(--text-secondary);font-size:12px;flex:1;font-family:'JetBrains Mono',monospace;"
          onclick="this.select()">
        <button onclick="navigator.clipboard.writeText(document.getElementById('invite-link').value);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy Link',1500)"
          style="background:rgba(145,70,255,0.15);color:var(--accent);border:none;border-radius:6px;padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;">Copy Link</button>
      </div>
    </div>
  <% } %>

  <div style="display:flex;gap:12px;margin-top:8px;">
    <% if (team.role !== 'owner') { %>
      <form method="POST" action="/racing/teams/<%= team.team_id %>/leave" onsubmit="return confirm('Leave the team?')">
        <button type="submit" style="background:rgba(240,68,56,0.1);color:#f04438;border:1px solid rgba(240,68,56,0.2);border-radius:6px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;">Leave Team</button>
      </form>
    <% } else { %>
      <form method="POST" action="/racing/teams/<%= team.team_id %>/delete" onsubmit="return confirm('Delete the team? This cannot be undone.')">
        <button type="submit" style="background:rgba(240,68,56,0.1);color:#f04438;border:1px solid rgba(240,68,56,0.2);border-radius:6px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;">Delete Team</button>
      </form>
    <% } %>
  </div>
</div>
<script>
(function() {
  const input = document.getElementById('invite-input');
  const dropdown = document.getElementById('invite-dropdown');
  if (!input || !dropdown) return;

  let timer = null;
  let selectedIdx = -1;

  input.addEventListener('input', function() {
    clearTimeout(timer);
    const q = this.value.trim();
    if (q.length < 2) { dropdown.style.display = 'none'; return; }
    timer = setTimeout(() => {
      fetch('/racing/teams/search?q=' + encodeURIComponent(q))
        .then(r => r.json())
        .then(users => {
          if (!users.length) { dropdown.style.display = 'none'; return; }
          selectedIdx = -1;
          dropdown.innerHTML = users.map((u, i) =>
            '<div class="ac-item" data-idx="' + i + '" data-username="' + u.username + '" style="padding:8px 12px;cursor:pointer;display:flex;align-items:center;gap:8px;border-bottom:1px solid rgba(255,255,255,0.04);">' +
              '<div style="flex:1;min-width:0;">' +
                '<div style="font-size:13px;font-weight:600;color:var(--text-primary);">' + u.username + '</div>' +
                (u.display_name || u.iracing_name ? '<div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + (u.display_name ? u.display_name : '') + (u.display_name && u.iracing_name ? ' · ' : '') + (u.iracing_name ? u.iracing_name : '') + '</div>' : '') +
              '</div>' +
            '</div>'
          ).join('');
          dropdown.style.display = 'block';

          dropdown.querySelectorAll('.ac-item').forEach(el => {
            el.addEventListener('mousedown', function(e) {
              e.preventDefault();
              input.value = this.dataset.username;
              dropdown.style.display = 'none';
            });
            el.addEventListener('mouseover', function() {
              selectedIdx = parseInt(this.dataset.idx);
              highlightItem();
            });
          });
        })
        .catch(() => { dropdown.style.display = 'none'; });
    }, 200);
  });

  input.addEventListener('keydown', function(e) {
    const items = dropdown.querySelectorAll('.ac-item');
    if (!items.length || dropdown.style.display === 'none') return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
      highlightItem();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
      highlightItem();
    } else if (e.key === 'Enter' && selectedIdx >= 0) {
      e.preventDefault();
      input.value = items[selectedIdx].dataset.username;
      dropdown.style.display = 'none';
    } else if (e.key === 'Escape') {
      dropdown.style.display = 'none';
    }
  });

  input.addEventListener('blur', function() {
    setTimeout(() => { dropdown.style.display = 'none'; }, 150);
  });

  function highlightItem() {
    dropdown.querySelectorAll('.ac-item').forEach((el, i) => {
      el.style.background = i === selectedIdx ? 'rgba(145,70,255,0.15)' : 'transparent';
    });
  }
})();
</script>
<%- include('footer') %>
```

- [ ] **Step 2: Commit**

```bash
git add src/views/racing-team-detail.ejs
git commit -m "feat(teams): add team detail view for per-team management"
```

---

### Task 5: Update dashboard, sidebar, and pitwall route for multi-team

**Files:**
- Modify: `src/routes/racing.js:7-16` (dashboard route)
- Modify: `src/routes/racing.js:45-55` (pitwall route)
- Modify: `src/views/racing-dashboard.ejs:33-63` (team/pitwall cards)
- Modify: `src/views/header.ejs:631-634` (sidebar link)

- [ ] **Step 1: Update dashboard route in racing.js**

Replace lines 7-16 (inside the `router.get('/')` handler, the `if (req.racingUser)` block):

```js
    const teams = db.getTeamsForUser(req.racingUser.id);
    const pendingTeamInvites = db.getPendingInvitesForUser(req.racingUser.id);
    return res.render('racing-dashboard', {
      streamer: req.streamer || null,
      racingUser: req.racingUser,
      teams,
      pendingTeamInvites,
    });
```

- [ ] **Step 2: Update pitwall route in racing.js**

Replace lines 45-55 (the `router.get('/pitwall')` handler):

```js
router.get('/pitwall', (req, res) => {
  const teams = db.getTeamsForUser(req.racingUser.id);
  if (teams.length === 0) return res.redirect('/racing/teams');

  // If only 1 team, go straight to pitwall
  if (teams.length === 1) {
    const members = db.getTeamMembers(teams[0].team_id);
    return res.render('racing-pitwall', {
      streamer: req.streamer || null,
      racingUser: req.racingUser,
      team: teams[0],
      members,
    });
  }

  // Multiple teams — show team picker
  const enrichedTeams = teams.map(t => ({
    ...t,
    member_count: db.getTeamMemberCount(t.team_id),
  }));
  res.render('racing-pitwall-picker', {
    streamer: req.streamer || null,
    racingUser: req.racingUser,
    teams: enrichedTeams,
  });
});

// Pitwall for a specific team
router.get('/pitwall/:teamId', (req, res) => {
  const teamId = parseInt(req.params.teamId);
  const membership = db.getTeamsForUser(req.racingUser.id).find(t => t.team_id === teamId);
  if (!membership) return res.redirect('/racing/pitwall');
  const members = db.getTeamMembers(teamId);
  res.render('racing-pitwall', {
    streamer: req.streamer || null,
    racingUser: req.racingUser,
    team: membership,
    members,
  });
});
```

- [ ] **Step 3: Update dashboard view team/pitwall cards**

In `src/views/racing-dashboard.ejs`, replace lines 33-63 (the team card + conditional pitwall card):

```html
    <a href="/racing/teams" class="card" style="padding:28px 24px;text-decoration:none;color:inherit;<%= (typeof pendingTeamInvites !== 'undefined' && pendingTeamInvites && pendingTeamInvites.length > 0) ? 'border:1px solid rgba(247,201,72,0.3);' : '' %>">
      <div style="display:flex;align-items:center;gap:16px;">
        <div style="width:52px;height:52px;border-radius:12px;background:rgba(59,130,246,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <i data-lucide="users" style="width:26px;height:26px;color:#3b82f6;"></i>
        </div>
        <div>
          <h3 style="font-size:17px;font-weight:700;margin-bottom:4px;">
            Teams
            <% if (typeof pendingTeamInvites !== 'undefined' && pendingTeamInvites && pendingTeamInvites.length > 0) { %>
              <span style="background:#f7c948;color:#000;font-size:10px;font-weight:700;padding:2px 6px;border-radius:8px;margin-left:6px;"><%= pendingTeamInvites.length %></span>
            <% } %>
          </h3>
          <p style="color:var(--text-muted);font-size:13px;">
            <% if (typeof teams !== 'undefined' && teams && teams.length > 0) { %><%= teams.length %> team<%= teams.length !== 1 ? 's' : '' %><% } else { %>Create or join a team<% } %>
          </p>
        </div>
      </div>
    </a>
    <% if (typeof teams !== 'undefined' && teams && teams.length > 0) { %>
    <a href="/racing/pitwall" class="card" style="padding:28px 24px;text-decoration:none;color:inherit;border:1px solid rgba(62,207,142,0.15);">
      <div style="display:flex;align-items:center;gap:16px;">
        <div style="width:52px;height:52px;border-radius:12px;background:rgba(62,207,142,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <i data-lucide="monitor" style="width:26px;height:26px;color:#3ecf8e;"></i>
        </div>
        <div>
          <h3 style="font-size:17px;font-weight:700;margin-bottom:4px;">Pitwall</h3>
          <p style="color:var(--text-muted);font-size:13px;">Watch teammates live</p>
        </div>
      </div>
    </a>
    <% } %>
```

- [ ] **Step 4: Update sidebar link in header.ejs**

In `src/views/header.ejs`, replace lines 631-634:

```html
        <a href="/racing/teams" class="sidebar-link" style="padding-left:34px;font-size:12px;">
          <i data-lucide="users" style="width:15px;height:15px;"></i>
          Teams
        </a>
```

- [ ] **Step 5: Commit**

```bash
git add src/routes/racing.js src/views/racing-dashboard.ejs src/views/header.ejs
git commit -m "feat(teams): update dashboard, sidebar, pitwall route for multi-team"
```

---

### Task 6: Create pitwall team picker view

**Files:**
- Create: `src/views/racing-pitwall-picker.ejs`

- [ ] **Step 1: Create the pitwall team picker**

Shown when user has 2+ teams and navigates to `/racing/pitwall`.

```html
<%- include('header', { title: 'Pitwall — Atleta', streamer: streamer }) %>
<div style="padding:24px 0;max-width:600px;">
  <div style="margin-bottom:24px;">
    <h1 style="font-size:28px;font-weight:800;margin-bottom:4px;">Pitwall</h1>
    <p style="color:var(--text-secondary);font-size:14px;">
      <a href="/racing" style="color:var(--text-muted);text-decoration:none;">&larr; Racing</a>
      <span style="color:var(--border);margin:0 8px;">|</span>
      <span>Choose a team</span>
    </p>
  </div>

  <div style="display:grid;grid-template-columns:1fr;gap:12px;">
    <% teams.forEach(function(t) { %>
      <a href="/racing/pitwall/<%= t.team_id %>" class="card" style="padding:20px;text-decoration:none;color:inherit;transition:all 0.15s;cursor:pointer;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div style="display:flex;align-items:center;gap:14px;">
            <div style="width:44px;height:44px;border-radius:10px;background:rgba(62,207,142,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
              <i data-lucide="monitor" style="width:22px;height:22px;color:#3ecf8e;"></i>
            </div>
            <div>
              <h3 style="font-size:16px;font-weight:700;margin-bottom:2px;"><%= t.team_name %></h3>
              <p style="color:var(--text-muted);font-size:12px;"><%= t.member_count %> member<%= t.member_count !== 1 ? 's' : '' %></p>
            </div>
          </div>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--text-muted)" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
        </div>
      </a>
    <% }); %>
  </div>
</div>
<%- include('footer') %>
```

- [ ] **Step 2: Update pitwall view header for multi-team**

In `src/views/racing-pitwall.ejs`, line 9, after the team name span, add a "Switch Team" link. Replace lines 6-10:

```html
      <p style="color:var(--text-secondary);font-size:14px;">
        <a href="/racing" style="color:var(--text-muted);text-decoration:none;">&larr; Racing</a>
        <span style="color:var(--border);margin:0 8px;">|</span>
        <span><%= team.team_name %></span>
        <a href="/racing/pitwall" style="color:var(--accent);text-decoration:none;font-size:12px;margin-left:10px;">Switch Team</a>
      </p>
```

- [ ] **Step 3: Commit**

```bash
git add src/views/racing-pitwall-picker.ejs src/views/racing-pitwall.ejs
git commit -m "feat(teams): add pitwall team picker for multi-team users"
```

---

### Task 7: Update pitwallRelay.js for multi-team broadcast

**Files:**
- Modify: `src/services/pitwallRelay.js`

- [ ] **Step 1: Update bridge client state to use Set of teamIds**

Replace line 8 comment and the `bridgeClients` Map usage. Change the `authBridge()` function (lines 250-258):

```js
function authBridge(userId, token) {
  if (!userId || !token) return { error: 'userId and token required' };
  const user = db.getRacingUserById(userId);
  if (!user) return { error: 'Invalid credentials' };
  if (!user.pitwall_token || user.pitwall_token !== token) return { error: 'Invalid token' };
  const teams = db.getTeamsForUser(user.id).map(t => ({ id: t.team_id, name: t.team_name }));
  return { userId: user.id, teams, username: user.username };
}
```

- [ ] **Step 2: Update handleBridgeConnection for multi-team**

In `handleBridgeConnection()`, replace the auth success block (lines 101-116):

```js
          authed = true;
          userId = result.userId;

          // Disconnect previous bridge for same user
          const prev = bridgeClients.get(userId);
          if (prev) {
            trySend(prev.ws, { type: 'auth-error', reason: 'Another Bridge connected' });
            prev.ws.close();
          }

          bridgeClients.set(userId, { ws, teamIds: new Set(), username: result.username, allTeams: result.teams });
          driverData.set(userId, new Map());

          trySend(ws, { type: 'auth-ok', userId, teams: result.teams });
          console.log('[Pitwall] Bridge authenticated:', result.username, '(' + result.teams.length + ' teams)');
```

- [ ] **Step 3: Add `set-teams` message handler**

After the heartbeat ping handler (line 128-131), add:

```js
    // Team broadcast selection
    if (msg.type === 'set-teams' && Array.isArray(msg.teamIds)) {
      const client = bridgeClients.get(userId);
      if (!client) return;
      const validIds = new Set(client.allTeams.map(t => t.id));
      const oldTeamIds = new Set(client.teamIds);
      client.teamIds = new Set(msg.teamIds.filter(id => validIds.has(id)));

      // Notify viewers of online/offline per team
      for (const tid of client.teamIds) {
        if (!oldTeamIds.has(tid)) {
          broadcastToTeamViewers(tid, { type: 'driver-online', userId, username: client.username });
        }
      }
      for (const tid of oldTeamIds) {
        if (!client.teamIds.has(tid)) {
          broadcastToTeamViewers(tid, { type: 'driver-offline', userId, username: client.username });
        }
      }
      trySend(ws, { type: 'teams-updated', teamIds: [...client.teamIds] });
      console.log('[Pitwall] Bridge teams updated:', client.username, '->', [...client.teamIds]);
      return;
    }
```

- [ ] **Step 4: Update bridge disconnect handler**

Replace the `ws.on('close')` handler (lines 156-171):

```js
  ws.on('close', () => {
    clearTimeout(authTimer);
    if (userId && bridgeClients.get(userId)?.ws === ws) {
      const client = bridgeClients.get(userId);
      bridgeClients.delete(userId);
      driverData.delete(userId);
      for (const key of lastRelayTime.keys()) {
        if (key.startsWith(userId + ':')) lastRelayTime.delete(key);
      }
      if (client) {
        for (const tid of client.teamIds) {
          broadcastToTeamViewers(tid, { type: 'driver-offline', userId, username: client.username });
        }
        console.log('[Pitwall] Bridge disconnected:', client.username);
      }
    }
  });
```

- [ ] **Step 5: Update `relayToViewers()` for multi-team**

Replace the function (lines 260-273):

```js
function relayToViewers(driverId, channel, data) {
  const msg = JSON.stringify({ type: 'data', channel, data });
  const driverClient = bridgeClients.get(driverId);
  if (!driverClient) return;

  pitwallClients.forEach((viewer, ws) => {
    if (driverClient.teamIds.has(viewer.teamId) &&
        viewer.watchingDriverId === driverId &&
        viewer.channels.has(channel) &&
        ws.readyState === 1) {
      try { ws.send(msg); } catch {}
    }
  });
}
```

- [ ] **Step 6: Update `getActiveDrivers()` for multi-team**

Replace the function (lines 295-303):

```js
function getActiveDrivers(teamId) {
  const drivers = [];
  bridgeClients.forEach((client, odriverId) => {
    if (client.teamIds.has(teamId)) {
      drivers.push({ userId: odriverId, username: client.username });
    }
  });
  return drivers;
}
```

- [ ] **Step 7: Update pitwall viewer auth to accept teamId**

Replace the viewer auth section in `handlePitwallConnection()` (lines 203-221):

```js
  const teams = db.getTeamsForUser(racingUser.id);
  if (teams.length === 0) {
    trySend(ws, { type: 'auth-error', reason: 'Not in a team' });
    ws.close();
    return;
  }

  const viewer = {
    userId: racingUser.id,
    teamId: null,
    username: racingUser.username,
    watchingDriverId: null,
    channels: new Set(),
    teamIds: teams.map(t => t.team_id),
  };
  pitwallClients.set(ws, viewer);

  trySend(ws, { type: 'auth-ok', teams: teams.map(t => ({ id: t.team_id, name: t.team_name })) });
  console.log('[Pitwall] Viewer connected:', racingUser.username);
```

- [ ] **Step 8: Add `select-team` message handler for pitwall viewer**

In the `ws.on('message')` handler for pitwall (around line 224), add a `select-team` case before `subscribe`:

```js
    if (msg.type === 'select-team' && msg.teamId) {
      if (viewer.teamIds.includes(msg.teamId)) {
        viewer.teamId = msg.teamId;
        const activeDrivers = getActiveDrivers(msg.teamId);
        trySend(ws, { type: 'team-selected', teamId: msg.teamId, activeDrivers });
      }
    } else if (msg.type === 'subscribe' && Array.isArray(msg.channels)) {
```

- [ ] **Step 9: Update pitwall.ejs WebSocket to send select-team**

In `src/views/racing-pitwall.ejs`, after the `ws.onmessage` auth-ok handler (line 129-133), update to send select-team:

Replace:
```js
      if (msg.type === 'auth-ok') {
        (msg.activeDrivers || []).forEach(function(d) {
          onlineDrivers.add(d.userId);
        });
        updateDriverStatus();
```

With:
```js
      if (msg.type === 'auth-ok') {
        // Auto-select our team (passed from server-rendered page)
        ws.send(JSON.stringify({ type: 'select-team', teamId: <%= team.team_id %> }));
      } else if (msg.type === 'team-selected') {
        (msg.activeDrivers || []).forEach(function(d) {
          onlineDrivers.add(d.userId);
        });
        updateDriverStatus();
```

- [ ] **Step 10: Verify the app starts**

Run: `npm run dev` (Ctrl+C after startup)
Expected: No crashes, `[Pitwall] WebSocket relay initialized` in console.

- [ ] **Step 11: Commit**

```bash
git add src/services/pitwallRelay.js src/views/racing-pitwall.ejs
git commit -m "feat(teams): update pitwall relay for multi-team broadcast with set-teams and select-team"
```

---

### Task 8: Update Bridge uplink for multi-team broadcast

**Files:**
- Modify: `bridge/pitwallUplink.js`
- Modify: `bridge/control-panel.html:392-414` (Overview panel)
- Modify: `bridge/settings.js` (no structural changes, just document the new key)

- [ ] **Step 1: Update pitwallUplink.js for multi-team auth and set-teams**

Replace the entire file:

```js
'use strict';

const WebSocket = require('ws');
const settings = require('./settings');

const SERVER_URL = 'wss://atletanotifications.com/ws/bridge';
const RECONNECT_BASE = 5000;
const RECONNECT_MAX = 60000;
const HEARTBEAT_INTERVAL = 30000;

let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let isConnected = false;
let enabled = false;
let reconnectDelay = RECONNECT_BASE;
let availableTeams = [];    // Teams returned by server on auth
let broadcastTeamIds = [];  // Teams user chose to broadcast to

// Callback for control panel to update UI
let onTeamsUpdated = null;

function start() {
  const s = settings.load();
  if (!s.racingUserId || !s.pitwallToken) {
    console.log('[Pitwall Uplink] No credentials — skipping');
    return;
  }
  enabled = true;
  broadcastTeamIds = s.pitwallBroadcastTeamIds || [];
  connect();
}

function stop() {
  enabled = false;
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  reconnectTimer = null;
  heartbeatTimer = null;
  if (ws) {
    isConnected = false;
    ws.close();
    ws = null;
  }
}

function connect() {
  if (!enabled) return;
  if (ws) return;

  const s = settings.load();
  if (!s.racingUserId || !s.pitwallToken) return;

  try {
    ws = new WebSocket(SERVER_URL);
  } catch (e) {
    console.error('[Pitwall Uplink] Connection error:', e.message);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    console.log('[Pitwall Uplink] Connected, authenticating...');
    trySend({ type: 'auth', userId: s.racingUserId, token: s.pitwallToken });
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'auth-ok') {
      isConnected = true;
      reconnectDelay = RECONNECT_BASE;
      availableTeams = msg.teams || [];
      console.log('[Pitwall Uplink] Authenticated (' + availableTeams.length + ' teams)');
      startHeartbeat();

      // Filter saved broadcast teams to only valid ones
      const validIds = new Set(availableTeams.map(t => t.id));
      broadcastTeamIds = broadcastTeamIds.filter(id => validIds.has(id));

      // Send saved broadcast selection
      if (broadcastTeamIds.length > 0) {
        trySend({ type: 'set-teams', teamIds: broadcastTeamIds });
      }

      if (onTeamsUpdated) onTeamsUpdated(availableTeams, broadcastTeamIds);
    } else if (msg.type === 'auth-error') {
      console.error('[Pitwall Uplink] Auth failed:', msg.reason);
      isConnected = false;
      ws.close();
    } else if (msg.type === 'teams-updated') {
      broadcastTeamIds = msg.teamIds || [];
      if (onTeamsUpdated) onTeamsUpdated(availableTeams, broadcastTeamIds);
    } else if (msg.type === 'pong') {
      // Heartbeat response
    }
  });

  ws.on('close', () => {
    isConnected = false;
    ws = null;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (enabled) scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[Pitwall Uplink] Error:', err.message);
    if (ws) ws.close();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  console.log('[Pitwall Uplink] Reconnecting in', Math.round(reconnectDelay / 1000), 's...');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX);
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    trySend({ type: 'ping' });
  }, HEARTBEAT_INTERVAL);
}

function sendTelemetry(channel, data) {
  if (!isConnected) return;
  trySend({ type: 'telemetry', channel, data });
}

function setBroadcastTeams(teamIds) {
  broadcastTeamIds = teamIds;
  // Persist to settings
  const s = settings.load();
  s.pitwallBroadcastTeamIds = teamIds;
  settings.save(s);
  // Send to server
  if (isConnected) {
    trySend({ type: 'set-teams', teamIds });
  }
}

function trySend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(data)); } catch {}
  }
}

function getStatus() {
  return isConnected ? 'connected' : (enabled ? 'disconnected' : 'disabled');
}

function getAvailableTeams() {
  return availableTeams;
}

function getBroadcastTeamIds() {
  return broadcastTeamIds;
}

function setOnTeamsUpdated(cb) {
  onTeamsUpdated = cb;
}

module.exports = { start, stop, sendTelemetry, setBroadcastTeams, getStatus, getAvailableTeams, getBroadcastTeamIds, setOnTeamsUpdated };
```

- [ ] **Step 2: Add team broadcast UI to control panel Overview**

In `bridge/control-panel.html`, after the overlay grid and before the autohide checkbox (between lines 403 and 405), add:

```html
        <div class="section-header" style="margin-top:14px;">Team Broadcasting</div>
        <div id="team-broadcast-section" style="margin-bottom:8px;">
          <p style="font-size:11px;color:#5a5970;margin-bottom:8px;">Select which teams can see your telemetry on Pitwall:</p>
          <div id="team-broadcast-list" style="display:flex;flex-direction:column;gap:4px;">
            <p style="font-size:11px;color:#5a5970;font-style:italic;">Connecting...</p>
          </div>
        </div>
```

- [ ] **Step 3: Add JS to populate team broadcast checkboxes**

In the control panel `<script>` section, add the team broadcast UI logic. Find where `pitwallUplink` is required (search for `require('./pitwallUplink')`) and after the existing uplink setup, add:

```js
  // Team broadcast UI
  const pitwallUplink = require('./pitwallUplink');
  pitwallUplink.setOnTeamsUpdated(function(teams, broadcastIds) {
    const container = document.getElementById('team-broadcast-list');
    if (!container) return;
    if (teams.length === 0) {
      container.innerHTML = '<p style="font-size:11px;color:#5a5970;font-style:italic;">No teams — join a team at atletanotifications.com/racing/teams</p>';
      return;
    }
    const broadcastSet = new Set(broadcastIds);
    container.innerHTML = teams.map(function(t) {
      return '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#c4c3d4;cursor:pointer;padding:4px 0;">' +
        '<input type="checkbox" data-team-id="' + t.id + '" ' + (broadcastSet.has(t.id) ? 'checked' : '') + ' onchange="updateBroadcastTeams()" style="accent-color:#3ecf8e;">' +
        '<span>' + t.name + '</span>' +
        (broadcastSet.has(t.id) ? '<span style="width:6px;height:6px;border-radius:50%;background:#3ecf8e;flex-shrink:0;"></span>' : '') +
      '</label>';
    }).join('');
  });

  window.updateBroadcastTeams = function() {
    const checks = document.querySelectorAll('#team-broadcast-list input[type=checkbox]');
    const ids = [];
    checks.forEach(function(cb) {
      if (cb.checked) ids.push(parseInt(cb.dataset.teamId));
    });
    pitwallUplink.setBroadcastTeams(ids);
  };
```

Note: The exact location of this code depends on how `pitwallUplink` is already referenced in the control panel script. If it's not yet referenced there, the `require` and `setOnTeamsUpdated` call should happen after the module is loaded in `main.js` and exposed via IPC or preload. Check how the control panel currently accesses Node modules — it uses `nodeIntegration: true`, so `require('./pitwallUplink')` works if the path resolves correctly. The control panel loads from `bridge/control-panel.html`, so the require path should be `./pitwallUplink`.

- [ ] **Step 4: Commit**

```bash
git add bridge/pitwallUplink.js bridge/control-panel.html
git commit -m "feat(teams): Bridge multi-team broadcast selection with control panel UI"
```

---

### Task 9: Clean up old team view and verify

**Files:**
- Delete: `src/views/racing-team.ejs` (replaced by `racing-teams.ejs` + `racing-team-detail.ejs`)

- [ ] **Step 1: Delete the old single-team view**

```bash
git rm src/views/racing-team.ejs
```

- [ ] **Step 2: Run Playwright E2E tests**

```bash
npx playwright test
```

Expected: All existing tests pass. The tests hit public pages and authenticated flows — the team URL redirect (`/racing/team` → `/racing/teams`) should handle any test references.

- [ ] **Step 3: Manual smoke test**

Run: `npm run dev`

Verify:
1. `/racing/teams` shows teams list (or create/join if none)
2. Creating a team works, redirects to teams list
3. Team detail page (`/racing/teams/:id`) shows members, invite form
4. Dashboard shows "Teams" card with count
5. Sidebar says "Teams" not "My Team"
6. `/racing/pitwall` — with 1 team goes straight to pitwall, with 2+ shows picker
7. `/racing/team` redirects to `/racing/teams`
8. Invite code join link (`/racing/teams/join/:code`) works

- [ ] **Step 4: Commit**

```bash
git rm src/views/racing-team.ejs
git commit -m "chore: remove old single-team view, replaced by racing-teams + racing-team-detail"
```

---

### Task 10: Version bump and final commit

**Files:**
- Modify: `package.json` (version bump)

- [ ] **Step 1: Bump version**

In `package.json`, bump the version from current to next minor (e.g., `3.17.0` → `3.18.0`).

- [ ] **Step 2: Final commit with version**

```bash
git add package.json
git commit -m "v3.18.0: Multi-team support — simultaneous team membership, team broadcast selection, pitwall team picker"
```
