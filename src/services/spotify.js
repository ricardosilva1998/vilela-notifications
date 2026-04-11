const config = require('../config');
const db = require('../db');

async function refreshSpotifyToken(streamer) {
  const { clientId, clientSecret } = config.spotify;
  if (!clientId || !clientSecret || !streamer.spotify_refresh_token) return null;

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: streamer.spotify_refresh_token,
    }),
  });

  if (!res.ok) {
    console.error('[Spotify] Token refresh failed:', res.status);
    return null;
  }

  const data = await res.json();
  db.updateSpotifyTokens(
    streamer.id,
    data.access_token,
    data.refresh_token || streamer.spotify_refresh_token,
    Date.now() + data.expires_in * 1000 - 60000
  );

  return data.access_token;
}

async function getCurrentlyPlaying(streamer) {
  if (!streamer.spotify_access_token) return { status: 'not_connected' };

  let token = streamer.spotify_access_token;
  if (streamer.spotify_token_expires_at && Date.now() >= streamer.spotify_token_expires_at) {
    token = await refreshSpotifyToken(streamer);
    if (!token) return { status: 'not_connected' };
  }

  const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 204) return { status: 'nothing_playing' };
  if (res.status === 401) {
    // Try refresh once
    token = await refreshSpotifyToken(streamer);
    if (!token) return { status: 'not_connected' };
    const retry = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (retry.status === 204) return { status: 'nothing_playing' };
    if (!retry.ok) return { status: 'error' };
    const data = await retry.json();
    return parseTrack(data);
  }
  if (!res.ok) return { status: 'error' };

  const data = await res.json();
  return parseTrack(data);
}

function parseTrack(data) {
  if (!data.item) return { status: 'nothing_playing' };
  const images = data.item.album?.images || [];
  return {
    status: data.is_playing ? 'playing' : 'paused',
    track: data.item.name,
    artist: data.item.artists.map(a => a.name).join(', '),
    album: data.item.album?.name,
    url: data.item.external_urls?.spotify,
    albumArt: images.length > 0 ? (images.find(i => i.width <= 300) || images[0]).url : null,
    progressMs: data.progress_ms || 0,
    durationMs: data.item.duration_ms || 0,
  };
}

module.exports = { getCurrentlyPlaying, refreshSpotifyToken };
