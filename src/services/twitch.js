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

async function getUserProfile(username) {
  const data = await apiCall(`/users?login=${encodeURIComponent(username)}`);
  const user = data.data?.[0];
  if (!user) return null;
  return { id: user.id, login: user.login, display_name: user.display_name, profile_image_url: user.profile_image_url };
}

async function getClips(broadcasterId, startedAt, endedAt) {
  const params = new URLSearchParams({
    broadcaster_id: broadcasterId,
    started_at: startedAt,
    first: '10',
  });
  if (endedAt) params.set('ended_at', endedAt);
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

async function getVideos(broadcasterId, startedAfter) {
  const params = new URLSearchParams({
    user_id: broadcasterId,
    type: 'archive',
    first: '20',
  });
  const data = await apiCall(`/videos?${params}`);
  const videos = data.data || [];
  if (startedAfter) {
    return videos.filter((v) => v.created_at >= startedAfter);
  }
  return videos;
}

async function getFollowerCount(broadcasterId, broadcasterAccessToken) {
  const params = new URLSearchParams({
    broadcaster_id: broadcasterId,
    first: '1',
  });

  const res = await fetch(`https://api.twitch.tv/helix/channels/followers?${params}`, {
    headers: {
      Authorization: `Bearer ${broadcasterAccessToken}`,
      'Client-Id': config.twitch.clientId,
    },
  });

  if (!res.ok) {
    throw new Error(`Followers API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.total || 0;
}

async function getGameNames(gameIds) {
  if (!gameIds || gameIds.length === 0) return [];
  const params = new URLSearchParams();
  for (const id of gameIds) {
    params.append('id', id);
  }
  const data = await apiCall(`/games?${params}`);
  return (data.data || []).map((g) => g.name);
}

module.exports = { getStream, getUserId, getUserProfile, getClips, getSubscribers, getVideos, getFollowerCount, getGameNames };
