const { getLatestVideos, checkLiveStatus } = require('../services/youtube');
const { buildEmbed } = require('../discord');

async function check(youtubeChannelId, channelState, apiKey) {
  if (!apiKey) return null; // Need API key for live detection

  const videos = await getLatestVideos(youtubeChannelId);
  const videoIds = videos.map((v) => v.id);
  const liveVideo = await checkLiveStatus(videoIds, apiKey);

  if (liveVideo && !channelState.is_live) {
    const embed = buildEmbed({
      color: 0xff0000,
      author: { name: `${liveVideo.title ? '' : ''}Live on YouTube!` },
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
      stateUpdate: { is_live: 1, live_video_id: liveVideo.id },
    };
  }

  if (!liveVideo && channelState.is_live) {
    return { notify: false, stateUpdate: { is_live: 0, live_video_id: null } };
  }

  return null;
}

module.exports = { check };
