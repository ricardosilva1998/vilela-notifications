const db = require('../db');
const config = require('../config');
const { sendNotification } = require('../discord');
const twitchLive = require('./twitchLive');
const twitchClips = require('./twitchClips');
const youtubeFeed = require('./youtubeFeed');
const youtubeLive = require('./youtubeLive');
const subSync = require('./subSync');

async function pollAllTwitchLive() {
  const streamers = db.getAllStreamers();
  for (const streamer of streamers) {
    try {
      const state = db.getPollerState(streamer.id);
      const result = await twitchLive.check(streamer, state);
      if (!result) continue;

      if (result.stateUpdate) db.updatePollerState(streamer.id, result.stateUpdate);

      if (result.notify) {
        const guilds = db.getGuildsForStreamer(streamer.id)
          .filter((g) => g.twitch_live_enabled && g.twitch_live_channel_id);
        for (const guild of guilds) {
          try {
            await sendNotification(guild.twitch_live_channel_id, result.embed);
            console.log(`[TwitchLive] ${streamer.twitch_username} is live -> ${guild.guild_name}`);
          } catch (e) {
            console.error(`[TwitchLive] Send failed to ${guild.guild_id}: ${e.message}`);
          }
        }
      }
    } catch (error) {
      console.error(`[TwitchLive] Error for ${streamer.twitch_username}: ${error.message}`);
    }
  }
}

async function pollAllTwitchClips() {
  const streamers = db.getAllStreamers();
  for (const streamer of streamers) {
    try {
      const state = db.getPollerState(streamer.id);
      const result = await twitchClips.check(streamer, state);
      if (!result) continue;

      if (result.stateUpdate) db.updatePollerState(streamer.id, result.stateUpdate);

      if (result.notify && result.embeds) {
        const guilds = db.getGuildsForStreamer(streamer.id)
          .filter((g) => g.twitch_clips_enabled && g.twitch_clips_channel_id);
        for (const guild of guilds) {
          for (const embed of result.embeds) {
            try {
              await sendNotification(guild.twitch_clips_channel_id, embed);
            } catch (e) {
              console.error(`[TwitchClips] Send failed to ${guild.guild_id}: ${e.message}`);
            }
          }
        }
      }
    } catch (error) {
      console.error(`[TwitchClips] Error for ${streamer.twitch_username}: ${error.message}`);
    }
  }
}

async function pollAllYouTubeFeed() {
  const streamers = db.getAllStreamers().filter((s) => s.youtube_channel_id);
  for (const streamer of streamers) {
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
              await sendNotification(guild.youtube_channel_id, embed);
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
  const streamers = db.getAllStreamers().filter((s) => s.youtube_channel_id && s.youtube_api_key);
  for (const streamer of streamers) {
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
            await sendNotification(guild.youtube_channel_id, result.embed);
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
  const streamers = db.getAllStreamers().filter((s) => s.broadcaster_access_token);
  for (const streamer of streamers) {
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
  console.log(`  Twitch Live: every ${config.intervals.twitchLive / 1000}s`);
  console.log(`  Twitch Clips: every ${config.intervals.twitchClips / 1000}s`);
  console.log(`  YouTube Feed: every ${config.intervals.youtubeFeed / 1000}s`);
  console.log(`  YouTube Live: every ${config.intervals.youtubeLive / 1000}s`);
  console.log(`  Sub Sync: every ${config.intervals.subSync / 1000}s`);

  // Run first poll immediately
  pollAllTwitchLive();
  pollAllTwitchClips();
}

module.exports = { startAll };
