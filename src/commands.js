const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const { client, buildEmbed } = require('./discord');
const config = require('./config');
const db = require('./db');

const linkCommand = new SlashCommandBuilder()
  .setName('link')
  .setDescription('Link your Twitch account to get the subscriber role automatically');

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);

  try {
    await rest.put(Routes.applicationCommands(client.application.id), {
      body: [linkCommand.toJSON()],
    });
    console.log('[Commands] Registered /link command');
  } catch (error) {
    console.error(`[Commands] Failed to register: ${error.message}`);
  }
}

function start() {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'link') return;

    const guildConfigs = db.getGuildConfigsByGuildId(interaction.guildId);
    if (guildConfigs.length === 0) {
      return interaction.reply({
        content: 'This server has not been configured yet. Ask the server owner to set it up.',
        flags: 64,
      });
    }

    // Find the config with sub sync enabled, or fall back to the first one
    const guildConfig = guildConfigs.find((c) => c.sub_sync_enabled) || guildConfigs[0];
    const linkUrl = `${config.app.url}/auth/link?streamer_id=${guildConfig.streamer_id}&discord_id=${interaction.user.id}`;

    const embed = buildEmbed({
      color: 0x9146ff,
      title: 'Link your Twitch Account',
      description: `Click the link below to connect your Twitch account. If you're subscribed to **${guildConfig.twitch_username}**, you'll automatically get the subscriber role!\n\n[Click here to link your Twitch account](${linkUrl})`,
      footer: { text: 'Your Twitch account will be linked to your Discord account' },
    });

    await interaction.reply({ embeds: [embed], flags: 64 });
  });
}

module.exports = { registerCommands, start };
