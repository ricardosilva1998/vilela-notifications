const config = require('../config');
const db = require('../db');
const bus = require('./overlayBus');
const { refreshYoutubeBotToken, sendYoutubeChatMessage, fetchLiveChatMessages } = require('./youtube');
const { getBuiltinResponse, getCommandsList } = require('./builtinCommands');
const { moderateYoutubeMessage, grantYoutubePermit } = require('./youtubeModeration');

let botAccessToken = null;
const activePollers = new Map(); // streamerId -> { liveChatId, pageToken, timer }
const cooldowns = new Map(); // "streamerId:command" -> timestamp

const ytChatTypeMap = { superchat: 'superchat', member: 'member', giftmember: 'giftmember' };

async function ensureBotToken() {
  if (!botAccessToken) {
    botAccessToken = await refreshYoutubeBotToken();
  }
  return botAccessToken;
}

// Refresh token every 50 minutes (tokens expire in 60 min)
setInterval(async () => {
  if (activePollers.size > 0) {
    botAccessToken = await refreshYoutubeBotToken();
    if (botAccessToken) console.log('[YT Chat] Bot token refreshed');
  }
}, 50 * 60 * 1000);

async function handleChatMessage(streamerId, item) {
  const type = item.snippet?.type;
  const authorName = item.authorDetails?.displayName || 'Unknown';

  switch (type) {
    case 'superChatEvent': {
      const details = item.snippet.superChatDetails;
      const data = {
        username: authorName,
        amount: details.amountDisplayString || `${(details.amountMicros / 1000000).toFixed(2)}`,
        message: details.userComment || '',
      };

      // Overlay
      const streamer = db.getStreamerById(streamerId);
      if (streamer?.yt_overlay_superchat_enabled) {
        bus.emit(`overlay:${streamerId}`, { type: 'yt_superchat', data });
      }

      // Chat thank-you
      if (streamer?.yt_chat_superchat_enabled && streamer.yt_chat_superchat_template) {
        sendTemplateMessage(streamerId, streamer.yt_chat_superchat_template, data);
      }
      break;
    }

    case 'newSponsorEvent': {
      const data = {
        username: authorName,
        level: item.snippet.newSponsorDetails?.memberLevelName || 'Member',
      };

      const streamer = db.getStreamerById(streamerId);
      if (streamer?.yt_overlay_member_enabled) {
        bus.emit(`overlay:${streamerId}`, { type: 'yt_member', data });
      }
      if (streamer?.yt_chat_member_enabled && streamer.yt_chat_member_template) {
        sendTemplateMessage(streamerId, streamer.yt_chat_member_template, data);
      }
      break;
    }

    case 'membershipGiftingEvent': {
      const details = item.snippet.membershipGiftingDetails;
      const data = {
        username: authorName,
        amount: details?.giftMembershipsCount || 1,
        level: details?.memberLevelName || 'Member',
      };

      const streamer = db.getStreamerById(streamerId);
      if (streamer?.yt_overlay_giftmember_enabled) {
        bus.emit(`overlay:${streamerId}`, { type: 'yt_giftmember', data });
      }
      if (streamer?.yt_chat_giftmember_enabled && streamer.yt_chat_giftmember_template) {
        sendTemplateMessage(streamerId, streamer.yt_chat_giftmember_template, data);
      }
      break;
    }

    case 'textMessageEvent': {
      const message = item.snippet.textMessageDetails?.messageText || '';
      const poller = activePollers.get(streamerId);
      if (!poller) return;

      // Run moderation before processing commands
      try {
        const token = await ensureBotToken();
        if (token) {
          const { moderated } = await moderateYoutubeMessage(streamerId, item, poller.liveChatId, token);
          if (moderated) return;
        }
      } catch (e) {
        console.error(`[YT Chat] Moderation error:`, e.message);
      }

      if (!message.startsWith('!')) return;

      const parts = message.split(' ');
      const commandName = parts[0].substring(1).toLowerCase();
      const args = parts.slice(1);
      const streamer = db.getStreamerById(streamerId);
      if (!streamer) return;

      // !permit command (moderator/owner only)
      if (commandName === 'permit') {
        const authorDetails = item.authorDetails || {};
        if (authorDetails.isChatOwner || authorDetails.isChatModerator) {
          const target = args[0]?.replace('@', '');
          if (target) {
            const permitDuration = streamer.mod_link_permit_seconds || 60;
            const granted = grantYoutubePermit(streamerId, target, permitDuration);
            if (granted) {
              const token = await ensureBotToken();
              if (token) sendYoutubeChatMessage(poller.liveChatId, `${target} can post links for ${permitDuration} seconds.`, token);
            }
          }
        }
        return;
      }

      // !song command
      if (commandName === 'song') {
        try {
          const { getCurrentlyPlaying } = require('./spotify');
          const result = await getCurrentlyPlaying(streamer);
          let msg;
          switch (result.status) {
            case 'playing': msg = `🎵 Now playing: ${result.track} by ${result.artist}`; break;
            case 'paused': msg = `⏸️ Paused: ${result.track} by ${result.artist}`; break;
            case 'nothing_playing': msg = `🔇 Nothing playing on Spotify right now`; break;
            default: msg = null;
          }
          if (msg) {
            const token = await ensureBotToken();
            if (token) sendYoutubeChatMessage(poller.liveChatId, msg, token);
          }
        } catch (e) {}
        return;
      }

      // !commands / !cmds / !help
      if (commandName === 'commands' || commandName === 'cmds' || commandName === 'help') {
        const cooldownKey = `${streamerId}:commands`;
        const now = Date.now();
        if (now - (cooldowns.get(cooldownKey) || 0) < 5000) return;
        cooldowns.set(cooldownKey, now);

        const cmds = getCommandsList(streamer, 'youtube');
        const msg = cmds.length > 0 ? `Available commands: ${cmds.join(', ')}` : 'No commands available.';
        const token = await ensureBotToken();
        if (token) sendYoutubeChatMessage(poller.liveChatId, msg, token);
        return;
      }

      // Built-in fun commands
      const builtinResult = getBuiltinResponse(commandName, args, streamer, authorName);
      if (builtinResult) {
        const token = await ensureBotToken();
        if (token) sendYoutubeChatMessage(poller.liveChatId, builtinResult.response, token);
        return;
      }

      // Custom commands
      const cooldownKey = `${streamerId}:${commandName}`;
      const now = Date.now();
      const lastUsed = cooldowns.get(cooldownKey) || 0;

      const cmd = db.getChatCommand(streamerId, commandName);
      if (!cmd) return;
      if (now - lastUsed < cmd.cooldown * 1000) return;

      cooldowns.set(cooldownKey, now);
      console.log(`[YT Chat] Command !${commandName} from ${authorName}`);

      const token = await ensureBotToken();
      if (token) sendYoutubeChatMessage(poller.liveChatId, cmd.response, token);
      break;
    }
  }
}

