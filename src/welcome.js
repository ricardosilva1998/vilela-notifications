const { client, buildEmbed } = require('./discord');
const db = require('./db');

const DEFAULT_WELCOME_MESSAGE = `What's up and welcome! You've officially joined the community — the best place for stream updates, community chats, clips, memes, gaming talk, and all-around good vibes.

**Rules**
- Respect everyone
- No hate, bullying, or toxic behavior
- No spam or unnecessary drama
- Keep things in the correct channels
- Bring good energy and enjoy yourself

Make yourself at home, check out the channels, and enjoy the community!`;

function start() {
  client.on('guildMemberAdd', async (member) => {
    const configs = db.getGuildConfigsByGuildId(member.guild.id)
      .filter((c) => c.welcome_enabled && c.welcome_channel_id);

    for (const config of configs) {
      try {
        const channel = await client.channels.fetch(config.welcome_channel_id);
        if (!channel) continue;

        const message = config.welcome_message || DEFAULT_WELCOME_MESSAGE;
        const streamerName = config.twitch_username || 'the community';

        const embed = buildEmbed({
          color: 0x9146ff,
          title: `Welcome to ${streamerName}'s Discord!`,
          description: message,
          footer: { text: `Welcome, ${member.user.username}!` },
          timestamp: new Date(),
        });

        await channel.send({ content: `Hey <@${member.id}>!`, embeds: [embed] });
        console.log(`[Welcome] Welcomed ${member.user.username} in ${member.guild.name}`);
      } catch (error) {
        console.error(`[Welcome] Error in ${member.guild.name}: ${error.message}`);
      }
    }
  });

  console.log('[Welcome] Listening for new members');
}

module.exports = { start };
