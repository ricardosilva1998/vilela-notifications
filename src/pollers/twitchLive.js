const { getStream } = require('../services/twitch');
const { buildEmbed } = require('../discord');

function formatThumbnail(url) {
  return url.replace('{width}', '1280').replace('{height}', '720');
}

async function check(twitchUsername, channelState) {
  const stream = await getStream(twitchUsername);

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

    return { notify: true, embed, stateUpdate: { is_live: 1 } };
  }

  if (!stream && channelState.is_live) {
    return { notify: false, stateUpdate: { is_live: 0 } };
  }

  return null;
}

module.exports = { check };
