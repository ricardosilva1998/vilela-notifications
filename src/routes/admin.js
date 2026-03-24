const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');

const router = Router();

// Admin auth middleware — uses Discord session, checks isAdmin
function requireAdmin(req, res, next) {
  if (req.streamer && db.isAdmin(req.streamer.id)) {
    return next();
  }
  res.redirect('/dashboard');
}

// Main admin dashboard (tabbed)
router.get('/', requireAdmin, (req, res) => {
  res.redirect('/admin/dashboard');
});

router.get('/dashboard', requireAdmin, (req, res) => {
  const activeTab = req.query.tab || 'stats';

  // Stats tab data
  const stats = db.getGlobalStats();
  const users = db.getUsersOverTime('%Y-%m', 12);
  const notifications = db.getNotificationsOverTime('%Y-%m', 12);
  const servers = db.getServersOverTime('%Y-%m', 12);
  const tierBreakdown = db.getSubscriptionsByTier();
  const revenueStats = db.getRevenueStats();

  // Users tab data — enrich with current tier
  const streamers = db.getAllStreamersAdmin().map(s => ({
    ...s,
    currentTier: db.getStreamerTier(s.id),
  }));

  // Issues tab data
  const issues = db.getAllIssues();

  // Feedback tab data
  const feedback = db.getAllFeedback();

  // Discounts tab data
  const codes = db.getAllDiscountCodes();

  // System stats
  const uptime = process.uptime();
  const memory = process.memoryUsage();
  let dbSize = 0;
  try {
    const dbPath = path.join(__dirname, '..', 'data', 'bot.db');
    dbSize = fs.statSync(dbPath).size;
  } catch (e) {}

  res.render('admin-dashboard', {
    streamer: req.streamer,
    title: 'Admin Panel',
    activeTab,
    stats,
    users,
    notifications,
    servers,
    tierBreakdown,
    revenueStats,
    streamers,
    issues,
    feedback,
    codes,
    system: { uptime, memory, dbSize },
    msg: req.query.msg,
  });
});

// --- User management ---

router.post('/streamers/:id/toggle', requireAdmin, (req, res) => {
  const s = db.getStreamerById(parseInt(req.params.id));
  if (!s) return res.redirect('/admin/dashboard?tab=users');

  if (s.enabled) {
    db.disableStreamer(s.id, req.body.note || 'Disabled by admin');
    console.log(`[Admin] Disabled streamer ${s.discord_username} (${s.id})`);
  } else {
    db.enableStreamer(s.id);
    console.log(`[Admin] Enabled streamer ${s.discord_username} (${s.id})`);
  }
  res.redirect('/admin/dashboard?tab=users');
});

router.post('/streamers/:id/remove', requireAdmin, (req, res) => {
  const s = db.getStreamerById(parseInt(req.params.id));
  if (!s) return res.redirect('/admin/dashboard?tab=users');

  db.deleteStreamer(s.id);
  console.log(`[Admin] Removed streamer ${s.discord_username} (${s.id})`);
  res.redirect('/admin/dashboard?tab=users&msg=removed');
});

router.post('/streamers/:id/set-tier', requireAdmin, (req, res) => {
  const s = db.getStreamerById(parseInt(req.params.id));
  if (!s) return res.redirect('/admin/dashboard?tab=users');

  const tier = req.body.tier;
  if (!['free', 'starter', 'pro', 'enterprise'].includes(tier)) {
    return res.redirect('/admin/dashboard?tab=users');
  }

  db.createSubscription(s.id, tier, null, null);
  console.log(`[Admin] Set ${s.discord_username} tier to ${tier}`);
  res.redirect('/admin/dashboard?tab=users&msg=tier_updated');
});

// --- Issues ---

router.post('/issues/:id', requireAdmin, (req, res) => {
  const issue = db.getIssueById(parseInt(req.params.id));
  if (!issue) return res.redirect('/admin/dashboard?tab=issues');

  db.updateIssueStatus(issue.id, req.body.status || 'open', req.body.admin_reply);
  console.log(`[Admin] Issue ${issue.id} updated to ${req.body.status}`);
  res.redirect('/admin/dashboard?tab=issues&msg=updated');
});

// --- Testing Tools ---

const { getUserId, getClips, getVideos, getFollowerCount, getStream } = require('../services/twitch');
const { buildRecapEmbed, buildMilestoneEmbed, buildWeeklyDigestEmbed, buildEmbed, sendNotification } = require('../discord');
const { getLatestVideos, resolveChannelId } = require('../services/youtube');

