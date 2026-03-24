const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const RSSHUB_INSTANCES = ['https://rsshub.app', 'https://rsshub.rssforever.com', 'https://rsshub-instance.zeabur.app'];

async function resolveProfile(username) {
  const clean = username.replace(/^@/, '').trim().toLowerCase();

  // Use unavatar.io for profile image (works without auth)
  const profileImageUrl = `https://unavatar.io/instagram/${clean}`;

  // Try to get display name from RSSHub feed
  let displayName = clean;
  for (const instance of RSSHUB_INSTANCES) {
    try {
      const res = await fetch(`${instance}/instagram/user/${clean}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Bot/1.0)' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const parsed = parser.parse(xml);
      const title = parsed.rss?.channel?.title;
      if (title) {
        displayName = title.replace(/ on Instagram$/, '').replace(/ - Instagram$/, '').trim() || clean;
      }
      break;
    } catch (e) {
      continue;
    }
  }

  // Verify the unavatar URL actually returns an image (not a fallback)
  try {
    const check = await fetch(profileImageUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    if (check.ok && check.headers.get('content-type')?.includes('image')) {
      return { username: clean, displayName, profileImageUrl };
    }
  } catch (e) {}

  return { username: clean, displayName, profileImageUrl: null };
}

async function getLatestPosts(username) {
  const clean = username.replace(/^@/, '').trim().toLowerCase();
  for (const instance of RSSHUB_INSTANCES) {
    try {
      const res = await fetch(`${instance}/instagram/user/${clean}`, {
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
        const id = link.match(/\/p\/([^/]+)/)?.[1] || link;
        const imageMatch = (item.description || '').match(/<img[^>]+src="([^"]+)"/);
        return {
          id,
          caption: (item.title || '').slice(0, 200),
          url: link,
          imageUrl: imageMatch?.[1] || null,
          timestamp: item.pubDate || null,
          author: username,
        };
      });
    } catch (e) {
      console.warn(`[Instagram] RSSHub instance ${instance} failed for ${clean}: ${e.message}`);
      continue;
    }
  }
  return null; // all instances failed
}

module.exports = { resolveProfile, getLatestPosts };
