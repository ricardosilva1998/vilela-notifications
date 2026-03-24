const config = require('../config');

const BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN || '';

async function apiCall(endpoint) {
  if (!BEARER_TOKEN) {
    console.warn('[Twitter] No TWITTER_BEARER_TOKEN configured');
    return null;
  }

  const res = await fetch(`https://api.twitter.com/2${endpoint}`, {
    headers: { Authorization: `Bearer ${BEARER_TOKEN}` },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twitter API error: ${res.status} ${text}`);
  }

  return res.json();
}

async function resolveProfile(username) {
  const clean = username.replace(/^@/, '').trim().toLowerCase();

  try {
    const data = await apiCall(`/users/by/username/${clean}?user.fields=profile_image_url,name`);
    if (!data?.data) return { username: clean, displayName: clean, profileImageUrl: null };

    const user = data.data;
    // Twitter returns _normal size images, replace with _400x400 for better quality
    const profileImageUrl = user.profile_image_url?.replace('_normal', '_400x400') || null;

    return {
      username: clean,
      displayName: user.name || clean,
      profileImageUrl,
      userId: user.id,
    };
  } catch (e) {
    console.error(`[Twitter] Failed to resolve profile ${clean}: ${e.message}`);

    // Fallback to unavatar.io
    const fallbackUrl = `https://unavatar.io/twitter/${clean}`;
    try {
      const check = await fetch(fallbackUrl, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(5000) });
      if (check.ok && check.headers.get('content-type')?.includes('image')) {
        const finalUrl = check.url || fallbackUrl;
        if (!finalUrl.includes('fallback') && !finalUrl.includes('default')) {
          return { username: clean, displayName: clean, profileImageUrl: fallbackUrl };
        }
      }
    } catch (e2) {}

    return { username: clean, displayName: clean, profileImageUrl: null };
  }
}

async function getLatestTweets(username) {
  const clean = username.replace(/^@/, '').trim().toLowerCase();

  try {
    // First resolve username to user ID
    const userData = await apiCall(`/users/by/username/${clean}?user.fields=id`);
    if (!userData?.data?.id) return null;

    const userId = userData.data.id;

    // Fetch recent tweets (excludes retweets and replies by default)
    const tweetsData = await apiCall(
      `/users/${userId}/tweets?max_results=10&tweet.fields=created_at,text,attachments&expansions=attachments.media_keys&media.fields=url,preview_image_url,type`
    );

    if (!tweetsData?.data) return [];

    // Build media lookup from includes
    const mediaMap = new Map();
    if (tweetsData.includes?.media) {
      for (const m of tweetsData.includes.media) {
        mediaMap.set(m.media_key, m);
      }
    }

    return tweetsData.data.slice(0, 20).map(tweet => {
      // Get first media URL if any
      let mediaUrl = null;
      if (tweet.attachments?.media_keys?.length > 0) {
        const media = mediaMap.get(tweet.attachments.media_keys[0]);
        if (media) {
          mediaUrl = media.url || media.preview_image_url || null;
        }
      }

      return {
        id: tweet.id,
        text: tweet.text?.slice(0, 500) || '',
        url: `https://twitter.com/${clean}/status/${tweet.id}`,
        mediaUrl,
        timestamp: tweet.created_at || null,
        author: clean,
      };
    });
  } catch (e) {
    console.error(`[Twitter] Failed to fetch tweets for ${clean}: ${e.message}`);
    return null;
  }
}

async function checkAvailability() {
  if (!BEARER_TOKEN) return false;
  try {
    const data = await apiCall('/users/by/username/twitter?user.fields=id');
    return !!data?.data?.id;
  } catch (e) {
    return false;
  }
}

module.exports = { resolveProfile, getLatestTweets, checkAvailability };