// Test: Stream Recap
router.post('/test/recap/:username', requireAdmin, async (req, res) => {
  const username = req.params.username.toLowerCase();

  try {
    // Get broadcaster ID
    let state = db.getChannelState(username);
    let broadcasterId = state?.twitch_broadcaster_id;
    if (!broadcasterId) {
      broadcasterId = await getUserId(username);
      if (broadcasterId) db.updateChannelState(username, { twitch_broadcaster_id: broadcasterId });
    }

    // Fetch recent clips
    let clips = [];
    let vodUrl = null;
    let followerCount = null;
    if (broadcasterId) {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const allClips = await getClips(broadcasterId, since);
      clips = allClips.sort((a, b) => b.view_count - a.view_count).slice(0, 3);

      // Fetch most recent VOD
      try {
        const videos = await getVideos(broadcasterId);
        if (videos.length > 0) vodUrl = videos[0].url;
      } catch (e) {}

      // Fetch followers if broadcaster token available
      const watchers = db.getWatchersForChannel(username);
      for (const w of watchers) {
        const streamer = db.getStreamerById(w.streamer_id);
        if (streamer?.broadcaster_access_token) {
          try { followerCount = await getFollowerCount(broadcasterId, streamer.broadcaster_access_token); } catch (e) {}
          break;
        }
      }
    }

    const recapData = {
      twitchUsername: username,
      title: state?.stream_title || 'Stream Recap (Test)',
      category: state?.stream_category || 'Just Chatting',
      thumbnailUrl: state?.stream_thumbnail_url || null,
      duration: 7200,
      peakViewers: state?.peak_viewers || 0,
      followerCount,
      vodUrl,
      clips,
    };

    const embed = buildRecapEmbed(recapData);

    // Send to all watchers with a live_channel_id
    const watchers = db.getWatchersForChannel(username).filter(w => w.live_channel_id);
    let sent = 0;
    for (const w of watchers) {
      try {
        // Send VOD first as plain text (Discord video player)
        if (recapData.vodUrl) {
          await sendNotification(w.live_channel_id, null, {
            streamerId: w.streamer_id,
            guildId: w.guild_id,
            type: 'twitch_recap',
            contentOnly: `📺 **${username} stream recap**\n${recapData.vodUrl}`,
          });
        }
        // Then send stats embed below
        await sendNotification(w.live_channel_id, embed, {
          streamerId: w.streamer_id,
          guildId: w.guild_id,
          type: 'twitch_recap',
        });
        sent++;
      } catch (e) {
        console.error(`[TestRecap] Send failed: ${e.message}`);
      }
    }

    console.log(`[Admin] Test recap for ${username}: ${sent} sent to ${watchers.length} watchers`);
    res.redirect(`/admin/dashboard?tab=testing&msg=test_sent_${sent}`);
  } catch (e) {
    console.error(`[Admin] Test error: ${e.message}`);
    res.redirect(`/admin/dashboard?tab=testing&msg=test_error`);
  }
});

// Test: Milestone Celebration
router.post('/test/milestone/:username', requireAdmin, async (req, res) => {
  const username = req.params.username.toLowerCase();
  try {
    let broadcasterId = db.getChannelState(username)?.twitch_broadcaster_id;
    if (!broadcasterId) {
      broadcasterId = await getUserId(username);
      if (broadcasterId) db.updateChannelState(username, { twitch_broadcaster_id: broadcasterId });
    }

    let followerCount = 500;
    const watchers = db.getWatchersForChannel(username);
    for (const w of watchers) {
      const streamer = db.getStreamerById(w.streamer_id);
      if (streamer?.broadcaster_access_token) {
        try { followerCount = await getFollowerCount(broadcasterId, streamer.broadcaster_access_token); } catch (e) {}
        break;
      }
    }

    const embed = buildMilestoneEmbed({ twitchUsername: username, milestoneType: 'follower', count: followerCount });
    let sent = 0;
    for (const w of watchers.filter(w => w.live_channel_id)) {
      try { await sendNotification(w.live_channel_id, embed, { streamerId: w.streamer_id, guildId: w.guild_id, type: 'twitch_milestone' }); sent++; } catch (e) {}
    }
    res.redirect(`/admin/dashboard?tab=testing&msg=test_sent_${sent}`);
  } catch (e) {
    console.error(`[Admin] Test milestone error: ${e.message}`);
    res.redirect(`/admin/dashboard?tab=testing&msg=test_error`);
  }
});

