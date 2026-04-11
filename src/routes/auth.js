const { Router } = require('express');
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');

const router = Router();

// --- Discord OAuth Login ---

router.get('/login', (req, res) => {
  const state = crypto.randomUUID();
  req.app.locals.secureCookie(res, 'oauth_state', state, { maxAge: 600_000 });

  const params = new URLSearchParams({
    client_id: config.discord.clientId,
    redirect_uri: `${config.app.url}/auth/login/callback`,
    response_type: 'code',
    scope: 'identify',
    state,
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
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
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.discord.clientId,
        client_secret: config.discord.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${config.app.url}/auth/login/callback`,
      }),
    });

    if (!tokenRes.ok) throw new Error('Token exchange failed');
    const tokenData = await tokenRes.json();

    // Get Discord user identity
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userRes.ok) throw new Error('Failed to get user info');
    const user = await userRes.json();

    const avatar = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
      : null;

    // Create/update streamer record
    const streamer = db.upsertStreamerDiscord(
      user.id,
      user.username,
      user.global_name || user.username,
      avatar
    );

    // Create session
    const sid = crypto.randomUUID();
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    db.createSession(sid, streamer.id, expiresAt);
    req.app.locals.secureCookie(res, 'session', sid, { maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' });

    // Link Racing account if one is already logged in
    if (req.racingUser && !req.racingUser.streamer_id) {
      db.linkRacingUserToStreamer(req.racingUser.id, streamer.id);
      // Replace with a linked session
      db.deleteSession(sid);
      const linkedSid = crypto.randomBytes(32).toString('hex');
      db.createLinkedSession(linkedSid, streamer.id, req.racingUser.id, expiresAt);
      req.app.locals.secureCookie(res, 'session', linkedSid, { maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' });
      console.log(`[Auth] Discord login: ${user.username} (${user.id}) — linked to Racing user ${req.racingUser.id}`);
      return res.redirect('/racing/account?msg=' + encodeURIComponent('Discord account linked!'));
    }

    console.log(`[Auth] Discord login: ${user.username} (${user.id})`);
    res.redirect('/dashboard');
  } catch (error) {
    console.error(`[Auth] Discord login error: ${error.message}`);
    res.status(500).send('Login failed. Please try again.');
  }
});

router.get('/logout', (req, res) => {
  const sid = req.cookies?.session;
  if (sid) db.deleteSession(sid);
  res.clearCookie('session');
  res.redirect('/');
});

// --- Twitch Account Linking ---

router.get('/twitch', (req, res) => {
  if (!req.streamer) return res.redirect('/auth/login');

  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    redirect_uri: `${config.app.url}/auth/twitch/callback`,
    response_type: 'code',
    scope: '',
    state: String(req.streamer.id),
  });
  res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
});

router.get('/twitch/callback', async (req, res) => {
  const { code, state: streamerId } = req.query;
  if (!code || !streamerId) return res.status(400).send('Missing parameters');
  if (String(streamerId) !== String(req.streamer?.id)) return res.status(403).send('Invalid state');

  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: config.twitch.clientId,
        client_secret: config.twitch.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${config.app.url}/auth/twitch/callback`,
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

    if (!userRes.ok) throw new Error('Failed to get Twitch user info');
    const userData = await userRes.json();
    const twitchUser = userData.data[0];

    db.linkTwitch(parseInt(streamerId), twitchUser.id, twitchUser.login, twitchUser.display_name);
    console.log(`[Auth] Twitch linked: streamer ${streamerId} -> ${twitchUser.login}`);

    res.redirect('/dashboard?msg=twitch_linked');
  } catch (error) {
    console.error(`[Auth] Twitch link error: ${error.message}`);
    res.status(500).send('Twitch linking failed. Please try again.');
  }
});

// --- Broadcaster Auth (for sub sync) ---

router.get('/broadcaster', (req, res) => {
  if (!req.streamer) return res.redirect('/auth/login');

  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    redirect_uri: `${config.app.url}/auth/broadcaster/callback`,
    response_type: 'code',
    scope: 'channel:read:subscriptions moderator:read:followers bits:read',
    state: String(req.streamer.id),
  });
  res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
});

router.get('/broadcaster/callback', async (req, res) => {
  const { code, state: streamerId } = req.query;
  if (!code || !streamerId) return res.status(400).send('Missing parameters');
  if (String(streamerId) !== String(req.streamer?.id)) return res.status(403).send('Invalid state');

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

    db.updateBroadcasterScopes(parseInt(streamerId), 'channel:read:subscriptions moderator:read:followers bits:read');

    console.log(`[Auth] Broadcaster ${streamerId} authorized for sub sync`);
    res.redirect('/dashboard?msg=broadcaster_authorized');
  } catch (error) {
    console.error(`[Auth] Broadcaster callback error: ${error.message}`);
    res.status(500).send('Authorization failed');
  }
});

