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
  // Check if target is already in this team
  const targetTeams = db.getTeamsForUser(target.id);
  if (targetTeams.some(t => t.team_id === teamId)) {
    return res.redirect('/racing/teams/' + teamId + '?error=' + encodeURIComponent('That user is already in this team'));
  }
  if (targetTeams.length >= 5) {
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

// GET /racing/teams/search?q=... (rate limited: 10 per minute per user)
const _searchCounts = new Map();
setInterval(() => _searchCounts.clear(), 60000);
router.get('/search', (req, res) => {
  const uid = req.racingUser.id;
  const count = (_searchCounts.get(uid) || 0) + 1;
  _searchCounts.set(uid, count);
  if (count > 10) return res.status(429).json({ error: 'Too many searches, try again in a minute' });
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const results = db.searchRacingUsers(q)
    .filter(u => u.id !== req.racingUser.id)
    .map(u => ({ username: u.username, display_name: u.display_name }));
  res.json(results);
});

module.exports = router;
