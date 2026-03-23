const config = require('../config');
const db = require('../db');
const { getSubscribers } = require('../services/twitch');
const { client } = require('../discord');

async function refreshBroadcasterToken(streamer) {
  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    client_secret: config.twitch.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: streamer.broadcaster_refresh_token,
  });

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    body: params,
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);

  const data = await res.json();
  db.updateStreamerBroadcasterTokens(
    streamer.id,
    data.access_token,
    data.refresh_token,
    Date.now() + data.expires_in * 1000 - 60_000
  );

  return data.access_token;
}

async function checkStreamer(streamer) {
  if (!streamer.broadcaster_access_token) return;

  const pollerState = db.getPollerState(streamer.id);
  const broadcasterId = pollerState.twitch_broadcaster_id;
  if (!broadcasterId) return;

  let accessToken = streamer.broadcaster_access_token;
  if (Date.now() >= streamer.broadcaster_token_expires_at) {
    accessToken = await refreshBroadcasterToken(streamer);
  }

  const subscribers = await getSubscribers(broadcasterId, accessToken);
  const subscriberTwitchIds = new Set(subscribers.map((s) => s.user_id));
  const linkedUsers = db.getLinkedUsers(streamer.id);

  // Get all guilds with sub sync enabled for this streamer
  const guilds = db.getGuildsForStreamer(streamer.id).filter(
    (g) => g.sub_sync_enabled && g.sub_role_id
  );

  for (const guildConfig of guilds) {
    const guild = client.guilds.cache.get(guildConfig.guild_id);
    if (!guild) continue;

    const role = guild.roles.cache.get(guildConfig.sub_role_id);
    if (!role) continue;

    for (const link of linkedUsers) {
      try {
        const member = await guild.members.fetch(link.discord_user_id).catch(() => null);
        if (!member) continue;

        const isSub = subscriberTwitchIds.has(link.twitch_user_id);
        const hasRole = member.roles.cache.has(guildConfig.sub_role_id);

        if (isSub && !hasRole) {
          await member.roles.add(role);
          console.log(`[SubSync] +role ${member.user.username} in ${guild.name}`);
        } else if (!isSub && hasRole) {
          await member.roles.remove(role);
          console.log(`[SubSync] -role ${member.user.username} in ${guild.name}`);
        }
      } catch (error) {
        console.error(`[SubSync] Role sync error: ${error.message}`);
      }
    }
  }
}

module.exports = { checkStreamer };
