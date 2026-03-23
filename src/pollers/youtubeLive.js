const { getLatestVideos, checkLiveStatus } = require('../services/youtube');
const { buildEmbed } = require('../discord');

async function check(streamer, pollerState) {
  if (!streamer.youtube_channel_id || !streamer.youtube_api_key) return null;

  const videos = await getLatestVideos(streamer.youtube_channel_id);
  const videoIds = videos.map((v) => v.id);
  const liveVideo = await checkLiveStatus(videoIds, streamer.youtube_api_key);

  if (liveVideo && !pollerState.youtube_is_live) {
    const embed = buildEmbed({
      color: 0xff0000,
      author: { name: `${streamer.twitch_display_name || streamer.twitch_username} is live on YouTube!` },
      title: liveVideo.title,
      url: `https://www.youtube.com/watch?v=${liveVideo.id}`,
      description: liveVideo.description?.substring(0, 200) || undefined,
      image: liveVideo.thumbnail,
      footer: { text: 'YouTube Live' },
      timestamp: new Date(),
    });

    return {
      notify: true,
      embed,
      stateUpdate: { youtube_is_live: 1, youtube_live_video_id: liveVideo.id },
    };
  }

  if (!liveVideo && pollerState.youtube_is_live) {
    return {
      notify: false,
      stateUpdate: { youtube_is_live: 0, youtube_live_video_id: null },
    };
  }

  return null;
}

module.exports = { check };
