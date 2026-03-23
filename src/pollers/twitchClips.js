const { getClips, getUserId } = require('../services/twitch');
const { sendNotification, buildEmbed } = require('../discord');
const config = require('../config');
const state = require('../state');

let appState;

async function poll() {
  try {
    if (!appState.twitchBroadcasterId) {
      appState.twitchBroadcasterId = await getUserId(config.twitch.username);
      if (!appState.twitchBroadcasterId) {
        console.error('[TwitchClips] Could not resolve broadcaster ID');
        return;
      }
      state.save(appState);
    }

    const since = appState.lastClipCreatedAt || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const clips = await getClips(appState.twitchBroadcasterId, since);

    for (const clip of clips) {
      if (!appState.lastClipCreatedAt || clip.created_at > appState.lastClipCreatedAt) {
        const embed = buildEmbed({
          color: 0x9146ff,
          author: { name: `New clip by ${clip.creator_name}` },
          title: clip.title,
          url: clip.url,
          image: clip.thumbnail_url,
          fields: [
            { name: 'Views', value: String(clip.view_count), inline: true },
            { name: 'Duration', value: `${Math.round(clip.duration)}s`, inline: true },
          ],
          footer: { text: 'Twitch Clip' },
          timestamp: clip.created_at,
        });
        await sendNotification(config.discord.twitchClipsChannelId, embed);
        console.log(`[TwitchClips] Sent clip notification: ${clip.title}`);
      }
    }

    if (clips.length > 0) {
      const newest = clips.reduce((a, b) => (a.created_at > b.created_at ? a : b));
      if (!appState.lastClipCreatedAt || newest.created_at > appState.lastClipCreatedAt) {
        appState.lastClipCreatedAt = newest.created_at;
        state.save(appState);
      }
    }
  } catch (error) {
    console.error(`[TwitchClips] Poll failed: ${error.message}`);
  }
}

function start(sharedState) {
  appState = sharedState;
  setInterval(poll, config.intervals.twitchClips);
  console.log(`[TwitchClips] Polling every ${config.intervals.twitchClips / 1000}s`);
}

async function init(sharedState) {
  appState = sharedState;
  if (!appState.twitchBroadcasterId) {
    appState.twitchBroadcasterId = await getUserId(config.twitch.username);
    console.log(`[TwitchClips] Broadcaster ID: ${appState.twitchBroadcasterId}`);
  }
  if (!appState.lastClipCreatedAt) {
    appState.lastClipCreatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  }
}

module.exports = { start, init };
