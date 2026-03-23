const { Router } = require('express');
const config = require('../config');
const db = require('../db');
const { client } = require('../discord');

const router = Router();

// All dashboard routes require auth
router.use((req, res, next) => {
  if (!req.streamer) return res.redirect('/auth/login');
  next();
});

// Claim a guild for this streamer
router.post('/claim/:guildId', (req, res) => {
  const { guildId } = req.params;
  const discordGuild = client.guilds.cache.get(guildId);
  if (!discordGuild) return res.redirect('/dashboard');

  db.upsertGuild(guildId, req.streamer.id, discordGuild.name);
  console.log(`[Dashboard] ${req.streamer.twitch_username} claimed guild ${discordGuild.name}`);
  res.redirect(`/dashboard/guild/${guildId}`);
});

// Dashboard home — list guilds
router.get('/', (req, res) => {
  const guilds = db.getGuildsForStreamer(req.streamer.id);
  const msg = req.query.msg;

  // Enrich guilds with Discord info
  const enrichedGuilds = guilds.map((g) => {
    const discordGuild = client.guilds.cache.get(g.guild_id);
    return {
      ...g,
      name: discordGuild?.name || g.guild_name || 'Unknown Server',
      icon: discordGuild?.iconURL({ size: 64 }) || null,
      botPresent: !!discordGuild,
    };
  });

  // Find guilds the bot is in that this streamer hasn't claimed yet
  const claimedGuildIds = new Set(guilds.map((g) => g.guild_id));
  const unclaimedGuilds = client.guilds.cache
    .filter((g) => !claimedGuildIds.has(g.id))
    .map((g) => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 64 }) }));

  const botInviteUrl = `https://discord.com/oauth2/authorize?client_id=${client.application.id}&permissions=2415919104&scope=bot%20applications.commands&state=${req.streamer.id}`;

  res.render('dashboard', {
    streamer: req.streamer,
    guilds: enrichedGuilds,
    unclaimedGuilds,
    botInviteUrl,
    msg,
  });
});

// Guild config page
router.get('/guild/:guildId', (req, res) => {
  const { guildId } = req.params;
  const guildConfig = db.getGuildConfig(guildId, req.streamer.id);

  if (!guildConfig) {
    return res.redirect('/dashboard');
  }

  const discordGuild = client.guilds.cache.get(guildId);
  const channels = discordGuild
    ? discordGuild.channels.cache
        .filter((c) => c.type === 0) // text channels only
        .map((c) => ({ id: c.id, name: c.name }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  const roles = discordGuild
    ? discordGuild.roles.cache
        .filter((r) => !r.managed && r.name !== '@everyone')
        .map((r) => ({ id: r.id, name: r.name }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  const watchedChannels = db.getWatchedChannelsForGuild(guildId, req.streamer.id);

  res.render('guild-config', {
    streamer: req.streamer,
    guild: guildConfig,
    guildName: discordGuild?.name || guildConfig.guild_name || 'Unknown',
    channels,
    roles,
    watchedCount: watchedChannels.length,
    hasBroadcasterToken: !!req.streamer.broadcaster_access_token,
    broadcasterAuthUrl: `${config.app.url}/auth/broadcaster`,
  });
});

// Save guild config
router.post('/guild/:guildId', (req, res) => {
  const { guildId } = req.params;
  const guildConfig = db.getGuildConfig(guildId, req.streamer.id);
  if (!guildConfig) return res.redirect('/dashboard');

  db.updateGuildConfig(guildId, req.streamer.id, {
    twitch_live_channel_id: req.body.twitch_live_channel_id || null,
    twitch_clips_channel_id: req.body.twitch_clips_channel_id || null,
    youtube_channel_id: req.body.youtube_channel_id || null,
    welcome_channel_id: req.body.welcome_channel_id || null,
    sub_role_id: req.body.sub_role_id || null,
    welcome_message: req.body.welcome_message || null,
    twitch_live_enabled: req.body.twitch_live_enabled === 'on',
    twitch_clips_enabled: req.body.twitch_clips_enabled === 'on',
    youtube_enabled: req.body.youtube_enabled === 'on',
    welcome_enabled: req.body.welcome_enabled === 'on',
    sub_sync_enabled: req.body.sub_sync_enabled === 'on',
  });

  console.log(`[Dashboard] Guild ${guildId} config updated by streamer ${req.streamer.twitch_username}`);
  res.redirect(`/dashboard/guild/${guildId}?saved=1`);
});

// Remove a guild from this streamer's config
router.post('/guild/:guildId/remove', (req, res) => {
  const { guildId } = req.params;
  db.deleteGuild(guildId, req.streamer.id);
  console.log(`[Dashboard] ${req.streamer.discord_username} removed guild ${guildId}`);
  res.redirect('/dashboard?msg=guild_removed');
});

// --- Watched Twitch Channels ---

router.get('/guild/:guildId/channels', (req, res) => {
  const { guildId } = req.params;
  const guildConfig = db.getGuildConfig(guildId, req.streamer.id);
  if (!guildConfig) return res.redirect('/dashboard');

  const watchedChannels = db.getWatchedChannelsForGuild(guildId, req.streamer.id);
  const discordGuild = client.guilds.cache.get(guildId);
  const channels = discordGuild
    ? discordGuild.channels.cache
        .filter((c) => c.type === 0)
        .map((c) => ({ id: c.id, name: c.name }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  res.render('guild-channels', {
    streamer: req.streamer,
    guild: guildConfig,
    guildName: discordGuild?.name || guildConfig.guild_name || 'Unknown',
    guildId,
    watchedChannels,
    channels,
    msg: req.query.msg,
  });
});

router.post('/guild/:guildId/channels', (req, res) => {
  const { guildId } = req.params;
  const guildConfig = db.getGuildConfig(guildId, req.streamer.id);
  if (!guildConfig) return res.redirect('/dashboard');

  const twitchUsername = (req.body.twitch_username || '').trim().toLowerCase();
  const discordChannelId = req.body.discord_channel_id;

  if (!twitchUsername || !discordChannelId) {
    return res.redirect(`/dashboard/guild/${guildId}/channels?msg=missing_fields`);
  }

  db.addWatchedChannel(
    guildId,
    req.streamer.id,
    twitchUsername,
    discordChannelId,
    req.body.notify_live !== 'off',
    req.body.notify_clips !== 'off'
  );

  console.log(`[Dashboard] Added watched channel ${twitchUsername} for guild ${guildId}`);
  res.redirect(`/dashboard/guild/${guildId}/channels?msg=added`);
});

router.post('/guild/:guildId/channels/:channelId/remove', (req, res) => {
  const { guildId, channelId } = req.params;
  db.removeWatchedChannel(parseInt(channelId), req.streamer.id);
  console.log(`[Dashboard] Removed watched channel ${channelId} from guild ${guildId}`);
  res.redirect(`/dashboard/guild/${guildId}/channels?msg=removed`);
});

// YouTube settings
router.get('/youtube', (req, res) => {
  res.render('youtube-config', { streamer: req.streamer });
});

router.post('/youtube', (req, res) => {
  db.updateStreamerYoutube(req.streamer.id, req.body.youtube_channel_id || null, req.body.youtube_api_key || null);
  console.log(`[Dashboard] YouTube config updated for ${req.streamer.twitch_username}`);
  res.redirect('/dashboard?msg=youtube_saved');
});

module.exports = router;
