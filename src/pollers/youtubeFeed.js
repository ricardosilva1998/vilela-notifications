const { getLatestVideos } = require('../services/youtube');
const { buildEmbed } = require('../discord');

async function check(youtubeChannelId, channelState) {
  const videos = await getLatestVideos(youtubeChannelId);
  const knownIds = JSON.parse(channelState.known_video_ids || '[]');
  const liveVideoId = channelState.live_video_id;

  const newVideos = videos.filter(
    (v) => !knownIds.includes(v.id) && v.id !== liveVideoId
  );

  const allIds = [...new Set([...knownIds, ...videos.map((v) => v.id)])].slice(-50);

  if (newVideos.length === 0) {
    if (allIds.length !== knownIds.length) {
      return { notify: false, stateUpdate: { known_video_ids: JSON.stringify(allIds) } };
    }
    return null;
  }

  const embeds = newVideos.map((video) =>
    buildEmbed({
      color: 0xff0000,
      author: { name: `${video.author || 'New'} uploaded a new video!` },
      title: video.title,
      url: video.url,
      image: `https://i.ytimg.com/vi/${video.id}/maxresdefault.jpg`,
      footer: { text: 'YouTube' },
      timestamp: video.published,
    })
  );

  return {
    notify: true,
    embeds,
    stateUpdate: { known_video_ids: JSON.stringify(allIds) },
  };
}

module.exports = { check };
