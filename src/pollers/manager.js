const db = require('../db');
const config = require('../config');
const { sendNotification, buildRecapEmbed, buildMilestoneEmbed } = require('../discord');
const twitchLive = require('./twitchLive');
const twitchClips = require('./twitchClips');
const youtubeFeed = require('./youtubeFeed');
const youtubeLive = require('./youtubeLive');
const subSync = require('./subSync');
const { pollWeeklyDigest } = require('./weeklyDigest');
const { getFollowerCount, getSubscribers } = require('../services/twitch');

// --- Twitch polling (channel-centric) ---

async function pollAllTwitchLive() {
  const channels = db.getAllUniqueWatchedChannels();
  if (channels.length > 0 && !pollAllTwitchLive._logged) {
    console.log(`[TwitchLive] Polling ${channels.length} channels: ${channels.map(c => c.twitch_username).join(', ')}`);
    pollAllTwitchLive._logged = true;
  }
  for (const { twitch_username } of channels) {
    try {
      const state = db.getChannelState(twitch_username);
      const result = await twitchLive.check(twitch_username, state);
      if (!result) {
        // Channel is still in same state — check milestones if live
        if (state.is_live) {
          await checkMilestones(twitch_username, state);
        }
        continue;
      }

      if (result.stateUpdate) db.updateChannelState(twitch_username, result.stateUpdate);
      if (result.clearSession) db.clearStreamSession(twitch_username);

      // Go-live notification (existing behavior)
      if (result.notify) {
        const watchers = db.getWatchersForChannel(twitch_username).filter((w) => w.notify_live && w.live_channel_id);
        for (const w of watchers) {
          try {
            await sendNotification(w.live_channel_id, result.embed, {
              streamerId: w.streamer_id,
              guildId: w.guild_id,
              type: 'twitch_live',
            });
          } catch (e) {
            console.error(`[TwitchLive] Send failed for ${twitch_username} to ${w.guild_id}: ${e.message}`);
          }
        }
      }

      // Stream recap on offline
      if (result.recapData) {
        await sendRecaps(twitch_username, result.recapData);
      }

      // Check milestones when channel is live
      if (result.stateUpdate?.is_live === 1) {
        await checkMilestones(twitch_username, db.getChannelState(twitch_username));
      }
    } catch (error) {
      console.error(`[TwitchLive] Error for ${twitch_username}: ${error.message}`);
    }
  }
}

async function sendRecaps(twitchUsername, recapData) {
  const watchers = db.getWatchersForChannelWithFeatures(twitchUsername)
    .filter((w) => w.recap_enabled && w.live_channel_id);

  for (const w of watchers) {
    const tier = db.getStreamerTier(w.streamer_id);
    const tierConfig = config.tiers[tier] || config.tiers.free;
    if (!tierConfig.recaps) continue;

    try {
      const embed = buildRecapEmbed(recapData);
      await sendNotification(w.live_channel_id, embed, {
        streamerId: w.streamer_id,
        guildId: w.guild_id,
        type: 'twitch_recap',
      });
    } catch (e) {
      console.error(`[Recap] Send failed for ${twitchUsername} to ${w.guild_id}: ${e.message}`);
    }
  }
}

function getFollowerMilestone(count) {
  if (count < 1000) return Math.floor(count / 100) * 100;
  if (count < 10000) return Math.floor(count / 500) * 500;
  return Math.floor(count / 1000) * 1000;
}

const SUB_MILESTONES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

function getSubMilestone(count) {
  let milestone = 0;
  for (const m of SUB_MILESTONES) {
    if (count >= m) milestone = m;
    else break;
  }
  return milestone;
}

