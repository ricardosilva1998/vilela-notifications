const required = [
  'DISCORD_TOKEN',
  'TWITCH_CLIENT_ID',
  'TWITCH_CLIENT_SECRET',
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required environment variables:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

module.exports = {
  discord: {
    token: process.env.DISCORD_TOKEN,
  },
  twitch: {
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
  },
  app: {
    url: (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
    port: parseInt(process.env.PORT) || 3000,
    sessionSecret: process.env.SESSION_SECRET || 'change-me-in-production',
  },
  intervals: {
    twitchLive: parseInt(process.env.TWITCH_POLL_INTERVAL) || 60_000,
    twitchClips: parseInt(process.env.TWITCH_CLIPS_INTERVAL) || 300_000,
    youtubeFeed: parseInt(process.env.YOUTUBE_FEED_INTERVAL) || 300_000,
    youtubeLive: parseInt(process.env.YOUTUBE_LIVE_INTERVAL) || 120_000,
    subSync: parseInt(process.env.SUB_SYNC_INTERVAL) || 600_000,
  },
};
