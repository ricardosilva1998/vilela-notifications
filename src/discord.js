const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const config = require('./config');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates] });

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

function buildRecapEmbed({ twitchUsername, title, category, duration, thumbnailUrl, clips, peakViewers, followerCount, vodUrl }) {
  const fields = [
    { name: 'Category', value: category || 'Unknown', inline: true },
    { name: 'Duration', value: formatDuration(duration), inline: true },
  ];

  if (peakViewers > 0) {
    fields.push({ name: 'Peak Viewers', value: peakViewers.toLocaleString(), inline: true });
  }

  if (followerCount !== null && followerCount !== undefined) {
    fields.push({ name: 'Followers', value: followerCount.toLocaleString(), inline: true });
  }

  if (clips && clips.length > 0) {
    const clipList = clips
      .map((clip, i) => `${i + 1}. [${clip.title}](${clip.url}) (${clip.view_count || 0} views)`)
      .join('\n');
    fields.push({ name: 'Top Clips', value: clipList });
  }

  return buildEmbed({
    color: 0x9146ff,
    author: { name: `${twitchUsername} stream recap` },
    title: title || 'Stream ended',
    url: vodUrl || `https://twitch.tv/${twitchUsername}`,
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

function formatLapTime(seconds) {
  if (!seconds || seconds <= 0) return 'N/A';
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(3);
  return `${mins}:${secs.padStart(6, '0')}`;
}

function buildIracingResultEmbed(raceData) {
  const posChange = raceData.starting_position - raceData.finish_position;
  let posChangeStr = '';
  if (posChange > 0) posChangeStr = ` (started P${raceData.starting_position} — gained ${posChange})`;
  else if (posChange < 0) posChangeStr = ` (started P${raceData.starting_position} — lost ${Math.abs(posChange)})`;
  else posChangeStr = ` (started P${raceData.starting_position})`;

  let iratingStr = raceData.new_irating?.toLocaleString() || '0';
  if (raceData.irating_change > 0) iratingStr += ` (+${raceData.irating_change} ▲)`;
  else if (raceData.irating_change < 0) iratingStr += ` (${raceData.irating_change} ▼)`;
  else iratingStr += ' (±0)';

  const fields = [
    { name: 'Position', value: `P${raceData.finish_position} / ${raceData.field_size}${posChangeStr}`, inline: true },
    { name: 'iRating', value: iratingStr, inline: true },
    { name: 'Incidents', value: `${raceData.incidents}x`, inline: true },
    { name: 'Laps', value: `${raceData.laps_completed}`, inline: true },
    { name: 'Car', value: raceData.car_name || 'Unknown', inline: true },
    { name: 'SOF', value: raceData.strength_of_field?.toLocaleString() || '0', inline: true },
  ];

  if (raceData.fastest_lap_time) {
    fields.push({ name: 'Fastest Lap', value: formatLapTime(raceData.fastest_lap_time) });
  }
  if (raceData.qualifying_time) {
    fields.push({ name: 'Qualifying', value: `${formatLapTime(raceData.qualifying_time)} (P${raceData.starting_position})` });
  }

  return buildEmbed({
    color: 0x1a1a2e,
    author: { name: `${raceData.driver_name} finished a race` },
    title: `${raceData.series_name} — ${raceData.track_name}`,
    url: `https://members.iracing.com/membersite/member/EventResult.do?subsessionid=${raceData.subsession_id}`,
    fields,
    footer: { text: 'iRacing' },
    timestamp: raceData.race_date ? new Date(raceData.race_date) : new Date(),
  });
}

module.exports = { client, sendNotification, buildEmbed, buildRecapEmbed, buildWeeklyDigestEmbed, buildMilestoneEmbed, buildInstagramEmbed, buildTikTokEmbed, buildTwitterEmbed, buildIracingResultEmbed, formatLapTime };
