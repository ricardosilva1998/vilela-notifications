const config = require('../config');

let accessToken = null;
let tokenExpiresAt = 0;

// App-level auth (client credentials) — shared across all streamers
async function authenticate() {
  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    client_secret: config.twitch.clientSecret,
    grant_type: 'client_credentials',
  });

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    body: params,
  });

  if (!res.ok) {
    throw new Error(`Twitch auth failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000 - 60_000;
}

async function apiCall(endpoint) {
  if (!accessToken || Date.now() >= tokenExpiresAt) {
    await authenticate();
  }

  const res = await fetch(`https://api.twitch.tv/helix${endpoint}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Client-Id': config.twitch.clientId,
    },
  });

  if (res.status === 401) {
    await authenticate();
    return apiCall(endpoint);
  }

  if (!res.ok) {
    throw new Error(`Twitch API error: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

async function getStream(username) {
  const data = await apiCall(`/streams?user_login=${encodeURIComponent(username)}`);
  return data.data?.[0] || null;
}

async function getUserId(username) {
  const data = await apiCall(`/users?login=${encodeURIComponent(username)}`);
  return data.data?.[0]?.id || null;
}

async function getClips(broadcasterId, startedAt) {
  const params = new URLSearchParams({
    broadcaster_id: broadcasterId,
    started_at: startedAt,
    first: '10',
  });
  const data = await apiCall(`/clips?${params}`);
  return data.data || [];
}

async function getSubscribers(broadcasterId, broadcasterAccessToken) {
  const subs = [];
  let cursor = null;

  do {
    const params = new URLSearchParams({
      broadcaster_id: broadcasterId,
      first: '100',
    });
    if (cursor) params.set('after', cursor);

    const res = await fetch(`https://api.twitch.tv/helix/subscriptions?${params}`, {
      headers: {
        Authorization: `Bearer ${broadcasterAccessToken}`,
        'Client-Id': config.twitch.clientId,
      },
    });

    if (!res.ok) {
      throw new Error(`Subscriptions API error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    subs.push(...data.data);
    cursor = data.pagination?.cursor || null;
  } while (cursor);

  return subs;
}

module.exports = { getStream, getUserId, getClips, getSubscribers };
