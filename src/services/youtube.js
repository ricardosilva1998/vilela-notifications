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

async function resolveChannelId(input) {
  // If already a channel ID (starts with UC), return as-is
  if (input.startsWith('UC') && input.length >= 20) return { channelId: input, channelName: null };

  // Strip @ if present
  const handle = input.startsWith('@') ? input : `@${input}`;

  // Fetch the YouTube channel page and extract the channel ID from meta tags
  try {
    const res = await fetch(`https://www.youtube.com/${handle}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Bot/1.0)' },
      redirect: 'follow',
    });
    if (!res.ok) return null;

    const html = await res.text();

    // Extract channel ID from <link rel="canonical" href="https://www.youtube.com/channel/UCxxxx">
    const canonicalMatch = html.match(/https:\/\/www\.youtube\.com\/channel\/(UC[a-zA-Z0-9_-]+)/);
    const channelId = canonicalMatch?.[1];
    if (!channelId) return null;

    // Try to extract channel name from <title>
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    const channelName = titleMatch?.[1]?.replace(' - YouTube', '').trim() || null;

    return { channelId, channelName };
  } catch (e) {
    console.error(`[YouTube] Failed to resolve handle ${handle}: ${e.message}`);
    return null;
  }
}

module.exports = { getLatestVideos, checkLiveStatus, resolveChannelId };
