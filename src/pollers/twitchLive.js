const { getStream } = require('../services/twitch');
const { buildEmbed } = require('../discord');

function formatThumbnail(url) {
  return url.replace('{width}', '1280').replace('{height}', '720');
}

async function check(streamer, pollerState) {
  const stream = await getStream(streamer.twitch_username);

  if (stream && !pollerState.twitch_is_live) {
    const embed = buildEmbed({
      color: 0x9146ff,
      author: { name: `${streamer.twitch_display_name || streamer.twitch_username} is live on Twitch!` },
      title: stream.title,
      url: `https://twitch.tv/${streamer.twitch_username}`,
      description: `Playing **${stream.game_name || 'Unknown'}**`,
      image: formatThumbnail(stream.thumbnail_url),
      footer: { text: 'Twitch' },
      timestamp: new Date(),
    });

    return {
      notify: true,
      embed,
      stateUpdate: { twitch_is_live: 1 },
    };
  }

  if (!stream && pollerState.twitch_is_live) {
    return {
      notify: false,
      stateUpdate: { twitch_is_live: 0 },
    };
  }

  return null;
}

module.exports = { check };
