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

module.exports = { getLatestVideos, checkLiveStatus };
