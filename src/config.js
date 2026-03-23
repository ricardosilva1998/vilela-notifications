const required = [
  'DISCORD_TOKEN',
  'DISCORD_TWITCH_LIVE_CHANNEL_ID',
  'DISCORD_TWITCH_CLIPS_CHANNEL_ID',
  'TWITCH_CLIENT_ID',
  'TWITCH_CLIENT_SECRET',
  'TWITCH_USERNAME',
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required environment variables:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

const youtubeEnabled = !!(process.env.YOUTUBE_CHANNEL_ID);

if (youtubeEnabled) {
  console.log('YouTube monitoring enabled');
} else {
  console.log('YouTube monitoring disabled (YOUTUBE_CHANNEL_ID not set)');
}

module.exports = {
  discord: {
    token: process.env.DISCORD_TOKEN,
    twitchLiveChannelId: process.env.DISCORD_TWITCH_LIVE_CHANNEL_ID,
    twitchClipsChannelId: process.env.DISCORD_TWITCH_CLIPS_CHANNEL_ID,
    welcomeChannelId: process.env.DISCORD_WELCOME_CHANNEL_ID,
    youtubeChannelId: process.env.DISCORD_YOUTUBE_CHANNEL_ID,
  },
  twitch: {
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    username: process.env.TWITCH_USERNAME,
  },
  youtube: {
    enabled: youtubeEnabled,
    channelId: process.env.YOUTUBE_CHANNEL_ID,
    apiKey: process.env.YOUTUBE_API_KEY,
  },
  intervals: {
    twitchLive: parseInt(process.env.TWITCH_POLL_INTERVAL) || 60_000,
    twitchClips: parseInt(process.env.TWITCH_CLIPS_INTERVAL) || 300_000,
    youtubeFeed: parseInt(process.env.YOUTUBE_FEED_INTERVAL) || 300_000,
    youtubeLive: parseInt(process.env.YOUTUBE_LIVE_INTERVAL) || 120_000,
  },
};