async function checkMilestones(twitchUsername, channelState) {
  const broadcasterId = channelState.twitch_broadcaster_id;
  if (!broadcasterId) return;

  // Find a streamer with a broadcaster token who watches this channel
  const watchers = db.getWatchersForChannelWithFeatures(twitchUsername)
    .filter((w) => w.milestones_enabled);
  if (watchers.length === 0) return;

  // Check if any watcher's streamer has a broadcaster token
  const streamersWithToken = new Map();
  for (const w of watchers) {
    if (!streamersWithToken.has(w.streamer_id)) {
      const streamer = db.getStreamerById(w.streamer_id);
      if (streamer?.broadcaster_access_token) {
        streamersWithToken.set(w.streamer_id, streamer);
      }
    }
  }
  if (streamersWithToken.size === 0) return;

  const streamer = streamersWithToken.values().next().value;
  const milestones = db.getChannelMilestones(twitchUsername);

  try {
    const followerCount = await getFollowerCount(broadcasterId, streamer.broadcaster_access_token);
    const currentFollowerMilestone = getFollowerMilestone(followerCount);

    if (currentFollowerMilestone > milestones.last_follower_milestone && currentFollowerMilestone > 0) {
      console.log(`[Milestones] ${twitchUsername} hit ${currentFollowerMilestone} followers!`);
      const embed = buildMilestoneEmbed({
        twitchUsername,
        milestoneType: 'follower',
        count: currentFollowerMilestone,
      });
      await sendMilestoneNotifications(twitchUsername, watchers, embed);
      db.updateChannelMilestones(twitchUsername, {
        last_follower_count: followerCount,
        last_follower_milestone: currentFollowerMilestone,
      });
    } else {
      db.updateChannelMilestones(twitchUsername, { last_follower_count: followerCount });
    }

    // Subscriber milestones
    try {
      const subs = await getSubscribers(broadcasterId, streamer.broadcaster_access_token);
      const subCount = subs.length;
      const currentSubMilestone = getSubMilestone(subCount);

      if (currentSubMilestone > milestones.last_subscriber_milestone && currentSubMilestone > 0) {
        console.log(`[Milestones] ${twitchUsername} hit ${currentSubMilestone} subscribers!`);
        const embed = buildMilestoneEmbed({
          twitchUsername,
          milestoneType: 'subscriber',
          count: currentSubMilestone,
        });
        await sendMilestoneNotifications(twitchUsername, watchers, embed);
        db.updateChannelMilestones(twitchUsername, {
          last_subscriber_count: subCount,
          last_subscriber_milestone: currentSubMilestone,
        });
      } else {
        db.updateChannelMilestones(twitchUsername, { last_subscriber_count: subCount });
      }
    } catch (e) {
      // Sub count may fail if token doesn't have the right scope — that's ok
      console.warn(`[Milestones] Sub count failed for ${twitchUsername}: ${e.message}`);
    }
  } catch (e) {
    console.warn(`[Milestones] Follower count failed for ${twitchUsername}: ${e.message}`);
  }
}

async function sendMilestoneNotifications(twitchUsername, watchers, embed) {
  for (const w of watchers) {
    if (!w.milestones_enabled || !w.live_channel_id) continue;
    const tier = db.getStreamerTier(w.streamer_id);
    const tierConfig = config.tiers[tier] || config.tiers.free;
    if (!tierConfig.milestones) continue;

    try {
      await sendNotification(w.live_channel_id, embed, {
        streamerId: w.streamer_id,
        guildId: w.guild_id,
        type: 'twitch_milestone',
      });
    } catch (e) {
      console.error(`[Milestones] Send failed for ${twitchUsername} to ${w.guild_id}: ${e.message}`);
    }
  }
}

async function pollAllTwitchClips() {
  const channels = db.getAllUniqueWatchedChannels();
  for (const { twitch_username } of channels) {
    try {
      const state = db.getChannelState(twitch_username);
      const result = await twitchClips.check(twitch_username, state);
      if (!result) continue;

      if (result.stateUpdate) {
        console.log(`[TwitchClips] ${twitch_username}: state update`, JSON.stringify(result.stateUpdate));
        db.updateChannelState(twitch_username, result.stateUpdate);
      }

      if (result.notify && result.clipData) {
        const watchers = db.getWatchersForChannel(twitch_username).filter((w) => w.notify_clips && w.clips_channel_id);
        for (const w of watchers) {
          for (const clip of result.clipData) {
            try {
              await sendNotification(w.clips_channel_id, null, {
                streamerId: w.streamer_id,
                guildId: w.guild_id,
                type: 'twitch_clip',
                contentOnly: clip.message,
              });
            } catch (e) {
              console.error(`[TwitchClips] Send failed for ${twitch_username} to ${w.guild_id}: ${e.message}`);
            }
          }
        }
      }
    } catch (error) {
      console.error(`[TwitchClips] Error for ${twitch_username}: ${error.message}`);
    }
  }
}

