const { getStream, getClips } = require('../services/twitch');
const { buildEmbed } = require('../discord');

function formatThumbnail(url) {
  return url.replace('{width}', '1280').replace('{height}', '720');
}

async function check(twitchUsername, channelState) {
  const stream = await getStream(twitchUsername);

  // Channel just went LIVE
  if (stream && !channelState.is_live) {
    const embed = buildEmbed({
      color: 0x9146ff,
      author: { name: `${stream.user_name || twitchUsername} is live on Twitch!` },
      title: stream.title,
      url: `https://twitch.tv/${twitchUsername}`,
      description: `Playing **${stream.game_name || 'Unknown'}**`,
      image: formatThumbnail(stream.thumbnail_url),
      footer: { text: 'Twitch' },
      timestamp: new Date(),
    });

    return {
      notify: true,
      embed,
      stateUpdate: {
        is_live: 1,
        stream_title: stream.title,
        stream_category: stream.game_name || 'Unknown',
        stream_thumbnail_url: formatThumbnail(stream.thumbnail_url),
        stream_started_at: stream.started_at,
      },
    };
  }

  // Channel just went OFFLINE — build recap data
  if (!stream && channelState.is_live) {
    let recapData = null;

    if (channelState.stream_started_at) {
      const startedAt = new Date(channelState.stream_started_at);
      const now = new Date();
      const durationSec = Math.floor((now - startedAt) / 1000);

      // Skip recap for very short streams (under 5 minutes)
      if (durationSec >= 300) {
        let clips = [];
        const broadcasterId = channelState.twitch_broadcaster_id;
        if (broadcasterId) {
          try {
            const allClips = await getClips(broadcasterId, channelState.stream_started_at, now.toISOString());
            clips = allClips
              .sort((a, b) => b.view_count - a.view_count)
              .slice(0, 3);
          } catch (e) {
            console.error(`[TwitchLive] Failed to fetch recap clips for ${twitchUsername}: ${e.message}`);
          }
        }

        recapData = {
          twitchUsername,
          title: channelState.stream_title,
          category: channelState.stream_category,
          thumbnailUrl: channelState.stream_thumbnail_url,
          duration: durationSec,
          clips,
        };
      }
    }

    return {
      notify: false,
      recapData,
      stateUpdate: { is_live: 0 },
      clearSession: true,
    };
  }

  return null;
}

module.exports = { check };