// --- YouTube OAuth (streamer links their YouTube account) ---

router.get('/youtube', (req, res) => {
  if (!req.streamer) return res.redirect('/auth/login');
  const redirectUri = `${config.app.url}/auth/youtube/callback`;
  const params = new URLSearchParams({
    client_id: config.youtube.botClientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/youtube',
    access_type: 'offline',
    prompt: 'consent',
    state: String(req.streamer.id),
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/youtube/callback', async (req, res) => {
  const { code, state: streamerId, error } = req.query;
  if (error) return res.redirect('/dashboard/youtube-chatbot?error=' + encodeURIComponent(error));
  if (!code || !streamerId) return res.redirect('/dashboard/youtube-chatbot?error=Missing parameters');
  if (String(streamerId) !== String(req.streamer?.id)) return res.redirect('/dashboard/youtube-chatbot?error=Invalid state');

  try {
    const redirectUri = `${config.app.url}/auth/youtube/callback`;
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.youtube.botClientId,
        client_secret: config.youtube.botClientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
    const tokenData = await tokenRes.json();

    // Get the user's YouTube channel info
    const channelRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    let channelName = null;
    if (channelRes.ok) {
      const channelData = await channelRes.json();
      channelName = channelData.items?.[0]?.snippet?.title || null;
    }

    db.updateStreamerYoutubeTokens(
      parseInt(streamerId),
      tokenData.access_token,
      tokenData.refresh_token,
      Date.now() + tokenData.expires_in * 1000 - 60_000,
      channelName
    );

    res.redirect('/dashboard/youtube-chatbot?connected_yt=1');
  } catch (err) {
    console.error('[Auth] YouTube OAuth error:', err.message);
    res.redirect('/dashboard/youtube-chatbot?error=' + encodeURIComponent(err.message));
  }
});

// --- Spotify OAuth (streamer links their Spotify account) ---

router.get('/spotify', (req, res) => {
  if (!req.streamer) return res.redirect('/auth/login');
  const { clientId } = config.spotify;
  if (!clientId) return res.status(500).send('Spotify not configured');

  const redirectUri = `${config.app.url}/auth/spotify/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'user-read-currently-playing',
    state: String(req.streamer.id),
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

router.get('/spotify/callback', async (req, res) => {
  const { code, state: streamerId, error } = req.query;
  if (error) return res.redirect('/dashboard?msg=spotify_error');
  if (!code || !streamerId) return res.redirect('/dashboard?msg=spotify_error');
  if (String(streamerId) !== String(req.streamer?.id)) return res.redirect('/dashboard?msg=spotify_error');

  try {
    const { clientId, clientSecret } = config.spotify;
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const redirectUri = `${config.app.url}/auth/spotify/callback`;

    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
    const tokenData = await tokenRes.json();

    db.updateSpotifyTokens(
      parseInt(streamerId),
      tokenData.access_token,
      tokenData.refresh_token,
      Date.now() + tokenData.expires_in * 1000 - 60000
    );

    res.redirect('/dashboard?msg=spotify_connected');
  } catch (err) {
    console.error('[Auth] Spotify OAuth error:', err.message);
    res.redirect('/dashboard?msg=spotify_error');
  }
});

// --- User Linking (community members link Twitch for sub sync) ---

router.get('/link', (req, res) => {
  const { streamer_id, discord_id } = req.query;
  if (!streamer_id || !discord_id) return res.status(400).render('link-result', { success: false, twitchName: null, streamer: null });

  const linkState = crypto.randomUUID();
  req.app.locals.secureCookie(res, 'link_state', linkState, { maxAge: 600_000 });
  req.app.locals.secureCookie(res, 'link_data', `${streamer_id}:${discord_id}`, { maxAge: 600_000 });

  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    redirect_uri: `${config.app.url}/auth/link/callback`,
    response_type: 'code',
    scope: '',
    state: linkState,
  });
  res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
});

router.get('/link/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).render('link-result', { success: false, twitchName: null, streamer: null });

  const expectedState = req.cookies?.link_state;
  const linkData = req.cookies?.link_data;
  res.clearCookie('link_state');
  res.clearCookie('link_data');
  if (!expectedState || state !== expectedState || !linkData) return res.status(403).render('link-result', { success: false, twitchName: null, streamer: null });

  const [streamerId, discordId] = linkData.split(':');
  if (!streamerId || !discordId) return res.status(400).render('link-result', { success: false, twitchName: null, streamer: null });

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

    res.render('link-result', { success: true, twitchName: twitchUser.display_name, streamer: null });
  } catch (error) {
    console.error(`[Auth] Link error: ${error.message}`);
    res.status(500).render('link-result', { success: false, twitchName: null, streamer: null });
  }
});

module.exports = router;
