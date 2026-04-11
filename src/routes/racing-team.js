const express = require('express');
const db = require('../db');
const router = express.Router();

// All routes require Racing login (auth wall applied at mount in server.js)

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
      APP_URL: process.env.APP_URL || '',
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
    APP_URL: process.env.APP_URL || '',
  });
});

// POST /racing/team/create
router.post('/create', (req, res) => {
  const name = (req.body.team_name || '').trim();
  if (!name || name.length < 2 || name.length > 40) {
    return res.redirect('/racing/team?error=' + encodeURIComponent('Team name must be 2-40 characters'));
  }
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
  db.createNotification(target.id, 'team_invite', 'Team invite', req.racingUser.username + ' invited you to ' + membership.team_name, '/racing/team', 'team_invite', result);
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
  // Remove the invite notification + notify team
  db.dismissNotificationByAction('team_invite', invite.id, req.racingUser.id);
  const membership = db.getTeamForUser(req.racingUser.id);
  if (membership) {
    db.notifyTeamMembers(membership.team_id, req.racingUser.id, 'team_join', 'Teammate joined', req.racingUser.username + ' joined the team', '/racing/team');
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
  db.dismissNotificationByAction('team_invite', invite.id, req.racingUser.id);
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
  const kickedUser = db.getRacingUserById(targetId);
  db.removeTeamMember(membership.team_id, targetId);
  if (kickedUser) {
    db.createNotification(targetId, 'team_leave', 'Removed from team', 'You were removed from ' + membership.team_name, '/racing/team', null, null);
    db.notifyTeamMembers(membership.team_id, targetId, 'team_leave', 'Teammate left', kickedUser.username + ' was removed from the team', '/racing/team');
  }
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
  db.notifyTeamMembers(membership.team_id, req.racingUser.id, 'team_leave', 'Teammate left', req.racingUser.username + ' left the team', '/racing/team');
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
  db.notifyTeamMembers(team.id, req.racingUser.id, 'team_join', 'Teammate joined', req.racingUser.username + ' joined the team', '/racing/team');
  res.redirect('/racing/team?msg=' + encodeURIComponent('Joined ' + team.name + '!'));
});

// GET /racing/team/search?q=... — autocomplete for invite
router.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const results = db.searchRacingUsers(q)
    .filter(u => u.id !== req.racingUser.id)
    .map(u => ({ username: u.username, display_name: u.display_name, iracing_name: u.iracing_name }));
  res.json(results);
});

module.exports = router;
