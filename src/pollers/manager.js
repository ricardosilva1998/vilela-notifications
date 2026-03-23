const db = require('../db');
const config = require('../config');
const { sendNotification } = require('../discord');
const twitchLive = require('./twitchLive');
const twitchClips = require('./twitchClips');
const youtubeFeed = require('./youtubeFeed');
const youtubeLive = require('./youtubeLive');
const subSync = require('./subSync');

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
      if (!result) continue;

      if (result.stateUpdate) db.updateChannelState(twitch_username, result.stateUpdate);

      if (result.notify) {
        const watchers = db.getWatchersForChannel(twitch_username).filter((w) => w.notify_live);
        for (const w of watchers) {
          try {
            await sendNotification(w.discord_channel_id, result.embed, {
              streamerId: w.streamer_id,
              guildId: w.guild_id,
              type: 'twitch_live',
            });
          } catch (e) {
            console.error(`[TwitchLive] Send failed for ${twitch_username} to ${w.guild_id}: ${e.message}`);
          }
        }
      }
    } catch (error) {
      console.error(`[TwitchLive] Error for ${twitch_username}: ${error.message}`);
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

      if (result.notify && result.embeds) {
        const watchers = db.getWatchersForChannel(twitch_username).filter((w) => w.notify_clips);
        for (const w of watchers) {
          for (const embed of result.embeds) {
            try {
              await sendNotification(w.discord_channel_id, embed, {
                streamerId: w.streamer_id,
                guildId: w.guild_id,
                type: 'twitch_clip',
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

// --- YouTube polling (still streamer-centric) ---

function getActiveStreamers() {
  return db.getAllStreamers().filter((s) => s.enabled);
}

async function pollAllYouTubeFeed() {
  for (const streamer of getActiveStreamers().filter((s) => s.youtube_channel_id)) {
    try {
      const state = db.getPollerState(streamer.id);
      const result = await youtubeFeed.check(streamer, state);
      if (!result) continue;

      if (result.stateUpdate) db.updatePollerState(streamer.id, result.stateUpdate);

      if (result.notify && result.embeds) {
        const guilds = db.getGuildsForStreamer(streamer.id)
          .filter((g) => g.youtube_enabled && g.youtube_channel_id);
        for (const guild of guilds) {
          for (const embed of result.embeds) {
            try {
              await sendNotification(guild.youtube_channel_id, embed, {
                streamerId: streamer.id,
                guildId: guild.guild_id,
                type: 'youtube_video',
              });
            } catch (e) {
              console.error(`[YouTubeFeed] Send failed to ${guild.guild_id}: ${e.message}`);
            }
          }
        }
      }
    } catch (error) {
      console.error(`[YouTubeFeed] Error for ${streamer.twitch_username}: ${error.message}`);
    }
  }
}

async function pollAllYouTubeLive() {
  for (const streamer of getActiveStreamers().filter((s) => s.youtube_channel_id && s.youtube_api_key)) {
    try {
      const state = db.getPollerState(streamer.id);
      const result = await youtubeLive.check(streamer, state);
      if (!result) continue;

      if (result.stateUpdate) db.updatePollerState(streamer.id, result.stateUpdate);

      if (result.notify) {
        const guilds = db.getGuildsForStreamer(streamer.id)
          .filter((g) => g.youtube_enabled && g.youtube_channel_id);
        for (const guild of guilds) {
          try {
            await sendNotification(guild.youtube_channel_id, result.embed, {
              streamerId: streamer.id,
              guildId: guild.guild_id,
              type: 'youtube_live',
            });
          } catch (e) {
            console.error(`[YouTubeLive] Send failed to ${guild.guild_id}: ${e.message}`);
          }
        }
      }
    } catch (error) {
      console.error(`[YouTubeLive] Error for ${streamer.twitch_username}: ${error.message}`);
    }
  }
}

async function pollAllSubSync() {
  for (const streamer of getActiveStreamers().filter((s) => s.broadcaster_access_token)) {
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

  console.log('[Manager] All pollers started');

  // First poll immediately
  pollAllTwitchLive();
  pollAllTwitchClips();
}

module.exports = { startAll };
