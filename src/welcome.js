const { client, buildEmbed } = require('./discord');
const config = require('./config');

const WELCOME_MESSAGE = `What's up and welcome! You've officially joined the community hub for **André Vilela** — the best place for stream updates, community chats, clips, memes, gaming talk, and all-around good vibes.

To keep the server fun for everyone, please follow these rules:

**✅ Community Rules**

• Respect everyone
• No hate, bullying, or toxic behavior
• No spam or unnecessary drama
• Keep things in the correct channels
• No NSFW or offensive content
• Don't share private information
• No self-promo unless allowed
• Respect mods and staff
• No spoilers/backseating unless permitted
• Bring good energy and enjoy yourself

We want this to be a chill place where everyone feels welcome, whether you're a longtime viewer or just joined from stream.

Make yourself at home, check out the channels, and enjoy the community! 💜`;

function start() {
  if (!config.discord.welcomeChannelId) {
    console.log('[Welcome] Disabled (DISCORD_WELCOME_CHANNEL_ID not set)');
    return;
  }

  client.on('guildMemberAdd', async (member) => {
    try {
      const channel = await client.channels.fetch(config.discord.welcomeChannelId);
      if (!channel) {
        console.error(`[Welcome] Channel ${config.discord.welcomeChannelId} not found`);
        return;
      }

      const embed = buildEmbed({
        color: 0x9146ff,
        title: `🔥 Welcome to Vilela's Discord! 🔥`,
        description: WELCOME_MESSAGE,
        footer: { text: `Welcome, ${member.user.username}!` },
        timestamp: new Date(),
      });

      await channel.send({ content: `Hey <@${member.id}>!`, embeds: [embed] });
      console.log(`[Welcome] Welcomed ${member.user.username}`);
    } catch (error) {
      console.error(`[Welcome] Failed to welcome ${member.user.username}: ${error.message}`);
    }
  });

  console.log(`[Welcome] Listening for new members, posting to channel: ${config.discord.welcomeChannelId}`);
}

module.exports = { start };
