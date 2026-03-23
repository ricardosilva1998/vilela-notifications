const { getLatestVideos } = require('../services/youtube');
const { buildEmbed } = require('../discord');

async function check(streamer, pollerState) {
  if (!streamer.youtube_channel_id) return null;

  const videos = await getLatestVideos(streamer.youtube_channel_id);
  const knownIds = JSON.parse(pollerState.known_video_ids || '[]');
  const liveVideoId = pollerState.youtube_live_video_id;

  const newVideos = videos.filter(
    (v) => !knownIds.includes(v.id) && v.id !== liveVideoId
  );

  if (newVideos.length === 0) {
    // Still update known IDs with any new entries
    const allIds = [...new Set([...knownIds, ...videos.map((v) => v.id)])].slice(-50);
    if (allIds.length !== knownIds.length) {
      return { notify: false, stateUpdate: { known_video_ids: JSON.stringify(allIds) } };
    }
    return null;
  }

  const embeds = newVideos.map((video) =>
    buildEmbed({
      color: 0xff0000,
      author: { name: `${video.author || streamer.twitch_display_name} uploaded a new video!` },
      title: video.title,
      url: video.url,
      image: `https://i.ytimg.com/vi/${video.id}/maxresdefault.jpg`,
      footer: { text: 'YouTube' },
      timestamp: video.published,
    })
  );

  const allIds = [...new Set([...knownIds, ...videos.map((v) => v.id)])].slice(-50);

  return {
    notify: true,
    embeds,
    stateUpdate: { known_video_ids: JSON.stringify(allIds) },
  };
}

module.exports = { check };
