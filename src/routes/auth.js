const { Router } = require('express');
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');

const router = Router();

// --- Dashboard Login (Twitch OAuth) ---

router.get('/login', (req, res) => {
  const state = crypto.randomUUID();
  res.cookie('oauth_state', state, { httpOnly: true, maxAge: 600_000 });

  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    redirect_uri: `${config.app.url}/auth/login/callback`,
    response_type: 'code',
    scope: '',
    state,
  });
  res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
});

router.get('/login/callback', async (req, res) => {
  const { code, state } = req.query;
  const expectedState = req.cookies?.oauth_state;

  if (!code || !state || state !== expectedState) {
    return res.status(400).send('Invalid OAuth callback');
  }
  res.clearCookie('oauth_state');

  try {
    // Exchange code for token
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: config.twitch.clientId,
        client_secret: config.twitch.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${config.app.url}/auth/login/callback`,
      }),
    });

    if (!tokenRes.ok) throw new Error('Token exchange failed');
    const tokenData = await tokenRes.json();

    // Get Twitch user identity
    const userRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'Client-Id': config.twitch.clientId,
      },
    });

    if (!userRes.ok) throw new Error('Failed to get user info');
    const userData = await userRes.json();
    const twitchUser = userData.data[0];

    // Create/update streamer record
    const streamer = db.upsertStreamer(twitchUser.id, twitchUser.login, twitchUser.display_name);

    // Create session
    const sid = crypto.randomUUID();
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
    db.createSession(sid, streamer.id, expiresAt);
    res.cookie('session', sid, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });

    console.log(`[Auth] Streamer logged in: ${twitchUser.display_name} (${twitchUser.id})`);
    res.redirect('/dashboard');
  } catch (error) {
    console.error(`[Auth] Login error: ${error.message}`);
    res.status(500).send('Login failed. Please try again.');
  }
});

router.get('/logout', (req, res) => {
  const sid = req.cookies?.session;
  if (sid) db.deleteSession(sid);
  res.clearCookie('session');
  res.redirect('/');
});

// --- Broadcaster Auth (for sub sync) ---

router.get('/broadcaster', (req, res) => {
  if (!req.streamer) return res.redirect('/auth/login');

  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    redirect_uri: `${config.app.url}/auth/broadcaster/callback`,
    response_type: 'code',
    scope: 'channel:read:subscriptions',
    state: String(req.streamer.id),
  });
  res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
});

router.get('/broadcaster/callback', async (req, res) => {
  const { code, state: streamerId } = req.query;
  if (!code || !streamerId) return res.status(400).send('Missing parameters');

  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: config.twitch.clientId,
        client_secret: config.twitch.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${config.app.url}/auth/broadcaster/callback`,
      }),
    });

    if (!tokenRes.ok) throw new Error('Token exchange failed');
    const data = await tokenRes.json();

    db.updateStreamerBroadcasterTokens(
      parseInt(streamerId),
      data.access_token,
      data.refresh_token,
      Date.now() + data.expires_in * 1000 - 60_000
    );

    console.log(`[Auth] Broadcaster ${streamerId} authorized for sub sync`);
    res.redirect('/dashboard?msg=broadcaster_authorized');
  } catch (error) {
    console.error(`[Auth] Broadcaster callback error: ${error.message}`);
    res.status(500).send('Authorization failed');
  }
});

// --- User Linking (for sub sync) ---

router.get('/link', (req, res) => {
  const { streamer_id, discord_id } = req.query;
  if (!streamer_id || !discord_id) return res.status(400).send('Missing parameters');

  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    redirect_uri: `${config.app.url}/auth/link/callback`,
    response_type: 'code',
    scope: '',
    state: `${streamer_id}:${discord_id}`,
  });
  res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
});

router.get('/link/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Missing parameters');

  const [streamerId, discordId] = state.split(':');
  if (!streamerId || !discordId) return res.status(400).send('Invalid state');

  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: config.twitch.clientId,
        client_secret: config.twitch.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${config.app.url}/auth/link/callback`,
      }),
    });

    if (!tokenRes.ok) throw new Error('Token exchange failed');
    const tokenData = await tokenRes.json();

    const userRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'Client-Id': config.twitch.clientId,
      },
    });

    if (!userRes.ok) throw new Error('Failed to get user info');
    const userData = await userRes.json();
    const twitchUser = userData.data[0];

    db.linkUser(parseInt(streamerId), discordId, twitchUser.id, twitchUser.login);
    console.log(`[Auth] Linked Discord ${discordId} -> Twitch ${twitchUser.login}`);

    res.send(`Linked! Your Twitch account (${twitchUser.display_name}) is now connected. You can close this page.`);
  } catch (error) {
    console.error(`[Auth] Link error: ${error.message}`);
    res.status(500).send('Linking failed');
  }
});

module.exports = router;
