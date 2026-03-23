const { getClips, getUserId } = require('../services/twitch');
const { buildEmbed } = require('../discord');

async function check(streamer, pollerState) {
  let broadcasterId = pollerState.twitch_broadcaster_id;

  if (!broadcasterId) {
    broadcasterId = await getUserId(streamer.twitch_username);
    if (!broadcasterId) return null;
    return { notify: false, stateUpdate: { twitch_broadcaster_id: broadcasterId }, clips: [] };
  }

  const since = pollerState.last_clip_created_at || new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const clips = await getClips(broadcasterId, since);

  const newClips = clips.filter(
    (clip) => !pollerState.last_clip_created_at || clip.created_at > pollerState.last_clip_created_at
  );

  if (newClips.length === 0) return null;

  const embeds = newClips.map((clip) =>
    buildEmbed({
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
    })
  );

  const newest = newClips.reduce((a, b) => (a.created_at > b.created_at ? a : b));

  return {
    notify: true,
    embeds, // multiple embeds (one per clip)
    stateUpdate: { last_clip_created_at: newest.created_at },
  };
}

module.exports = { check };
