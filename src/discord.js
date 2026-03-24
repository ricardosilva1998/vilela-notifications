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
    if (meta?.contentOnly) {
      await channel.send(meta.contentOnly);
    } else {
      const payload = { embeds: [embed] };
      await channel.send(payload);
    }
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

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function buildRecapEmbed({ twitchUsername, title, category, duration, thumbnailUrl, clips }) {
  const fields = [
    { name: 'Category', value: category || 'Unknown', inline: true },
    { name: 'Duration', value: formatDuration(duration), inline: true },
  ];
  if (clips && clips.length > 0) {
    const clipList = clips
      .map((clip, i) => `${i + 1}. [${clip.title}](${clip.url}) (${clip.view_count || 0} views)`)
      .join('\n');
    fields.push({ name: 'Top Clips', value: clipList });
  }
  return buildEmbed({
    color: 0x9146ff,
    author: { name: `${twitchUsername} stream recap` },
    title,
    url: `https://twitch.tv/${twitchUsername}`,
    image: thumbnailUrl || undefined,
    fields,
    footer: { text: 'Stream Recap' },
    timestamp: new Date(),
  });
}

function buildWeeklyDigestEmbed({ streamCount, totalHours, categories, topClip }) {
  const fields = [
    { name: 'Streams', value: String(streamCount), inline: true },
    { name: 'Total Hours', value: totalHours.toFixed(1), inline: true },
    { name: 'Categories', value: categories.join(', ') },
  ];
  if (topClip) {
    fields.push({
      name: 'Top Clip',
      value: `[${topClip.title}](${topClip.url}) (${topClip.viewCount} views)`,
    });
  }
  return buildEmbed({
    color: 0x3498db,
    author: { name: 'Weekly Highlights' },
    title: 'Your week in streaming',
    fields,
    footer: { text: 'Weekly Digest' },
    timestamp: new Date(),
  });
}

function buildMilestoneEmbed({ twitchUsername, milestoneType, count }) {
  const label = milestoneType === 'subscriber' ? 'subscribers' : 'followers';
  return buildEmbed({
    color: 0xf1c40f,
    title: `\u{1F389} ${twitchUsername} just hit ${count} ${label}!`,
    url: `https://twitch.tv/${twitchUsername}`,
    description: 'Congratulations! A new milestone has been reached.',
    footer: { text: 'Milestone Celebration' },
    timestamp: new Date(),
  });
}

function buildInstagramEmbed({ username, displayName, profileImageUrl, caption, postUrl, imageUrl, timestamp }) {
  return buildEmbed({
    color: 0xE1306C,
    author: { name: `${displayName || username} posted on Instagram`, iconURL: profileImageUrl || undefined },
    title: caption ? caption.slice(0, 100) : 'New post',
    url: postUrl,
    image: imageUrl || undefined,
    footer: { text: 'Instagram' },
    timestamp,
  });
}

function buildTikTokEmbed({ username, displayName, profileImageUrl, description, videoUrl, thumbnailUrl, timestamp }) {
  return buildEmbed({
    color: 0x010101,
    author: { name: `${displayName || username} posted on TikTok`, iconURL: profileImageUrl || undefined },
    title: description ? description.slice(0, 100) : 'New video',
    url: videoUrl,
    image: thumbnailUrl || undefined,
    footer: { text: 'TikTok' },
    timestamp,
  });
}

function buildTwitterEmbed({ username, displayName, profileImageUrl, text, tweetUrl, mediaUrl, timestamp }) {
  return buildEmbed({
    color: 0x1DA1F2,
    author: { name: `${displayName || username} tweeted`, iconURL: profileImageUrl || undefined },
    description: text,
    url: tweetUrl,
    image: mediaUrl || undefined,
    footer: { text: 'Twitter' },
    timestamp,
  });
}

module.exports = { client, sendNotification, buildEmbed, buildRecapEmbed, buildWeeklyDigestEmbed, buildMilestoneEmbed, buildInstagramEmbed, buildTikTokEmbed, buildTwitterEmbed };
