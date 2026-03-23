const { Router } = require('express');
const config = require('../config');
const db = require('../db');
const { client } = require('../discord');
const { getUserProfile } = require('../services/twitch');
const { resolveChannelId, getLatestVideos } = require('../services/youtube');

const router = Router();

// Helper: get tier limits for current user
function getTierLimits(streamerId) {
  const tier = db.getStreamerTier(streamerId);
  return { tier, limits: config.tiers[tier] || config.tiers.free };
}

// All dashboard routes require auth
router.use((req, res, next) => {
  if (!req.streamer) return res.redirect('/auth/login');
  next();
});

// Helper: get text channels for a guild
function getDiscordChannels(guildId) {
  const discordGuild = client.guilds.cache.get(guildId);
  if (!discordGuild) return [];
  return discordGuild.channels.cache
    .filter((c) => c.type === 0)
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Claim a guild for this streamer
router.post('/claim/:guildId', (req, res) => {
  const { guildId } = req.params;
  const discordGuild = client.guilds.cache.get(guildId);
  if (!discordGuild) return res.redirect('/dashboard');

  // Check if already claimed by another user
  const allClaimed = db.getAllClaimedGuildIds();
  if (allClaimed.has(guildId)) {
    return res.redirect('/dashboard?msg=already_claimed');
  }

  // Check tier guild limit
  const { limits } = getTierLimits(req.streamer.id);
  const currentGuilds = db.getGuildsForStreamer(req.streamer.id);
  if (limits.maxGuilds !== -1 && currentGuilds.length >= limits.maxGuilds) {
    return res.redirect('/dashboard?msg=guild_limit');
  }

  db.upsertGuild(guildId, req.streamer.id, discordGuild.name);
  console.log(`[Dashboard] ${req.streamer.discord_username} claimed guild ${discordGuild.name}`);
  res.redirect(`/dashboard/guild/${guildId}`);
});

// Account page
router.get('/account', (req, res) => {
  const { tier, limits } = getTierLimits(req.streamer.id);
  const stats = db.getStreamerStats(req.streamer.id);
  const notificationsOverTime = db.getStreamerNotificationsOverTime(req.streamer.id, '%Y-%m-%d', 30);
  const notificationsByType = db.getStreamerNotificationsByType(req.streamer.id);
  const subscription = db.getSubscription(req.streamer.id);

  res.render('account', {
    streamer: req.streamer,
    tier,
    limits,
    stats,
    notificationsOverTime,
    notificationsByType,
    subscription,
  });
});

// Dashboard home — list guilds
router.get('/', (req, res) => {
  const guilds = db.getGuildsForStreamer(req.streamer.id);
  const msg = req.query.msg;

  const enrichedGuilds = guilds.map((g) => {
    const discordGuild = client.guilds.cache.get(g.guild_id);
    const stats = db.getGuildNotificationStats(req.streamer.id, g.guild_id);
    const twitchCount = db.getWatchedChannelsForGuild(g.guild_id, req.streamer.id).length;
    const youtubeCount = db.getWatchedYoutubeChannelsForGuild(g.guild_id, req.streamer.id).length;
    const chartData = db.getGuildNotificationsByTypeOverTime(req.streamer.id, g.guild_id, '30d');
    return {
      ...g,
      name: discordGuild?.name || g.guild_name || 'Unknown Server',
      icon: discordGuild?.iconURL({ size: 64 }) || null,
      botPresent: !!discordGuild,
      stats,
      twitchCount,
      youtubeCount,
      chartData,
    };
  });

  // Only show guilds NOT claimed by anyone (including this user)
  const myGuildIds = new Set(guilds.map((g) => g.guild_id));
  const allClaimed = db.getAllClaimedGuildIds();
  const unclaimedGuilds = client.guilds.cache
    .filter((g) => !myGuildIds.has(g.id) && !allClaimed.has(g.id))
    .map((g) => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 64 }) }));

  const botInviteUrl = `https://discord.com/oauth2/authorize?client_id=${client.application.id}&permissions=8&scope=bot%20applications.commands&state=${req.streamer.id}`;
  const { tier, limits } = getTierLimits(req.streamer.id);

  res.render('dashboard', {
    streamer: req.streamer,
    guilds: enrichedGuilds,
    unclaimedGuilds,
    botInviteUrl,
    msg,
    tier,
    limits,
  });
});