async function sendTemplateMessage(streamerId, template, data) {
  let message = template;
  for (const [key, value] of Object.entries(data)) {
    message = message.replace(new RegExp(`\\{${key}\\}`, 'g'), value ?? '');
  }

  const poller = activePollers.get(streamerId);
  if (!poller) return;

  const token = await ensureBotToken();
  if (token) {
    sendYoutubeChatMessage(poller.liveChatId, message, token);
  }
}

async function pollChat(streamerId) {
  const poller = activePollers.get(streamerId);
  if (!poller) return;

  try {
    const token = await ensureBotToken();
    if (!token) {
      console.error(`[YT Chat] No bot token available for streamer ${streamerId}`);
      poller.timer = setTimeout(() => pollChat(streamerId), 30000);
      return;
    }
    const data = await fetchLiveChatMessages(poller.liveChatId, poller.pageToken, token);

    if (!data) {
      console.log(`[YT Chat] Failed to fetch messages for streamer ${streamerId}, retrying...`);
      poller.timer = setTimeout(() => pollChat(streamerId), 10000);
      return;
    }

    if (data.offlineAt) {
      console.log(`[YT Chat] Chat ended for streamer ${streamerId}`);
      youtubeChatManager.stopPolling(streamerId);
      return;
    }

    poller.pageToken = data.nextPageToken;

    // Process new messages (skip first poll to avoid replaying old messages)
    if (poller.initialized) {
      for (const item of data.items || []) {
        handleChatMessage(streamerId, item);
      }
    }
    poller.initialized = true;

    const interval = data.pollingIntervalMillis || 5000;
    poller.timer = setTimeout(() => pollChat(streamerId), interval);
  } catch (err) {
    console.error(`[YT Chat] Poll error for streamer ${streamerId}:`, err.message);
    poller.timer = setTimeout(() => pollChat(streamerId), 10000);
  }
}

const youtubeChatManager = {
  startPolling(streamerId, liveChatId) {
    this.stopPolling(streamerId);

    const streamer = db.getStreamerById(streamerId);
    if (!streamer?.yt_chatbot_enabled) return;

    console.log(`[YT Chat] Starting chat polling for streamer ${streamerId} (chatId: ${liveChatId})`);
    activePollers.set(streamerId, { liveChatId, pageToken: null, timer: null, initialized: false });
    pollChat(streamerId);
  },

  stopPolling(streamerId) {
    const poller = activePollers.get(streamerId);
    if (poller) {
      if (poller.timer) clearTimeout(poller.timer);
      activePollers.delete(streamerId);
      console.log(`[YT Chat] Stopped polling for streamer ${streamerId}`);
    }
  },

  stopAll() {
    for (const [id] of activePollers) {
      this.stopPolling(id);
    }
  },

  isPolling(streamerId) {
    return activePollers.has(streamerId);
  },

  getLiveChatId(streamerId) {
    const poller = activePollers.get(streamerId);
    return poller ? poller.liveChatId : null;
  },
};

module.exports = { youtubeChatManager };
