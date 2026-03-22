const config = require('./config');
const state = require('./state');
const { client } = require('./discord');
const twitchLive = require('./pollers/twitchLive');
const twitchClips = require('./pollers/twitchClips');

let appState = state.load();

client.once('ready', async () => {
  console.log(`Bot online as ${client.user.tag}`);
  console.log(`Monitoring: Twitch=${config.twitch.username}`);
  if (config.youtube.enabled) console.log(`Monitoring: YouTube=${config.youtube.channelId}`);
  console.log(`Posting to channel: ${config.discord.channelId}`);

  try {
    // Initialize all pollers (sets correct state to avoid false notifications)
    console.log('Initializing pollers...');
    await twitchLive.init(appState);
    await twitchClips.init(appState);

    if (config.youtube.enabled) {
      const youtubeFeed = require('./pollers/youtubeFeed');
      const youtubeLive = require('./pollers/youtubeLive');
      await youtubeFeed.init(appState);
      await youtubeLive.init(appState);
      youtubeFeed.start(appState);
      youtubeLive.start(appState);
    }

    state.save(appState);
    console.log('Initialization complete');

    // Start polling
    twitchLive.start(appState);
    twitchClips.start(appState);

    console.log('All pollers running');
  } catch (error) {
    console.error(`Startup error: ${error.message}`);
    process.exit(1);
  }
});

// Graceful shutdown
function shutdown() {
  console.log('Shutting down...');
  state.save(appState);
  client.destroy();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

client.login(config.discord.token);