// Guild stats page
router.get('/guild/:guildId/stats', (req, res) => {
  const { guildId } = req.params;
  const guildConfig = db.getGuildConfig(guildId, req.streamer.id);
  if (!guildConfig) return res.redirect('/dashboard');

  const discordGuild = client.guilds.cache.get(guildId);
  const period = req.query.period || '7d';
  const stats = db.getGuildStatsByPeriod(req.streamer.id, guildId, period);
  const chartData = db.getGuildNotificationsOverTime(req.streamer.id, guildId, period);
  const twitchCount = db.getWatchedChannelsForGuild(guildId, req.streamer.id).length;
  const youtubeCount = db.getWatchedYoutubeChannelsForGuild(guildId, req.streamer.id).length;

  res.render('guild-stats', {
    streamer: req.streamer,
    guild: guildConfig,
    guildName: discordGuild?.name || guildConfig.guild_name || 'Unknown',
    guildId,
    period,
    stats,
    chartData,
    twitchCount,
    youtubeCount,
  });
});

// Guild config page
router.get('/guild/:guildId', async (req, res) => {
  const { guildId } = req.params;
  const guildConfig = db.getGuildConfig(guildId, req.streamer.id);
  if (!guildConfig) return res.redirect('/dashboard');

  const discordGuild = client.guilds.cache.get(guildId);
  const channels = getDiscordChannels(guildId);
  const roles = discordGuild
    ? discordGuild.roles.cache
        .filter((r) => !r.managed && r.name !== '@everyone')
        .map((r) => ({ id: r.id, name: r.name }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  const watchedTwitchChannels = db.getWatchedChannelsForGuild(guildId, req.streamer.id);

  // Enrich Twitch channels with live status and backfill profile images
  for (const wc of watchedTwitchChannels) {
    const state = db.getChannelState(wc.twitch_username);
    wc.is_live = state?.is_live === 1;
    if (!wc.profile_image_url) {
      try {
        const profile = await getUserProfile(wc.twitch_username);
        if (profile?.profile_image_url) {
          db.updateWatchedChannelProfileImage(wc.id, profile.profile_image_url);
          wc.profile_image_url = profile.profile_image_url;
        }
      } catch (e) {
        // Silently skip — will retry next page load
      }
    }
  }

  const watchedYoutubeChannels = db.getWatchedYoutubeChannelsForGuild(guildId, req.streamer.id);

  // Enrich YouTube channels with live status
  for (const wc of watchedYoutubeChannels) {
    const state = db.getYoutubeChannelState(wc.youtube_channel_id);
    wc.is_live = state?.is_live === 1;
  }
  const { tier, limits } = getTierLimits(req.streamer.id);

  res.render('guild-config', {
    streamer: req.streamer,
    guild: guildConfig,
    guildName: discordGuild?.name || guildConfig.guild_name || 'Unknown',
    guildId,
    channels,
    roles,
    watchedTwitchChannels,
    watchedYoutubeChannels,
    hasBroadcasterToken: !!req.streamer.broadcaster_access_token,
    broadcasterAuthUrl: `${config.app.url}/auth/broadcaster`,
    tier,
    limits,
    msg: req.query.msg,
    saved: req.query.saved,
    activeTab: req.query.tab || 'twitch',
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
    recap_enabled: req.body.recap_enabled === 'on',
    milestones_enabled: req.body.milestones_enabled === 'on',
    weekly_highlights_enabled: req.body.weekly_highlights_enabled === 'on',
  });

  console.log(`[Dashboard] Guild ${guildId} config updated by ${req.streamer.discord_username}`);
  res.redirect(`/dashboard/guild/${guildId}?tab=discord&saved=1`);
});

// Remove a guild
router.post('/guild/:guildId/remove', async (req, res) => {
  const { guildId } = req.params;
  try { await client.guilds.cache.get(guildId)?.leave(); } catch (e) { console.error('[Dashboard] Failed to leave guild:', e.message); }
  db.deleteGuild(guildId, req.streamer.id);
  console.log(`[Dashboard] ${req.streamer.discord_username} removed guild ${guildId}`);
  res.redirect('/dashboard?msg=guild_removed');
});

// --- Watched Twitch Channels ---

router.get('/guild/:guildId/channels', (req, res) => {
  res.redirect(`/dashboard/guild/${req.params.guildId}?tab=twitch`);
});

router.post('/guild/:guildId/channels', async (req, res) => {
  const { guildId } = req.params;
  if (!db.getGuildConfig(guildId, req.streamer.id)) return res.redirect('/dashboard');
  const { limits } = getTierLimits(req.streamer.id);

  const twitchUsername = (req.body.twitch_username || '').trim().toLowerCase();
  const liveChannelId = req.body.live_channel_id;
  const clipsChannelId = req.body.clips_channel_id;

  if (!twitchUsername || (!liveChannelId && !clipsChannelId)) {
    return res.redirect(`/dashboard/guild/${guildId}?tab=twitch&msg=missing_fields`);
  }

  // Check clips permission
  if (clipsChannelId && !limits.twitchClips) {
    return res.redirect(`/dashboard/guild/${guildId}?tab=twitch&msg=upgrade_clips`);
  }

  // Check max channels for free tier
  if (limits.maxTwitchChannels !== -1) {
    const existing = db.getWatchedChannelsForGuild(guildId, req.streamer.id);
    if (existing.length >= limits.maxTwitchChannels) {
      return res.redirect(`/dashboard/guild/${guildId}?tab=twitch&msg=channel_limit`);
    }
  }

  const profile = await getUserProfile(twitchUsername);
  db.addWatchedChannel(guildId, req.streamer.id, twitchUsername, liveChannelId, clipsChannelId, !!liveChannelId, !!clipsChannelId, profile?.profile_image_url || null);
  console.log(`[Dashboard] Added Twitch channel ${twitchUsername} for guild ${guildId}`);
  res.redirect(`/dashboard/guild/${guildId}?tab=twitch&msg=added`);
});

router.post('/guild/:guildId/channels/:channelId/remove', (req, res) => {
  const { guildId, channelId } = req.params;
  db.removeWatchedChannel(parseInt(channelId), req.streamer.id);
  res.redirect(`/dashboard/guild/${guildId}?tab=twitch&msg=removed`);
});

router.post('/guild/:guildId/channels/:channelId/edit', (req, res) => {
  const { guildId, channelId } = req.params;
  if (!db.getGuildConfig(guildId, req.streamer.id)) return res.redirect('/dashboard');
  const liveChannelId = req.body.live_channel_id || null;
  const clipsChannelId = req.body.clips_channel_id || null;
  console.log(`[Dashboard] Editing Twitch channel ${channelId}: live=${liveChannelId}, clips=${clipsChannelId}`);
  db.updateWatchedChannel(parseInt(channelId), req.streamer.id, liveChannelId, clipsChannelId);
  console.log(`[Dashboard] Updated Twitch channel ${channelId} for guild ${guildId}`);
  res.redirect(`/dashboard/guild/${guildId}?tab=twitch&msg=updated`);
});

// --- Watched YouTube Channels ---

router.get('/guild/:guildId/youtube', (req, res) => {
  res.redirect(`/dashboard/guild/${req.params.guildId}?tab=youtube`);
});

router.post('/guild/:guildId/youtube', async (req, res) => {
  const { guildId } = req.params;
  if (!db.getGuildConfig(guildId, req.streamer.id)) return res.redirect('/dashboard');

  const { limits } = getTierLimits(req.streamer.id);
  if (!limits.youtube) {
    return res.redirect(`/dashboard/guild/${guildId}?tab=youtube&msg=upgrade_youtube`);
  }

  const input = (req.body.youtube_channel || '').trim();
  const videosChannelId = req.body.videos_channel_id;
  const liveChannelId = req.body.live_channel_id;

  if (!input || (!videosChannelId && !liveChannelId)) {
    return res.redirect(`/dashboard/guild/${guildId}?tab=youtube&msg=missing_fields`);
  }

  // Resolve @handle or channel ID
  let ytChannelId, ytChannelName;
  try {
    const resolved = await resolveChannelId(input);
    if (!resolved) {
      return res.redirect(`/dashboard/guild/${guildId}?tab=youtube&msg=yt_not_found`);
    }
    ytChannelId = resolved.channelId;
    ytChannelName = resolved.channelName || input;
  } catch (e) {
    console.error(`[Dashboard] YouTube resolve error: ${e.message}`);
    return res.redirect(`/dashboard/guild/${guildId}?tab=youtube&msg=yt_not_found`);
  }

  // Check max YouTube channels
  if (limits.maxYoutubeChannels !== -1) {
    const existing = db.getWatchedYoutubeChannelsForGuild(guildId, req.streamer.id);
    if (existing.length >= limits.maxYoutubeChannels) {
      return res.redirect(`/dashboard/guild/${guildId}?tab=youtube&msg=channel_limit`);
    }
  }

  // Pre-populate known videos to avoid notifying about old content
  let knownVideoIds = null;
  try {
    const existingVideos = await getLatestVideos(ytChannelId);
    if (existingVideos.length > 0) {
      knownVideoIds = JSON.stringify(existingVideos.map(v => v.id));
    }
  } catch (e) {
    console.warn(`[Dashboard] Failed to fetch initial videos for ${ytChannelId}: ${e.message}`);
  }

  db.addWatchedYoutubeChannel(guildId, req.streamer.id, ytChannelId, ytChannelName, videosChannelId, liveChannelId, knownVideoIds);
  console.log(`[Dashboard] Added YouTube channel ${ytChannelId} (${ytChannelName}) for guild ${guildId}`);
  res.redirect(`/dashboard/guild/${guildId}?tab=youtube&msg=added`);
});

router.post('/guild/:guildId/youtube/:channelId/remove', (req, res) => {
  const { guildId, channelId } = req.params;
  db.removeWatchedYoutubeChannel(parseInt(channelId), req.streamer.id);
  res.redirect(`/dashboard/guild/${guildId}?tab=youtube&msg=removed`);
});

router.post('/guild/:guildId/youtube/:channelId/edit', (req, res) => {
  const { guildId, channelId } = req.params;
  if (!db.getGuildConfig(guildId, req.streamer.id)) return res.redirect('/dashboard');
  db.updateWatchedYoutubeChannel(parseInt(channelId), req.streamer.id, req.body.videos_channel_id, req.body.live_channel_id);
  console.log(`[Dashboard] Updated YouTube channel ${channelId} for guild ${guildId}`);
  res.redirect(`/dashboard/guild/${guildId}?tab=youtube&msg=updated`);
});

// --- Report an Issue ---

router.get('/report', (req, res) => {
  res.render('report-issue', { streamer: req.streamer, msg: req.query.msg });
});

router.post('/report', (req, res) => {
  const subject = (req.body.subject || '').trim();
  const description = (req.body.description || '').trim();

  if (!subject || !description) {
    return res.redirect('/dashboard/report?msg=missing_fields');
  }

  db.createIssue(
    req.streamer.id,
    req.streamer.discord_display_name || req.streamer.discord_username,
    subject,
    description
  );
  console.log(`[Dashboard] Issue reported by ${req.streamer.discord_username}: ${subject}`);
  res.redirect('/dashboard/report?msg=submitted');
});

module.exports = router;
