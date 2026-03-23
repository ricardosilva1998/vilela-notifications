const config = require('../config');
const { loadAuth, saveAuth, getLinkedUsers } = require('../auth');
const { client } = require('../discord');

async function refreshBroadcasterToken(auth) {
  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    client_secret: config.twitch.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: auth.broadcasterRefreshToken,
  });

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    body: params,
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  auth.broadcasterAccessToken = data.access_token;
  auth.broadcasterRefreshToken = data.refresh_token;
  auth.broadcasterTokenExpiresAt = Date.now() + data.expires_in * 1000 - 60_000;
  saveAuth(auth);
  console.log('[SubSync] Broadcaster token refreshed');
}

async function getSubscribers(auth) {
  if (Date.now() >= auth.broadcasterTokenExpiresAt) {
    await refreshBroadcasterToken(auth);
  }

  const subs = [];
  let cursor = null;

  do {
    const params = new URLSearchParams({
      broadcaster_id: config.twitch.broadcasterId,
      first: '100',
    });
    if (cursor) params.set('after', cursor);

    const res = await fetch(`https://api.twitch.tv/helix/subscriptions?${params}`, {
      headers: {
        Authorization: `Bearer ${auth.broadcasterAccessToken}`,
        'Client-Id': config.twitch.clientId,
      },
    });

    if (res.status === 401) {
      await refreshBroadcasterToken(auth);
      return getSubscribers(auth);
    }

    if (!res.ok) {
      throw new Error(`Subscriptions API error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    subs.push(...data.data);
    cursor = data.pagination?.cursor || null;
  } while (cursor);

  return subs;
}

async function poll() {
  try {
    const auth = loadAuth();
    if (!auth.broadcasterAccessToken) {
      return; // Broadcaster hasn't authorized yet, skip silently
    }

    const links = getLinkedUsers();
    const linkedDiscordIds = Object.keys(links);
    if (linkedDiscordIds.length === 0) {
      return; // No linked users yet
    }

    // Get all subscribers
    const subscribers = await getSubscribers(auth);
    const subscriberTwitchIds = new Set(subscribers.map((s) => s.user_id));

    // Get the Discord guild and role
    const guild = client.guilds.cache.first();
    if (!guild) {
      console.error('[SubSync] No guild found');
      return;
    }

    const role = guild.roles.cache.get(config.discord.subRoleId);
    if (!role) {
      console.error(`[SubSync] Role ${config.discord.subRoleId} not found`);
      return;
    }

    // Sync roles for each linked user
    for (const [discordId, { twitchUserId, twitchUsername }] of Object.entries(links)) {
      try {
        const member = await guild.members.fetch(discordId).catch(() => null);
        if (!member) continue; // User left the server

        const isSub = subscriberTwitchIds.has(twitchUserId);
        const hasRole = member.roles.cache.has(config.discord.subRoleId);

        if (isSub && !hasRole) {
          await member.roles.add(role);
          console.log(`[SubSync] Added sub role to ${member.user.username} (Twitch: ${twitchUsername})`);
        } else if (!isSub && hasRole) {
          await member.roles.remove(role);
          console.log(`[SubSync] Removed sub role from ${member.user.username} (Twitch: ${twitchUsername})`);
        }
      } catch (error) {
        console.error(`[SubSync] Failed to sync role for Discord ${discordId}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`[SubSync] Poll failed: ${error.message}`);
  }
}

function start() {
  if (!config.discord.subRoleId) {
    console.log('[SubSync] Disabled (DISCORD_SUB_ROLE_ID not set)');
    return;
  }

  setInterval(poll, config.intervals.subSync);
  console.log(`[SubSync] Polling every ${config.intervals.subSync / 1000}s`);

  // Run immediately on start
  poll();
}

module.exports = { start };