// Test: Twitch Go-Live
router.post('/test/twitch-live/:username', requireAdmin, async (req, res) => {
  const username = req.params.username.toLowerCase();
  try {
    const stream = await getStream(username);
    const embed = buildEmbed({
      color: 0x9146ff,
      author: { name: `${stream?.user_name || username} is live on Twitch!` },
      title: stream?.title || 'Test Stream',
      url: `https://twitch.tv/${username}`,
      description: `Playing **${stream?.game_name || 'Just Chatting'}**`,
      image: stream?.thumbnail_url ? stream.thumbnail_url.replace('{width}', '1280').replace('{height}', '720') : undefined,
      footer: { text: 'Twitch' },
      timestamp: new Date(),
    });

    const watchers = db.getWatchersForChannel(username).filter(w => w.live_channel_id);
    let sent = 0;
    for (const w of watchers) {
      try { await sendNotification(w.live_channel_id, embed, { streamerId: w.streamer_id, guildId: w.guild_id, type: 'twitch_live' }); sent++; } catch (e) {}
    }
    res.redirect(`/admin/dashboard?tab=testing&msg=test_sent_${sent}`);
  } catch (e) {
    console.error(`[Admin] Test twitch-live error: ${e.message}`);
    res.redirect(`/admin/dashboard?tab=testing&msg=test_error`);
  }
});

// Test: Twitch Clip
router.post('/test/twitch-clip/:username', requireAdmin, async (req, res) => {
  const username = req.params.username.toLowerCase();
  try {
    let broadcasterId = db.getChannelState(username)?.twitch_broadcaster_id;
    if (!broadcasterId) {
      broadcasterId = await getUserId(username);
      if (broadcasterId) db.updateChannelState(username, { twitch_broadcaster_id: broadcasterId });
    }
    if (!broadcasterId) return res.redirect(`/admin/dashboard?tab=testing&msg=test_error`);

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const clips = await getClips(broadcasterId, since);
    if (clips.length === 0) return res.redirect(`/admin/dashboard?tab=testing&msg=test_no_data`);

    const clip = clips.sort((a, b) => b.view_count - a.view_count)[0];
    const message = `**New clip by ${clip.creator_name}** — ${clip.title}\n📊 ${clip.view_count} views · ⏱️ ${Math.round(clip.duration)}s\n${clip.url}`;

    const watchers = db.getWatchersForChannel(username).filter(w => w.clips_channel_id);
    let sent = 0;
    for (const w of watchers) {
      try { await sendNotification(w.clips_channel_id, null, { streamerId: w.streamer_id, guildId: w.guild_id, type: 'twitch_clip', contentOnly: message }); sent++; } catch (e) {}
    }
    res.redirect(`/admin/dashboard?tab=testing&msg=test_sent_${sent}`);
  } catch (e) {
    console.error(`[Admin] Test twitch-clip error: ${e.message}`);
    res.redirect(`/admin/dashboard?tab=testing&msg=test_error`);
  }
});

// Test: YouTube Video/Short
router.post('/test/youtube-video/:input', requireAdmin, async (req, res) => {
  const input = decodeURIComponent(req.params.input);
  try {
    const resolved = await resolveChannelId(input);
    if (!resolved) return res.redirect(`/admin/dashboard?tab=testing&msg=test_error`);
    const channelId = resolved.channelId;

    const videos = await getLatestVideos(channelId);
    if (videos.length === 0) return res.redirect(`/admin/dashboard?tab=testing&msg=test_no_data`);

    const video = videos[0];
    const message = `🎬 **${video.author || resolved.channelName || 'New'} uploaded a new video!** — ${video.title}\n${video.url}`;

    const ytWatchers = db.db.prepare('SELECT wyc.*, s.enabled AS streamer_enabled FROM watched_youtube_channels wyc JOIN streamers s ON wyc.streamer_id = s.id WHERE wyc.youtube_channel_id = ? AND wyc.enabled = 1 AND s.enabled = 1').all(channelId);
    let sent = 0;
    for (const w of ytWatchers.filter(w => w.videos_channel_id)) {
      try { await sendNotification(w.videos_channel_id, null, { streamerId: w.streamer_id, guildId: w.guild_id, type: 'youtube_video', contentOnly: message }); sent++; } catch (e) {}
    }
    res.redirect(`/admin/dashboard?tab=testing&msg=test_sent_${sent}`);
  } catch (e) {
    console.error(`[Admin] Test youtube-video error: ${e.message}`);
    res.redirect(`/admin/dashboard?tab=testing&msg=test_error`);
  }
});

