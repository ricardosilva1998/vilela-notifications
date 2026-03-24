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

module.exports = { getLatestVideos, checkLiveStatus, getVideoDetails, resolveChannelId, getChannelInfo };
