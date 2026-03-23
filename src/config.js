const required = [
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
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
    clientId: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
  },
  twitch: {
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
  },
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
    mode: process.env.PAYPAL_MODE || 'sandbox', // 'sandbox' or 'live'
    get baseUrl() {
      return this.mode === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';
    },
  },
  app: {
    url: (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
    port: parseInt(process.env.PORT) || 3000,
    sessionSecret: process.env.SESSION_SECRET || 'change-me-in-production',
    adminPassword: process.env.ADMIN_PASSWORD || null,
  },
  intervals: {
    twitchLive: parseInt(process.env.TWITCH_POLL_INTERVAL) || 60_000,
    twitchClips: parseInt(process.env.TWITCH_CLIPS_INTERVAL) || 300_000,
    youtubeFeed: parseInt(process.env.YOUTUBE_FEED_INTERVAL) || 300_000,
    youtubeLive: parseInt(process.env.YOUTUBE_LIVE_INTERVAL) || 120_000,
    subSync: parseInt(process.env.SUB_SYNC_INTERVAL) || 600_000,
  },
  tiers: {
    free:      { price: 0,  maxGuilds: 1,  twitchLive: true, twitchClips: false, youtube: false, subSync: false, welcome: false, maxTwitchChannels: 1 },
    starter:   { price: 10, maxGuilds: 2,  twitchLive: true, twitchClips: true,  youtube: false, subSync: false, welcome: false, maxTwitchChannels: -1 },
    pro:       { price: 20, maxGuilds: 5,  twitchLive: true, twitchClips: true,  youtube: true,  subSync: true,  welcome: true,  maxTwitchChannels: -1 },
    unlimited: { price: 50, maxGuilds: -1, twitchLive: true, twitchClips: true,  youtube: true,  subSync: true,  welcome: true,  maxTwitchChannels: -1 },
  },
};
