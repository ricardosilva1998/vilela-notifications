const db = require('../db');
const config = require('../config');
const { sendNotification, buildWeeklyDigestEmbed } = require('../discord');
const { getVideos, getClips, getUserId, getGameNames } = require('../services/twitch');

async function pollWeeklyDigest() {
  const now = new Date();

  // Only trigger on Mondays between 09:00 and 09:59 UTC
  if (now.getUTCDay() !== 1 || now.getUTCHours() !== 9) return;

  const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const guildsToDigest = db.getGuildsWithWeeklyHighlights();

  // Per-channel data cache to avoid duplicate API calls
  const channelCache = new Map();
  const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  for (const { guild_id, streamer_id } of guildsToDigest) {
    try {
      // Check tier
      const tier = db.getStreamerTier(streamer_id);
      const tierConfig = config.tiers[tier] || config.tiers.free;
      if (!tierConfig.weeklyHighlights) continue;

      // Check if already posted this week
      const digestState = db.getWeeklyDigestState(guild_id);
      if (digestState?.last_digest_date === todayStr) continue;

      // Get posting channel
      const channelId = db.getDigestChannelForGuild(guild_id);
      if (!channelId) continue;

      // Gather data for all watched Twitch channels in this guild
      const watchedChannels = db.getWatchedChannelsForGuild(guild_id, streamer_id);
      let totalStreams = 0;
      let totalSeconds = 0;
      const allCategories = new Set();
      let topClip = null;

      for (const wc of watchedChannels) {
        const username = wc.twitch_username;

        if (!channelCache.has(username)) {
          // Resolve broadcaster ID
          const state = db.getChannelState(username);
          let broadcasterId = state?.twitch_broadcaster_id;
          if (!broadcasterId) {
            broadcasterId = await getUserId(username);
            if (broadcasterId) {
              db.updateChannelState(username, { twitch_broadcaster_id: broadcasterId });
            }
          }

          if (!broadcasterId) {
            channelCache.set(username, { videos: [], clips: [] });
            continue;
          }

          try {
            const videos = await getVideos(broadcasterId, oneWeekAgo);
            const clips = await getClips(broadcasterId, oneWeekAgo);
            channelCache.set(username, { videos, clips });
          } catch (e) {
            console.error(`[WeeklyDigest] API error for ${username}: ${e.message}`);
            channelCache.set(username, { videos: [], clips: [] });
          }
        }

        const cached = channelCache.get(username);

        // Aggregate videos (streams)
        for (const v of cached.videos) {
          totalStreams++;
          // Twitch duration format: "1h2m3s" or "2m3s" etc.
          totalSeconds += parseTwitchDuration(v.duration);
          // Videos don't have game_name, but we can try
        }

        // Find top clip
        for (const c of cached.clips) {
          if (!topClip || c.view_count > topClip.view_count) {
            topClip = c;
          }
        }

        // Resolve game names from clip game_ids
        const gameIds = [...new Set(cached.clips.map(c => c.game_id).filter(Boolean))];
        if (gameIds.length > 0) {
          const names = await getGameNames(gameIds);
          for (const name of names) allCategories.add(name);
        }
      }

      // Skip if no activity
      if (totalStreams === 0 && !topClip) continue;

      const embed = buildWeeklyDigestEmbed({
        streamCount: totalStreams,
        totalHours: totalSeconds / 3600,
        categories: [...allCategories],
        topClip: topClip ? { title: topClip.title, url: topClip.url, view_count: topClip.view_count } : null,
      });

      await sendNotification(channelId, embed, {
        streamerId: streamer_id,
        guildId: guild_id,
        type: 'weekly_digest',
      });

      // Only record after successful post
      db.updateWeeklyDigestDate(guild_id, todayStr);
      console.log(`[WeeklyDigest] Posted digest for guild ${guild_id}`);
    } catch (e) {
      console.error(`[WeeklyDigest] Error for guild ${guild_id}: ${e.message}`);
    }
  }
}

function parseTwitchDuration(duration) {
  // Twitch format: "1h2m3s", "45m12s", "30s"
  const hours = duration.match(/(\d+)h/)?.[1] || 0;
  const mins = duration.match(/(\d+)m/)?.[1] || 0;
  const secs = duration.match(/(\d+)s/)?.[1] || 0;
  return Number(hours) * 3600 + Number(mins) * 60 + Number(secs);
}

module.exports = { pollWeeklyDigest };
