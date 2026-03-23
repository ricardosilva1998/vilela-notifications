const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const { client, buildEmbed } = require('./discord');
const config = require('./config');

const linkCommand = new SlashCommandBuilder()
  .setName('link')
  .setDescription('Link your Twitch account to get the subscriber role automatically');

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);

  try {
    const commands = [linkCommand.toJSON()];
    await rest.put(Routes.applicationCommands(client.application.id), { body: commands });
    console.log('[Commands] Registered /link command');
  } catch (error) {
    console.error(`[Commands] Failed to register commands: ${error.message}`);
  }
}

function start() {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'link') {
      const linkUrl = `${config.app.url}/auth/link?discord_id=${interaction.user.id}`;

      const embed = buildEmbed({
        color: 0x9146ff,
        title: 'Link your Twitch Account',
        description: `Click the link below to connect your Twitch account to Discord. If you're subscribed to **${config.twitch.username}**, you'll automatically get the subscriber role!\n\n[Click here to link your Twitch account](${linkUrl})`,
        footer: { text: 'Your Twitch account will be linked to your Discord account' },
      });

      await interaction.reply({ embeds: [embed], flags: 64 }); // ephemeral (only visible to the user)
    }
  });
}

module.exports = { registerCommands, start };
