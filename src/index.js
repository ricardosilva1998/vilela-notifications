const config = require('./config');
const db = require('./db');
const { client } = require('./discord');
const server = require('./server');
const commands = require('./commands');
const welcome = require('./welcome');
const { startAll } = require('./pollers/manager');

client.once('ready', async () => {
  console.log(`Bot online as ${client.user.tag}`);
  console.log(`Serving ${client.guilds.cache.size} guilds`);
  console.log(`${db.getAllStreamers().length} registered streamers`);

  try {
    // Register slash commands
    await commands.registerCommands();
    commands.start();

    // Start welcome listener
    welcome.start();

    // Start all pollers
    startAll();

    const { eventSubManager } = require('./services/eventsub');
    const { streamElementsManager } = require('./services/streamelements');

    // Start overlay event sources
    eventSubManager.startAll();
    streamElementsManager.startAll();

    const { chatManager } = require('./services/twitchChat');
    chatManager.startAll();

    const { timedNotificationManager } = require('./services/timedNotifications');
    timedNotificationManager.startAll();

    console.log('[YT Chat] YouTube Live Chat manager ready (starts when streams go live)');

    // Start web dashboard
    server.start();

    // Clean up old moderation logs (every 6 hours)
    setInterval(() => {
      try {
        const db = require('./db');
        db.cleanupOldModLogs();
      } catch (e) {}
    }, 6 * 60 * 60 * 1000);
    try { const db = require('./db'); db.cleanupOldModLogs(); } catch (e) {}

    console.log('All systems running');
  } catch (error) {
    console.error(`Startup error: ${error.message}`);
    process.exit(1);
  }
});

// Handle bot joining a new guild
client.on('guildCreate', (guild) => {
  console.log(`[Guild] Joined: ${guild.name} (${guild.id})`);
  // Guild-streamer linking happens via the dashboard invite URL (state param)
  // We just log it here; the actual record is created when the streamer configures it
});

// Handle bot being removed from a guild
client.on('guildDelete', (guild) => {
  console.log(`[Guild] Removed from: ${guild.name} (${guild.id})`);
});

// Graceful shutdown
function shutdown() {
  console.log('Shutting down...');
  client.destroy();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

client.login(config.discord.token);
