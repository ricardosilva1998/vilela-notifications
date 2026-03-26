const { XMLParser } = require('fast-xml-parser');
const config = require('../config');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

async function getLatestVideos(youtubeChannelId) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${youtubeChannelId}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`YouTube RSS fetch failed: ${res.status}`);
  }

  const xml = await res.text();
  const parsed = parser.parse(xml);
  const entries = parsed.feed?.entry;

  if (!entries) return [];

  const items = Array.isArray(entries) ? entries : [entries];
  return items.map((entry) => ({
    id: entry['yt:videoId'],
    title: entry.title,
    url: entry.link?.['@_href'] || `https://www.youtube.com/watch?v=${entry['yt:videoId']}`,
    published: entry.published,
    author: entry.author?.name,
  }));
}

async function checkLiveStatus(videoIds, apiKey) {
  if (videoIds.length === 0 || !apiKey) return null;

  const ids = videoIds.slice(0, 5).join(',');
  const params = new URLSearchParams({
    part: 'liveStreamingDetails,snippet',
    id: ids,
    key: apiKey,
  });

  const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`);

  if (!res.ok) {
    throw new Error(`YouTube API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();

  for (const video of data.items || []) {
    const details = video.liveStreamingDetails;
    if (details?.actualStartTime && !details.actualEndTime) {
      return {
        id: video.id,
        title: video.snippet.title,
        description: video.snippet.description,
        thumbnail:
          video.snippet.thumbnails?.maxres?.url ||
          video.snippet.thumbnails?.high?.url ||
          `https://i.ytimg.com/vi/${video.id}/maxresdefault.jpg`,
      };
    }
  }

  return null;
}

async function getVideoDetails(videoIds, apiKey) {
  if (!videoIds.length || !apiKey) return {};
  const ids = videoIds.join(',');
  const params = new URLSearchParams({
    part: 'contentDetails',
    id: ids,
    key: apiKey,
  });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`);
  if (!res.ok) return {};
  const data = await res.json();

  const details = {};
  for (const item of data.items || []) {
    const duration = item.contentDetails?.duration || '';
    // Parse ISO 8601 duration (PT1M30S, PT59S, etc.)
    const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    const totalSeconds = (parseInt(match?.[1] || 0) * 3600) + (parseInt(match?.[2] || 0) * 60) + parseInt(match?.[3] || 0);
    details[item.id] = { duration: totalSeconds, isShort: totalSeconds > 0 && totalSeconds <= 60 };
  }
  return details;
}

function parseChannelPage(html) {
  // Extract channel ID
  const canonicalMatch = html.match(/https:\/\/www\.youtube\.com\/channel\/(UC[a-zA-Z0-9_-]+)/);
  const channelId = canonicalMatch?.[1] || null;

  // Extract channel name from <title>
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  const channelName = titleMatch?.[1]?.replace(' - YouTube', '').trim() || null;

  // Extract profile image from og:image or JSON-LD
  let profileImageUrl = null;
  const ogImageMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
  if (ogImageMatch) {
    profileImageUrl = ogImageMatch[1];
  }

  return { channelId, channelName, profileImageUrl };
}

async function fetchChannelPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Bot/1.0)' },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    console.error(`[YouTube] Failed to fetch ${url}: ${e.message}`);
    return null;
  }
}

async function resolveChannelId(input) {
  // If already a channel ID (starts with UC), fetch the channel page for name + image
  if (input.startsWith('UC') && input.length >= 20) {
    const html = await fetchChannelPage(`https://www.youtube.com/channel/${input}`);
    if (html) {
      const info = parseChannelPage(html);
      return { channelId: input, channelName: info.channelName, profileImageUrl: info.profileImageUrl };
    }
    return { channelId: input, channelName: null, profileImageUrl: null };
  }

  // Strip @ if present
  const handle = input.startsWith('@') ? input : `@${input}`;
  const html = await fetchChannelPage(`https://www.youtube.com/${handle}`);
  if (!html) return null;

  const info = parseChannelPage(html);
  if (!info.channelId) return null;

  return { channelId: info.channelId, channelName: info.channelName, profileImageUrl: info.profileImageUrl };
}

