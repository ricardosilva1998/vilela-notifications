const crypto = require('crypto');

const IRACING_EMAIL = process.env.IRACING_EMAIL || '';
const IRACING_PASSWORD = process.env.IRACING_PASSWORD || '';
const BASE_URL = 'https://members-ng.iracing.com';

const API_DELAY_MS = 2000;
const MAX_RETRIES = 3;

let cookies = '';
let lastApiCall = 0;

function isConfigured() {
  return !!(IRACING_EMAIL && IRACING_PASSWORD);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Enforce 2-second delay between sequential API calls per spec.
 */
async function throttle() {
  const now = Date.now();
  const elapsed = now - lastApiCall;
  if (elapsed < API_DELAY_MS) {
    await sleep(API_DELAY_MS - elapsed);
  }
  lastApiCall = Date.now();
}

/**
 * Authenticate with iRacing Data API.
 * Password encoding: SHA-256(password + email.toLowerCase()), then Base64.
 */
async function login() {
  if (!isConfigured()) return false;

  const hash = crypto
    .createHash('sha256')
    .update(IRACING_PASSWORD + IRACING_EMAIL.toLowerCase())
    .digest('base64');

  try {
    const res = await fetch(`${BASE_URL}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: IRACING_EMAIL, password: hash }),
    });

    const body = await res.json().catch(() => ({}));
    console.log(`[iRacing] Auth response: ${res.status}, authcode: ${!!body.authcode}`);

    if (res.status === 200 && body.authcode) {
      // Collect cookies from response
      const setCookies = res.headers.getSetCookie?.() || [];
      if (setCookies.length > 0) {
        cookies = setCookies.map((c) => c.split(';')[0]).join('; ');
      }
      console.log('[iRacing] Authenticated successfully');
      return true;
    }

    console.error(`[iRacing] Authentication failed: ${res.status}`, JSON.stringify(body));
    cookies = '';
    return false;
  } catch (e) {
    console.error(`[iRacing] Auth error: ${e.message}`);
    cookies = '';
    return false;
  }
}

/**
 * Two-step API call: fetch iRacing endpoint (returns S3 link), then follow the link.
 * Handles 401 re-auth and 429/503 backoff with retries.
 */
async function apiCall(endpoint, retries = 0) {
  if (!isConfigured()) return null;
  if (!cookies) {
    const ok = await login();
    if (!ok) return null;
  }

  await throttle();

  let res;
  try {
    res = await fetch(`${BASE_URL}${endpoint}`, {
      headers: { Cookie: cookies },
    });
  } catch (err) {
    console.error(`[iRacing] Fetch error for ${endpoint}:`, err.message);
    return null;
  }

  // Re-auth on 401
  if (res.status === 401) {
    console.log('[iRacing] Got 401, re-authenticating...');
    const ok = await login();
    if (!ok) return null;
    return apiCall(endpoint, retries);
  }

  // Backoff on 429/503
  if ((res.status === 429 || res.status === 503) && retries < MAX_RETRIES) {
    const backoff = Math.pow(2, retries + 1) * 1000;
    console.log(`[iRacing] Got ${res.status}, retrying in ${backoff}ms (attempt ${retries + 1}/${MAX_RETRIES})`);
    await sleep(backoff);
    return apiCall(endpoint, retries + 1);
  }

  if (!res.ok) {
    console.error(`[iRacing] API error: ${res.status} for ${endpoint}`);
    return null;
  }

  let linkData;
  try {
    linkData = await res.json();
  } catch (err) {
    console.error(`[iRacing] JSON parse error for ${endpoint}:`, err.message);
    return null;
  }

  // Step 2: Follow the S3 link to get actual data
  if (linkData.link) {
    try {
      const s3Res = await fetch(linkData.link);
      if (!s3Res.ok) {
        console.error(`[iRacing] S3 fetch error: ${s3Res.status} for ${endpoint}`);
        return null;
      }
      return await s3Res.json();
    } catch (err) {
      console.error(`[iRacing] S3 error for ${endpoint}:`, err.message);
      return null;
    }
  }

  // Some endpoints may return data directly
  return linkData;
}

/**
 * Get recent races for a driver.
 * Calls /data/results/search_series with cust_id, official_only, event_types=5 (race).
 * Returns array of { subsession_id, series_name, start_time, track, car_id }.
 */
async function getRecentRaces(customerId) {
  if (!isConfigured()) return [];

  const data = await apiCall(
    `/data/results/search_series?cust_id=${customerId}&official_only=true&event_types=5`
  );

  if (!data) return [];

  // The search_series endpoint returns data.results or the top-level array
  const results = Array.isArray(data) ? data : data.results || data.data?.results || [];

  // Sort by start_time desc (most recent first), take last 10
  const sorted = results
    .sort((a, b) => {
      const timeA = new Date(a.end_time || a.start_time || 0).getTime();
      const timeB = new Date(b.end_time || b.start_time || 0).getTime();
      return timeB - timeA;
    })
    .slice(0, 10);

  return sorted.map((r) => ({
    subsession_id: r.subsession_id,
    series_name: r.series_name || r.series_short_name || '',
    start_time: r.start_time || r.end_time || '',
    track: r.track?.track_name || r.track_name || '',
    car_id: r.car_id || null,
  }));
}

/**
 * Get detailed race result for a subsession.
 * Calls /data/results/get with subsession_id.
 * Returns the full session result object.
 */
async function getRaceResult(subsessionId) {
  if (!isConfigured()) return null;

  const data = await apiCall(`/data/results/get?subsession_id=${subsessionId}`);
  if (!data) return null;

  return data;
}

/**
 * Get driver profile.
 * Calls /data/member/get with cust_ids.
 * Returns { customerId, displayName, iRating, safetyRating, licenseClass } per category.
 */
async function getDriverProfile(customerId) {
  if (!isConfigured()) return null;

  const data = await apiCall(`/data/member/get?cust_ids=${customerId}`);
  if (!data) return null;

  // The member/get endpoint returns { members: [...] } or similar
  const members = data.members || (Array.isArray(data) ? data : [data]);
  const member = members.find((m) => String(m.cust_id) === String(customerId)) || members[0];

  if (!member) return null;

  // Extract license info per category
  const licenses = member.licenses || [];
  const categories = {};
  for (const lic of licenses) {
    const catName = (lic.category || '').toLowerCase().replace(/\s+/g, '_');
    if (catName) {
      categories[catName] = {
        iRating: lic.irating || 0,
        safetyRating: lic.safety_rating || 0,
        licenseClass: lic.group_name || lic.license_level || '',
      };
    }
  }

  return {
    customerId: member.cust_id,
    displayName: member.display_name || `Driver ${customerId}`,
    categories,
    // Convenience accessors for primary categories
    iRatingRoad: categories.road?.iRating || 0,
    iRatingOval: categories.oval?.iRating || 0,
    iRatingDirtRoad: categories.dirt_road?.iRating || 0,
    iRatingDirtOval: categories.dirt_oval?.iRating || 0,
    safetyRatingRoad: categories.road?.safetyRating || 0,
    safetyRatingOval: categories.oval?.safetyRating || 0,
    safetyRatingDirtRoad: categories.dirt_road?.safetyRating || 0,
    safetyRatingDirtOval: categories.dirt_oval?.safetyRating || 0,
    licenseClass: categories.road?.licenseClass || '',
  };
}

/**
 * Get qualifying bests for a driver.
 * Calls /data/stats/member_bests with cust_id.
 */
async function getQualifyingBests(customerId, categoryId) {
  if (!isConfigured()) return [];

  let endpoint = `/data/stats/member_bests?cust_id=${customerId}`;
  if (categoryId) {
    endpoint += `&car_type=${categoryId}`;
  }

  const data = await apiCall(endpoint);
  if (!data) return [];

  return Array.isArray(data) ? data : data.stats || data.bests || [];
}

module.exports = {
  isConfigured,
  login,
  getRecentRaces,
  getRaceResult,
  getDriverProfile,
  getQualifyingBests,
};
