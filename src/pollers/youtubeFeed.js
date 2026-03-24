const { getLatestVideos, getVideoDetails } = require('../services/youtube');

async function check(youtubeChannelId, channelState, apiKey) {
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

  // Enrich with Shorts detection if API key is available
  let videoDetails = {};
  if (apiKey) {
    videoDetails = await getVideoDetails(newVideos.map(v => v.id), apiKey);
  }

  // Send as plain text messages so Discord auto-generates the video player
  const videoData = newVideos.map((video) => {
    const isShort = videoDetails[video.id]?.isShort || false;
    const message = isShort
      ? `📱 **${video.author || 'New'} posted a Short!** — ${video.title}\n${video.url}`
      : `🎬 **${video.author || 'New'} uploaded a new video!** — ${video.title}\n${video.url}`;
    return { message, isShort };
  });

  return {
    notify: true,
    videoData,
    stateUpdate: { known_video_ids: JSON.stringify(allIds) },
  };
}

module.exports = { check };
