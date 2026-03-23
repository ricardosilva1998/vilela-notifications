const { getClips, getUserId } = require('../services/twitch');
const { buildEmbed } = require('../discord');

async function check(twitchUsername, channelState) {
  let broadcasterId = channelState.twitch_broadcaster_id;

  if (!broadcasterId) {
    broadcasterId = await getUserId(twitchUsername);
    if (!broadcasterId) return null;
    return { notify: false, stateUpdate: { twitch_broadcaster_id: broadcasterId } };
  }

  const since = channelState.last_clip_created_at || new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const clips = await getClips(broadcasterId, since);

  if (clips.length > 0) {
    console.log(`[TwitchClips] ${twitchUsername}: found ${clips.length} clips since ${since}`);
  }

  const newClips = clips.filter(
    (clip) => !channelState.last_clip_created_at || clip.created_at > channelState.last_clip_created_at
  );

  if (newClips.length === 0) return null;
  console.log(`[TwitchClips] ${twitchUsername}: ${newClips.length} NEW clips to notify`);

  const clipData = newClips.map((clip) => ({
    embed: buildEmbed({
      color: 0x9146ff,
      author: { name: `New clip by ${clip.creator_name}` },
      title: clip.title,
      url: clip.url,
      fields: [
        { name: 'Views', value: String(clip.view_count), inline: true },
        { name: 'Duration', value: `${Math.round(clip.duration)}s`, inline: true },
      ],
      footer: { text: 'Twitch Clip' },
      timestamp: clip.created_at,
    }),
    clipUrl: clip.url,
  }));

  const newest = newClips.reduce((a, b) => (a.created_at > b.created_at ? a : b));

  return {
    notify: true,
    clipData,
    stateUpdate: { last_clip_created_at: newest.created_at },
  };
}

module.exports = { check };