// --- YouTube polling (channel-centric) ---

async function pollAllYouTubeFeed() {
  const channels = db.getAllUniqueWatchedYoutubeChannels();
  for (const { youtube_channel_id } of channels) {
    try {
      const state = db.getYoutubeChannelState(youtube_channel_id);
      const result = await youtubeFeed.check(youtube_channel_id, state);
      if (!result) continue;

      if (result.stateUpdate) db.updateYoutubeChannelState(youtube_channel_id, result.stateUpdate);

      if (result.notify && result.embeds) {
        const watchers = db.getYoutubeWatchersForChannel(youtube_channel_id)
          .filter((w) => w.notify_videos && w.videos_channel_id);
        for (const w of watchers) {
          for (const embed of result.embeds) {
            try {
              await sendNotification(w.videos_channel_id, embed, {
                streamerId: w.streamer_id,
                guildId: w.guild_id,
                type: 'youtube_video',
              });
            } catch (e) {
              console.error(`[YouTubeFeed] Send failed for ${youtube_channel_id} to ${w.guild_id}: ${e.message}`);
            }
          }
        }
      }
    } catch (error) {
      console.error(`[YouTubeFeed] Error for ${youtube_channel_id}: ${error.message}`);
    }
  }
}

async function pollAllYouTubeLive() {
  const channels = db.getAllUniqueWatchedYoutubeChannels();
  for (const { youtube_channel_id } of channels) {
    try {
      const watchers = db.getYoutubeWatchersForChannel(youtube_channel_id)
        .filter((w) => w.notify_live && w.live_channel_id);
      if (watchers.length === 0) continue;

      // Use the first watcher's API key (if any)
      const apiKey = watchers.find((w) => w.youtube_api_key)?.youtube_api_key;
      if (!apiKey) continue;

      const state = db.getYoutubeChannelState(youtube_channel_id);
      const result = await youtubeLive.check(youtube_channel_id, state, apiKey);
      if (!result) continue;

      if (result.stateUpdate) db.updateYoutubeChannelState(youtube_channel_id, result.stateUpdate);

      if (result.notify) {
        for (const w of watchers) {
          try {
            await sendNotification(w.live_channel_id, result.embed, {
              streamerId: w.streamer_id,
              guildId: w.guild_id,
              type: 'youtube_live',
            });
          } catch (e) {
            console.error(`[YouTubeLive] Send failed for ${youtube_channel_id} to ${w.guild_id}: ${e.message}`);
          }
        }
      }
    } catch (error) {
      console.error(`[YouTubeLive] Error for ${youtube_channel_id}: ${error.message}`);
    }
  }
}

function getActiveStreamers() {
  return db.getAllStreamers().filter((s) => s.enabled);
}

async function pollAllSubSync() {
  const active = getActiveStreamers();
  const withToken = active.filter((s) => s.broadcaster_access_token);
  console.log(`[SubSync] Poll: ${active.length} active streamers, ${withToken.length} with broadcaster token`);
  if (active.length > 0 && withToken.length === 0) {
    console.log(`[SubSync] Active streamer IDs: ${active.map(s => `${s.id}(twitch=${s.twitch_username},token=${!!s.broadcaster_access_token})`).join(', ')}`);
  }
  for (const streamer of withToken) {
    try {
      await subSync.checkStreamer(streamer);
    } catch (error) {
      console.error(`[SubSync] Error for ${streamer.twitch_username}: ${error.message}`);
    }
  }
}

function startAll() {
  setInterval(pollAllTwitchLive, config.intervals.twitchLive);
  setInterval(pollAllTwitchClips, config.intervals.twitchClips);
  setInterval(pollAllYouTubeFeed, config.intervals.youtubeFeed);
  setInterval(pollAllYouTubeLive, config.intervals.youtubeLive);
  setInterval(pollAllSubSync, config.intervals.subSync);
  setInterval(pollWeeklyDigest, config.intervals.weeklyDigest);

  console.log('[Manager] All pollers started');

  // First poll immediately
  pollAllTwitchLive();
  pollAllTwitchClips();
  pollAllSubSync();
}

module.exports = { startAll };
