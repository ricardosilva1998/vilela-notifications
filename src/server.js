const express = require('express');
const config = require('./config');
const { loadAuth, saveAuth, linkUser } = require('./auth');

const app = express();

// Broadcaster auth - andre_vilela_ visits this to authorize the bot to read subscribers
app.get('/auth/broadcaster', (req, res) => {
  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    redirect_uri: `${config.app.url}/auth/broadcaster/callback`,
    response_type: 'code',
    scope: 'channel:read:subscriptions',
  });
  res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
});

app.get('/auth/broadcaster/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');

  try {
    const params = new URLSearchParams({
      client_id: config.twitch.clientId,
      client_secret: config.twitch.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: `${config.app.url}/auth/broadcaster/callback`,
    });

    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      body: params,
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error(`[Auth] Broadcaster token exchange failed: ${text}`);
      return res.status(500).send('Token exchange failed');
    }

    const data = await tokenRes.json();
    const auth = loadAuth();
    auth.broadcasterAccessToken = data.access_token;
    auth.broadcasterRefreshToken = data.refresh_token;
    auth.broadcasterTokenExpiresAt = Date.now() + data.expires_in * 1000 - 60_000;
    saveAuth(auth);

    console.log('[Auth] Broadcaster authorized successfully');
    res.send('Broadcaster authorized! You can close this page. The bot can now check subscribers.');
  } catch (error) {
    console.error(`[Auth] Broadcaster callback error: ${error.message}`);
    res.status(500).send('Authorization failed');
  }
});

// User linking - Discord users visit this to link their Twitch account
app.get('/auth/link', (req, res) => {
  const { discord_id } = req.query;
  if (!discord_id) return res.status(400).send('Missing discord_id');

  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    redirect_uri: `${config.app.url}/auth/link/callback`,
    response_type: 'code',
    scope: '',
    state: discord_id,
  });
  res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
});

app.get('/auth/link/callback', async (req, res) => {
  const { code, state: discordId } = req.query;
  if (!code || !discordId) return res.status(400).send('Missing code or state');

  try {
    // Exchange code for token
    const tokenParams = new URLSearchParams({
      client_id: config.twitch.clientId,
      client_secret: config.twitch.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: `${config.app.url}/auth/link/callback`,
    });

    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      body: tokenParams,
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error(`[Auth] User token exchange failed: ${text}`);
      return res.status(500).send('Token exchange failed');
    }

    const tokenData = await tokenRes.json();

    // Get the user's Twitch identity
    const userRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'Client-Id': config.twitch.clientId,
      },
    });

    if (!userRes.ok) {
      return res.status(500).send('Failed to get Twitch user info');
    }

    const userData = await userRes.json();
    const twitchUser = userData.data[0];

    // Save the link
    linkUser(discordId, twitchUser.id, twitchUser.login);
    console.log(`[Auth] Linked Discord ${discordId} -> Twitch ${twitchUser.login} (${twitchUser.id})`);

    res.send(`Linked! Your Twitch account (${twitchUser.display_name}) is now connected to your Discord. You can close this page.`);
  } catch (error) {
    console.error(`[Auth] Link callback error: ${error.message}`);
    res.status(500).send('Linking failed');
  }
});

// Health check
app.get('/', (req, res) => {
  res.send('Vilela Notifications Bot is running');
});

function start() {
  const port = config.app.port;
  app.listen(port, () => {
    console.log(`[Server] Listening on port ${port}`);
    console.log(`[Server] Broadcaster auth: ${config.app.url}/auth/broadcaster`);
    console.log(`[Server] User link: ${config.app.url}/auth/link?discord_id=DISCORD_USER_ID`);
  });
}

module.exports = { start };
