const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const config = require('./config');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers] });

async function sendNotification(channelId, embed, meta) {
  const db = require('./db');
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      console.error(`Channel ${channelId} not found`);
      if (meta) db.logNotification(meta.streamerId, meta.guildId, meta.type, false);
      return;
    }
    const payload = { embeds: [embed] };
    if (meta?.content) payload.content = meta.content;
    await channel.send(payload);
    if (meta) db.logNotification(meta.streamerId, meta.guildId, meta.type, true);
  } catch (error) {
    console.error(`Discord send error: ${error.message} (code: ${error.code}, status: ${error.status})`);
    if (meta) db.logNotification(meta.streamerId, meta.guildId, meta.type, false);
    throw error;
  }
}

function buildEmbed({ color, author, title, url, description, image, fields, footer, timestamp }) {
  const embed = new EmbedBuilder();
  if (color) embed.setColor(color);
  if (author) embed.setAuthor(author);
  if (title) embed.setTitle(title);
  if (url) embed.setURL(url);
  if (description) embed.setDescription(description);
  if (image) embed.setImage(image);
  if (fields) embed.addFields(fields);
  if (footer) embed.setFooter(footer);
  if (timestamp) embed.setTimestamp(timestamp instanceof Date ? timestamp : new Date(timestamp));
  return embed;
}

module.exports = { client, sendNotification, buildEmbed };