// Test: YouTube Live
router.post('/test/youtube-live/:input', requireAdmin, async (req, res) => {
  const input = decodeURIComponent(req.params.input);
  try {
    const resolved = await resolveChannelId(input);
    if (!resolved) return res.redirect(`/admin/dashboard?tab=testing&msg=test_error`);

    const embed = buildEmbed({
      color: 0xff0000,
      author: { name: `${resolved.channelName || input} is live on YouTube!` },
      title: 'Live Stream (Test)',
      url: `https://youtube.com/channel/${resolved.channelId}/live`,
      footer: { text: 'YouTube Live' },
      timestamp: new Date(),
    });

    const ytWatchers = db.db.prepare('SELECT wyc.*, s.enabled AS streamer_enabled FROM watched_youtube_channels wyc JOIN streamers s ON wyc.streamer_id = s.id WHERE wyc.youtube_channel_id = ? AND wyc.enabled = 1 AND s.enabled = 1').all(resolved.channelId);
    let sent = 0;
    for (const w of ytWatchers.filter(w => w.live_channel_id)) {
      try { await sendNotification(w.live_channel_id, embed, { streamerId: w.streamer_id, guildId: w.guild_id, type: 'youtube_live' }); sent++; } catch (e) {}
    }
    res.redirect(`/admin/dashboard?tab=testing&msg=test_sent_${sent}`);
  } catch (e) {
    console.error(`[Admin] Test youtube-live error: ${e.message}`);
    res.redirect(`/admin/dashboard?tab=testing&msg=test_error`);
  }
});

// Test: Weekly Digest
router.post('/test/weekly-digest/:username', requireAdmin, async (req, res) => {
  const username = req.params.username.toLowerCase();
  try {
    let broadcasterId = db.getChannelState(username)?.twitch_broadcaster_id;
    if (!broadcasterId) {
      broadcasterId = await getUserId(username);
      if (broadcasterId) db.updateChannelState(username, { twitch_broadcaster_id: broadcasterId });
    }

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    let streamCount = 0, totalHours = 0;
    const categories = [];
    let topClip = null;

    if (broadcasterId) {
      const videos = await getVideos(broadcasterId, since);
      streamCount = videos.length;
      for (const v of videos) {
        const match = v.duration?.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
        if (match) totalHours += ((parseInt(match[1]||0)*3600) + (parseInt(match[2]||0)*60) + parseInt(match[3]||0)) / 3600;
      }
      const clips = await getClips(broadcasterId, since);
      if (clips.length > 0) {
        topClip = clips.sort((a,b) => b.view_count - a.view_count)[0];
        topClip = { title: topClip.title, url: topClip.url, view_count: topClip.view_count };
      }
    }

    const embed = buildWeeklyDigestEmbed({
      streamCount, totalHours, categories,
      topClip,
    });

    const watchers = db.getWatchersForChannel(username).filter(w => w.live_channel_id);
    let sent = 0;
    for (const w of watchers) {
      try { await sendNotification(w.live_channel_id, embed, { streamerId: w.streamer_id, guildId: w.guild_id, type: 'weekly_digest' }); sent++; } catch (e) {}
    }
    res.redirect(`/admin/dashboard?tab=testing&msg=test_sent_${sent}`);
  } catch (e) {
    console.error(`[Admin] Test weekly-digest error: ${e.message}`);
    res.redirect(`/admin/dashboard?tab=testing&msg=test_error`);
  }
});

// Test: Welcome Message
router.post('/test/welcome', requireAdmin, async (req, res) => {
  const guildId = req.body.guild_id;
  if (!guildId) return res.redirect(`/admin/dashboard?tab=testing&msg=test_error`);

  try {
    const guildConfigs = db.db.prepare('SELECT * FROM guilds WHERE guild_id = ? AND welcome_enabled = 1').all(guildId);
    let sent = 0;
    for (const gc of guildConfigs) {
      if (!gc.welcome_channel_id) continue;
      const message = gc.welcome_message || 'Welcome to the server! 👋';
      try { await sendNotification(gc.welcome_channel_id, null, { streamerId: gc.streamer_id, guildId, type: 'welcome', contentOnly: `**Test Welcome Message**\n${message}` }); sent++; } catch (e) {}
    }
    res.redirect(`/admin/dashboard?tab=testing&msg=test_sent_${sent}`);
  } catch (e) {
    console.error(`[Admin] Test welcome error: ${e.message}`);
    res.redirect(`/admin/dashboard?tab=testing&msg=test_error`);
  }
});

// --- Discounts ---

router.post('/discounts', requireAdmin, (req, res) => {
  const { code, discount_percent, max_uses } = req.body;
  if (!code || !discount_percent) return res.redirect('/admin/dashboard?tab=discounts');
  db.createDiscountCode(code, parseInt(discount_percent), max_uses ? parseInt(max_uses) : null);
  console.log(`[Admin] Created discount code ${code} (${discount_percent}%)`);
  res.redirect('/admin/dashboard?tab=discounts&msg=created');
});

router.post('/discounts/:id/toggle', requireAdmin, (req, res) => {
  const codes = db.getAllDiscountCodes();
  const code = codes.find((c) => c.id === parseInt(req.params.id));
  if (code) db.toggleDiscountCode(code.id, !code.active);
  res.redirect('/admin/dashboard?tab=discounts');
});

module.exports = router;