async function getChannelInfo(channelId) {
  const html = await fetchChannelPage(`https://www.youtube.com/channel/${channelId}`);
  if (!html) return null;
  return parseChannelPage(html);
}

async function getLiveChatId(videoId, apiKey) {
  const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}&key=${apiKey}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.items?.[0]?.liveStreamingDetails?.activeLiveChatId || null;
}

async function refreshYoutubeBotToken() {
  const config = require('../config');
  const { botRefreshToken, botClientId, botClientSecret } = config.youtube;
  if (!botRefreshToken || !botClientId || !botClientSecret) return null;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: botClientId,
      client_secret: botClientSecret,
      refresh_token: botRefreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    console.error('[YouTube] Bot token refresh failed:', res.status);
    return null;
  }
  const data = await res.json();
  return data.access_token;
}

async function sendYoutubeChatMessage(liveChatId, message, accessToken) {
  const res = await fetch('https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      snippet: {
        liveChatId,
        type: 'textMessageEvent',
        textMessageDetails: { messageText: message },
      },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error('[YouTube] Failed to send chat message:', res.status, JSON.stringify(err.error || err));
  } else {
    console.log('[YouTube] Chat message sent successfully');
  }
}

async function fetchLiveChatMessages(liveChatId, pageToken, accessToken) {
  const params = new URLSearchParams({
    liveChatId,
    part: 'id,snippet,authorDetails',
  });
  if (pageToken) params.set('pageToken', pageToken);

  const res = await fetch(`https://www.googleapis.com/youtube/v3/liveChat/messages?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error(`[YouTube] fetchLiveChatMessages failed: ${res.status}`, err.substring(0, 200));
    return null;
  }
  return res.json();
}

async function findActiveLiveStream(channelId, apiKey) {
  if (!channelId || !apiKey) return null;

  const params = new URLSearchParams({
    part: 'id',
    channelId,
    type: 'video',
    eventType: 'live',
    key: apiKey,
  });

  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
  if (!res.ok) return null;

  const data = await res.json();
  if (!data.items || data.items.length === 0) return null;

  return data.items[0].id.videoId;
}

async function refreshStreamerYoutubeToken(streamer) {
  const db = require('../db');
  if (!streamer.yt_refresh_token) return null;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.youtube.botClientId,
      client_secret: config.youtube.botClientSecret,
      refresh_token: streamer.yt_refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) return null;
  const data = await res.json();

  db.updateStreamerYoutubeTokens(
    streamer.id,
    data.access_token,
    data.refresh_token || streamer.yt_refresh_token,
    Date.now() + data.expires_in * 1000 - 60_000,
    streamer.yt_channel_name
  );

  return data.access_token;
}

async function getActiveBroadcast(accessToken) {
  // Use mine=true to get all broadcasts, then filter for active ones
  const res = await fetch('https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status&mine=true&maxResults=10', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error(`[YouTube] liveBroadcasts.list failed: ${res.status}`, err);
    return null;
  }
  const data = await res.json();
  // Find one that is currently live
  const active = (data.items || []).find(item =>
    item.status?.lifeCycleStatus === 'live' || item.status?.lifeCycleStatus === 'liveStarting'
  );
  if (!active) {
    console.log(`[YouTube] No active broadcast found (${data.items?.length || 0} total broadcasts)`);
    return null;
  }
  console.log(`[YouTube] Found active broadcast: "${active.snippet.title}"`);
  return {
    liveChatId: active.snippet.liveChatId,
    title: active.snippet.title,
  };
}

module.exports = { getLatestVideos, checkLiveStatus, getVideoDetails, resolveChannelId, getChannelInfo, getLiveChatId, refreshYoutubeBotToken, sendYoutubeChatMessage, fetchLiveChatMessages, findActiveLiveStream, refreshStreamerYoutubeToken, getActiveBroadcast };
