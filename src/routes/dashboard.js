const { Router } = require('express');
const config = require('../config');
const db = require('../db');
const { client } = require('../discord');
const { getUserProfile } = require('../services/twitch');
const { resolveChannelId, getLatestVideos, getChannelInfo } = require('../services/youtube');
const { resolveProfile: resolveInstagram, getLatestPosts: getLatestInstagramPosts } = require('../services/instagram');
const { resolveProfile: resolveTikTok, getLatestVideos: getLatestTikTokVideos } = require('../services/tiktok');
const { resolveProfile: resolveTwitter, getLatestTweets } = require('../services/twitter');
const iracing = require('../services/iracing');

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
    feedbackMsg: req.query.feedback,
  });
});

// Save YouTube API key
router.post('/account/youtube-api-key', (req, res) => {
  const apiKey = (req.body.youtube_api_key || '').trim();
  db.updateStreamerYoutube(req.streamer.id, req.streamer.youtube_channel_id, apiKey || null);
  console.log(`[Dashboard] YouTube API key ${apiKey ? 'saved' : 'cleared'} for ${req.streamer.discord_username}`);
  res.redirect('/dashboard/account');
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

  // Enrich YouTube channels with live status and backfill profile images + names
  for (const wc of watchedYoutubeChannels) {
    const state = db.getYoutubeChannelState(wc.youtube_channel_id);
    wc.is_live = state?.is_live === 1;
    if (!wc.profile_image_url || !wc.youtube_channel_name) {
      try {
        const info = await getChannelInfo(wc.youtube_channel_id);
        if (info) {
          if (info.profileImageUrl || info.channelName) {
            db.updateWatchedYoutubeChannelInfo(wc.id, info.profileImageUrl, info.channelName);
            wc.profile_image_url = info.profileImageUrl || wc.profile_image_url;
            wc.youtube_channel_name = info.channelName || wc.youtube_channel_name;
          }
        }
      } catch (e) {
        // Skip — will retry on next page load
      }
    }
  }
  const watchedInstagramAccounts = db.getWatchedInstagramForGuild(guildId, req.streamer.id);
  const watchedTikTokAccounts = db.getWatchedTikTokForGuild(guildId, req.streamer.id);
  const watchedTwitterAccounts = db.getWatchedTwitterForGuild(guildId, req.streamer.id);
  const watchedIracingDrivers = db.getWatchedIracingDriversForGuild(guildId, req.streamer.id);

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
    watchedInstagramAccounts,
    watchedTikTokAccounts,
    watchedTwitterAccounts,
    watchedIracingDrivers,
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
    instagram_enabled: req.body.instagram_enabled === 'on',
    tiktok_enabled: req.body.tiktok_enabled === 'on',
    twitter_enabled: req.body.twitter_enabled === 'on',
    iracing_enabled: req.body.iracing_enabled === 'on',
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
  let ytChannelId, ytChannelName, ytProfileImage;
  try {
    const resolved = await resolveChannelId(input);
    if (!resolved) {
      return res.redirect(`/dashboard/guild/${guildId}?tab=youtube&msg=yt_not_found`);
    }
    ytChannelId = resolved.channelId;
    ytChannelName = resolved.channelName || input;
    ytProfileImage = resolved.profileImageUrl || null;
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

  // Save profile image if available
  if (ytProfileImage) {
    const added = db.getWatchedYoutubeChannelsForGuild(guildId, req.streamer.id);
    const match = added.find(c => c.youtube_channel_id === ytChannelId);
    if (match) db.updateWatchedYoutubeChannelInfo(match.id, ytProfileImage, ytChannelName);
  }

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

// --- Instagram ---
router.post('/guild/:guildId/instagram', async (req, res) => {
  const { guildId } = req.params;
  if (!db.getGuildConfig(guildId, req.streamer.id)) return res.redirect('/dashboard');
  const { limits } = getTierLimits(req.streamer.id);
  if (!limits.instagram) return res.redirect(`/dashboard/guild/${guildId}?tab=instagram&msg=upgrade_social`);

  const input = (req.body.instagram_username || '').trim();
  const notifyChannelId = req.body.notify_channel_id;
  if (!input || !notifyChannelId) return res.redirect(`/dashboard/guild/${guildId}?tab=instagram&msg=missing_fields`);

  // Check social account limit
  if (limits.maxSocialAccounts !== -1) {
    const igCount = db.getWatchedInstagramForGuild(guildId, req.streamer.id).length;
    const ttCount = db.getWatchedTikTokForGuild(guildId, req.streamer.id).length;
    const twCount = db.getWatchedTwitterForGuild(guildId, req.streamer.id).length;
    if (igCount + ttCount + twCount >= limits.maxSocialAccounts) {
      return res.redirect(`/dashboard/guild/${guildId}?tab=instagram&msg=social_limit`);
    }
  }

  const profile = await resolveInstagram(input);
  const username = profile?.username || input.replace(/^@/, '').toLowerCase();

  // Pre-populate known posts
  let knownPostIds = null;
  try {
    const posts = await getLatestInstagramPosts(username);
    if (posts && posts.length > 0) knownPostIds = JSON.stringify(posts.map(p => p.id));
  } catch (e) { console.warn(`[Dashboard] Instagram pre-populate failed: ${e.message}`); }

  db.addWatchedInstagram(guildId, req.streamer.id, username, profile?.displayName, profile?.profileImageUrl, notifyChannelId, knownPostIds);
  console.log(`[Dashboard] Added Instagram account ${username} for guild ${guildId}`);
  res.redirect(`/dashboard/guild/${guildId}?tab=instagram&msg=added`);
});

router.post('/guild/:guildId/instagram/:id/edit', (req, res) => {
  const { guildId, id } = req.params;
  if (!db.getGuildConfig(guildId, req.streamer.id)) return res.redirect('/dashboard');
  db.updateWatchedInstagramChannel(parseInt(id), req.streamer.id, req.body.notify_channel_id);
  res.redirect(`/dashboard/guild/${guildId}?tab=instagram&msg=updated`);
});

router.post('/guild/:guildId/instagram/:id/remove', (req, res) => {
  const { guildId, id } = req.params;
  db.removeWatchedInstagram(parseInt(id), req.streamer.id);
  res.redirect(`/dashboard/guild/${guildId}?tab=instagram&msg=removed`);
});

// --- TikTok ---
router.post('/guild/:guildId/tiktok', async (req, res) => {
  const { guildId } = req.params;
  if (!db.getGuildConfig(guildId, req.streamer.id)) return res.redirect('/dashboard');
  const { limits } = getTierLimits(req.streamer.id);
  if (!limits.tiktok) return res.redirect(`/dashboard/guild/${guildId}?tab=tiktok&msg=upgrade_social`);

  const input = (req.body.tiktok_username || '').trim();
  const notifyChannelId = req.body.notify_channel_id;
  if (!input || !notifyChannelId) return res.redirect(`/dashboard/guild/${guildId}?tab=tiktok&msg=missing_fields`);

  // Check social account limit
  if (limits.maxSocialAccounts !== -1) {
    const igCount = db.getWatchedInstagramForGuild(guildId, req.streamer.id).length;
    const ttCount = db.getWatchedTikTokForGuild(guildId, req.streamer.id).length;
    const twCount = db.getWatchedTwitterForGuild(guildId, req.streamer.id).length;
    if (igCount + ttCount + twCount >= limits.maxSocialAccounts) {
      return res.redirect(`/dashboard/guild/${guildId}?tab=tiktok&msg=social_limit`);
    }
  }

  const profile = await resolveTikTok(input);
  const username = profile?.username || input.replace(/^@/, '').toLowerCase();

  // Pre-populate known videos
  let knownVideoIds = null;
  try {
    const videos = await getLatestTikTokVideos(username);
    if (videos && videos.length > 0) knownVideoIds = JSON.stringify(videos.map(v => v.id));
  } catch (e) { console.warn(`[Dashboard] TikTok pre-populate failed: ${e.message}`); }

  db.addWatchedTikTok(guildId, req.streamer.id, username, profile?.displayName, profile?.profileImageUrl, notifyChannelId, knownVideoIds);
  console.log(`[Dashboard] Added TikTok account ${username} for guild ${guildId}`);
  res.redirect(`/dashboard/guild/${guildId}?tab=tiktok&msg=added`);
});

router.post('/guild/:guildId/tiktok/:id/edit', (req, res) => {
  const { guildId, id } = req.params;
  if (!db.getGuildConfig(guildId, req.streamer.id)) return res.redirect('/dashboard');
  db.updateWatchedTikTokChannel(parseInt(id), req.streamer.id, req.body.notify_channel_id);
  res.redirect(`/dashboard/guild/${guildId}?tab=tiktok&msg=updated`);
});

router.post('/guild/:guildId/tiktok/:id/remove', (req, res) => {
  const { guildId, id } = req.params;
  db.removeWatchedTikTok(parseInt(id), req.streamer.id);
  res.redirect(`/dashboard/guild/${guildId}?tab=tiktok&msg=removed`);
});

// --- Twitter ---
router.post('/guild/:guildId/twitter', async (req, res) => {
  const { guildId } = req.params;
  if (!db.getGuildConfig(guildId, req.streamer.id)) return res.redirect('/dashboard');
  const { limits } = getTierLimits(req.streamer.id);
  if (!limits.twitter) return res.redirect(`/dashboard/guild/${guildId}?tab=twitter&msg=upgrade_social`);

  const input = (req.body.twitter_username || '').trim();
  const notifyChannelId = req.body.notify_channel_id;
  if (!input || !notifyChannelId) return res.redirect(`/dashboard/guild/${guildId}?tab=twitter&msg=missing_fields`);

  // Check social account limit
  if (limits.maxSocialAccounts !== -1) {
    const igCount = db.getWatchedInstagramForGuild(guildId, req.streamer.id).length;
    const ttCount = db.getWatchedTikTokForGuild(guildId, req.streamer.id).length;
    const twCount = db.getWatchedTwitterForGuild(guildId, req.streamer.id).length;
    if (igCount + ttCount + twCount >= limits.maxSocialAccounts) {
      return res.redirect(`/dashboard/guild/${guildId}?tab=twitter&msg=social_limit`);
    }
  }

  const profile = await resolveTwitter(input);
  const username = profile?.username || input.replace(/^@/, '').toLowerCase();

  // Pre-populate known tweets
  let knownTweetIds = null;
  try {
    const tweets = await getLatestTweets(username);
    if (tweets && tweets.length > 0) knownTweetIds = JSON.stringify(tweets.map(t => t.id));
  } catch (e) { console.warn(`[Dashboard] Twitter pre-populate failed: ${e.message}`); }

  db.addWatchedTwitter(guildId, req.streamer.id, username, profile?.displayName, profile?.profileImageUrl, notifyChannelId, knownTweetIds);
  console.log(`[Dashboard] Added Twitter account ${username} for guild ${guildId}`);
  res.redirect(`/dashboard/guild/${guildId}?tab=twitter&msg=added`);
});

router.post('/guild/:guildId/twitter/:id/edit', (req, res) => {
  const { guildId, id } = req.params;
  if (!db.getGuildConfig(guildId, req.streamer.id)) return res.redirect('/dashboard');
  db.updateWatchedTwitterChannel(parseInt(id), req.streamer.id, req.body.notify_channel_id);
  res.redirect(`/dashboard/guild/${guildId}?tab=twitter&msg=updated`);
});

router.post('/guild/:guildId/twitter/:id/remove', (req, res) => {
  const { guildId, id } = req.params;
  db.removeWatchedTwitter(parseInt(id), req.streamer.id);
  res.redirect(`/dashboard/guild/${guildId}?tab=twitter&msg=removed`);
});

// --- iRacing ---

router.post('/guild/:guildId/iracing', async (req, res) => {
  const { guildId } = req.params;
  if (!db.getGuildConfig(guildId, req.streamer.id)) return res.redirect('/dashboard');
  const { limits } = getTierLimits(req.streamer.id);
  if (!limits.iracing) return res.redirect(`/dashboard/guild/${guildId}?tab=iracing&msg=upgrade_iracing`);

  const customerId = (req.body.customer_id || '').trim();
  const notifyChannelId = req.body.notify_channel_id;
  if (!customerId || !notifyChannelId) return res.redirect(`/dashboard/guild/${guildId}?tab=iracing&msg=missing_fields`);

  // Check driver limit
  if (limits.maxIracingDrivers !== -1) {
    const existing = db.getWatchedIracingDriversForGuild(guildId, req.streamer.id);
    if (existing.length >= limits.maxIracingDrivers) {
      return res.redirect(`/dashboard/guild/${guildId}?tab=iracing&msg=iracing_limit`);
    }
  }

  // Resolve driver name from iRacing API
  let driverName = customerId;
  if (iracing.isConfigured()) {
    try {
      const profile = await iracing.getDriverProfile(customerId);
      if (profile?.displayName) driverName = profile.displayName;
    } catch (e) {
      console.warn(`[Dashboard] iRacing profile resolve failed: ${e.message}`);
    }
  }

  db.addWatchedIracingDriver(guildId, req.streamer.id, customerId, driverName, notifyChannelId);

  // Pre-populate known races to avoid old result spam
  if (iracing.isConfigured()) {
    try {
      const recentRaces = await iracing.getRecentRaces(customerId);
      if (recentRaces) {
        for (const race of recentRaces.slice(0, 10)) {
          db.upsertIracingRaceCache({
            subsession_id: String(race.subsession_id),
            customer_id: customerId,
            driver_name: driverName,
            series_name: 'Pre-populated',
            track_name: '',
            car_name: '',
            category: '',
            finish_position: 0,
            starting_position: 0,
            incidents: 0,
            irating_change: 0,
            new_irating: 0,
            laps_completed: 0,
            fastest_lap_time: null,
            qualifying_time: null,
            field_size: 0,
            strength_of_field: 0,
            race_date: race.start_time || new Date().toISOString(),
          });
        }
      }
    } catch (e) {
      console.warn(`[Dashboard] iRacing pre-populate failed: ${e.message}`);
    }
  }

  console.log(`[Dashboard] Added iRacing driver ${customerId} (${driverName}) for guild ${guildId}`);
  res.redirect(`/dashboard/guild/${guildId}?tab=iracing&msg=added`);
});

router.post('/guild/:guildId/iracing/:id/edit', (req, res) => {
  const { guildId, id } = req.params;
  if (!db.getGuildConfig(guildId, req.streamer.id)) return res.redirect('/dashboard');
  db.updateWatchedIracingDriverChannel(parseInt(id), req.streamer.id, req.body.notify_channel_id);
  res.redirect(`/dashboard/guild/${guildId}?tab=iracing&msg=updated`);
});

router.post('/guild/:guildId/iracing/:id/remove', (req, res) => {
  const { guildId, id } = req.params;
  db.removeWatchedIracingDriver(parseInt(id), req.streamer.id);
  res.redirect(`/dashboard/guild/${guildId}?tab=iracing&msg=removed`);
});

// --- Feedback ---

router.post('/feedback', (req, res) => {
  const rating = parseInt(req.body.rating);
  const message = (req.body.message || '').trim();

  if (!rating || rating < 1 || rating > 5 || !message) {
    return res.redirect('/dashboard/account');
  }

  db.createFeedback(
    req.streamer.id,
    req.streamer.discord_display_name || req.streamer.discord_username,
    rating,
    message
  );
  console.log(`[Dashboard] Feedback from ${req.streamer.discord_username}: ${rating}/5`);
  res.redirect('/dashboard/account?feedback=submitted');
});

// --- Overlay Config ---

// Overlay config page
router.get('/overlay', (req, res) => {
  const streamer = req.streamer;
  const appUrl = config.app.url || `${req.protocol}://${req.get('host')}`;
  const overlayUrl = streamer.overlay_token ? `${appUrl}/overlay/${streamer.overlay_token}` : null;
  const needsReauth = !streamer.broadcaster_scopes ||
    !streamer.broadcaster_scopes.includes('moderator:read:followers') ||
    !streamer.broadcaster_scopes.includes('bits:read');

  res.render('overlay-config', {
    streamer,
    overlayUrl,
    needsReauth,
    appUrl,
  });
});

// Save overlay settings
router.post('/overlay', (req, res) => {
  const b = req.body;
  db.updateOverlayConfig(req.streamer.id, {
    overlay_enabled: b.overlay_enabled ? 1 : 0,
    overlay_follow_enabled: b.overlay_follow_enabled ? 1 : 0,
    overlay_sub_enabled: b.overlay_sub_enabled ? 1 : 0,
    overlay_bits_enabled: b.overlay_bits_enabled ? 1 : 0,
    overlay_donation_enabled: b.overlay_donation_enabled ? 1 : 0,
    overlay_follow_duration: parseInt(b.overlay_follow_duration) || 5,
    overlay_sub_duration: parseInt(b.overlay_sub_duration) || 7,
    overlay_bits_duration: parseInt(b.overlay_bits_duration) || 6,
    overlay_donation_duration: parseInt(b.overlay_donation_duration) || 6,
    overlay_volume: parseFloat(b.overlay_volume) || 0.8,
    streamelements_jwt: b.streamelements_jwt || '',
  });

  try {
    const { eventSubManager } = require('../services/eventsub');
    const { streamElementsManager } = require('../services/streamelements');
    if (b.overlay_enabled) {
      eventSubManager.startForStreamer(req.streamer.id);
      if (b.streamelements_jwt) streamElementsManager.startForStreamer(req.streamer.id);
    } else {
      eventSubManager.stopForStreamer(req.streamer.id);
      streamElementsManager.stopForStreamer(req.streamer.id);
    }
  } catch (e) {
    // EventSub/StreamElements services not yet available
  }

  res.redirect('/dashboard/overlay');
});

// Generate overlay token
router.post('/overlay/generate-token', (req, res) => {
  db.generateOverlayToken(req.streamer.id);
  res.redirect('/dashboard/overlay');
});

// Test notification
router.post('/overlay/test/:eventType', (req, res) => {
  const bus = require('../services/overlayBus');
  const type = req.params.eventType;
  const testEvents = {
    follow: { type: 'follow', data: { username: 'TestRacer' } },
    subscription: { type: 'subscription', data: { username: 'SpeedDemon', message: 'Love the stream!', tier: '1', months: 6 } },
    bits: { type: 'bits', data: { username: 'NitroFan', amount: 500, message: 'Take my bits!' } },
    donation: { type: 'donation', data: { username: 'BigSponsor', amount: 25, message: 'Keep racing!', currency: 'USD' } },
  };

  const event = testEvents[type];
  if (!event) return res.status(400).json({ error: 'Invalid event type' });

  bus.emit(`overlay:${req.streamer.id}`, event);
  res.json({ ok: true });
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
