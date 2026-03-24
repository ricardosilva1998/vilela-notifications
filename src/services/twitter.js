const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const RSSHUB_INSTANCES = ['https://rsshub.app', 'https://rsshub.rssforever.com', 'https://rsshub-instance.zeabur.app'];

async function resolveProfile(username) {
  // Strip @ if present
  const clean = username.replace(/^@/, '').trim().toLowerCase();
  const profileImageUrl = `https://unavatar.io/twitter/${clean}`;

  // Try to get display name from RSSHub feed channel title
  let displayName = clean;
  for (const instance of RSSHUB_INSTANCES) {
    try {
      const res = await fetch(`${instance}/twitter/user/${clean}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Bot/1.0)' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const parsed = parser.parse(xml);
      const channelTitle = parsed.rss?.channel?.title;
      if (channelTitle) {
        // Channel title is typically "username's Twitter" or similar
        displayName = channelTitle.replace(/'s Twitter$/i, '').replace(/ - Twitter$/i, '').trim() || clean;
      }
      break;
    } catch (e) {
      console.warn(`[Twitter] RSSHub instance ${instance} failed for profile ${clean}: ${e.message}`);
      continue;
    }
  }

  // Verify the unavatar URL returns a real image (not the default smiley)
  try {
    const check = await fetch(profileImageUrl, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(5000) });
    if (check.ok && check.headers.get('content-type')?.includes('image')) {
      const finalUrl = check.url || profileImageUrl;
      if (!finalUrl.includes('fallback') && !finalUrl.includes('default')) {
        return { username: clean, displayName, profileImageUrl };
      }
    }
  } catch (e) {}

  return { username: clean, displayName, profileImageUrl: null };
}

async function getLatestTweets(username) {
  const clean = username.replace(/^@/, '').trim().toLowerCase();
  for (const instance of RSSHUB_INSTANCES) {
    try {
      const res = await fetch(`${instance}/twitter/user/${clean}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Bot/1.0)' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const parsed = parser.parse(xml);
      const items = parsed.rss?.channel?.item;
      if (!items) continue;
      const entries = Array.isArray(items) ? items : [items];
      return entries.slice(0, 20).map(item => {
        const link = item.link || '';
        const id = link.match(/\/status\/(\d+)/)?.[1] || link;
        const description = item.description || '';
        // Extract text content (strip HTML tags)
        const text = description.replace(/<[^>]+>/g, '').trim();
        // Extract first media image from description
        const mediaMatch = description.match(/<img[^>]+src="([^"]+)"/);
        return {
          id,
          text: text.slice(0, 500),
          url: link,
          mediaUrl: mediaMatch?.[1] || null,
          timestamp: item.pubDate || null,
          author: username,
        };
      });
    } catch (e) {
      console.warn(`[Twitter] RSSHub instance ${instance} failed for ${clean}: ${e.message}`);
      continue;
    }
  }
  return null; // all instances failed
}

async function checkAvailability() {
  for (const instance of RSSHUB_INSTANCES) {
    try {
      const res = await fetch(`${instance}/twitter/user/elonmusk`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Bot/1.0)' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) return true;
    } catch (e) {
      continue;
    }
  }
  return false;
}

module.exports = { resolveProfile, getLatestTweets, checkAvailability };
