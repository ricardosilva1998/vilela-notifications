# Chatbot Shared Connection Refactor — Design Spec

## Context

The current chatbot creates one tmi.js IRC connection per streamer. This works for a handful of users but won't scale — 50+ separate connections waste resources and approach Twitch's rate limits. Refactoring to a single shared tmi.js connection that joins all enabled channels solves this.

## Goals

- Replace per-streamer tmi.js connections with a single shared connection
- The Atleta bot account connects once and joins/leaves channels as streamers enable/disable
- Move bot credentials from per-streamer DB columns to global config (env vars)
- Maintain all existing functionality: event messages, custom commands, cooldowns

## Architecture

### Before (per-streamer)
```
chatManager → Map<streamerId, TwitchChatClient>
Each TwitchChatClient → new tmi.Client → joins 1 channel
```

### After (shared)
```
chatService → single tmi.Client → joins N channels
             → channelMap: Map<channel, streamerId> (for routing)
             → cooldowns: Map<streamerId:command, timestamp>
```

## Components

### Global Bot Config

Bot credentials move to environment variables (same as other global config like TWITCH_CLIENT_ID):

- `BOT_TWITCH_USERNAME` — the bot's Twitch username (e.g., "atleta")
- `BOT_TWITCH_TOKEN` — the bot's OAuth token (with `chat:edit chat:read` scopes)

Add to `src/config.js`:
```javascript
bot: {
  twitchUsername: process.env.BOT_TWITCH_USERNAME || '',
  twitchToken: process.env.BOT_TWITCH_TOKEN || '',
},
```

### Rewritten `src/services/twitchChat.js`

Single module with no class — just a shared connection and exported functions:

- `connect()` — creates the single tmi.js client, connects, joins all enabled channels
- `disconnect()` — disconnects the client
- `joinChannel(streamerId, channel)` — joins a channel, maps it to the streamer
- `partChannel(channel)` — leaves a channel, removes mapping
- `sendMessage(channel, message)` — sends a message to a specific channel
- `sendEventMessage(streamerId, eventType, data)` — formats a template and sends to the streamer's channel

**Message handler:** On incoming `!command`, look up the channel → streamer mapping, then look up the command in the DB for that streamer. Respect per-command cooldowns.

**Channel mapping:** A `Map<channelName, streamerId>` maps incoming messages to the right streamer for command lookup and event message formatting.

### Dashboard Changes

**Remove per-streamer bot OAuth flow.** The bot is now a global service — streamers don't connect their own bot account. Instead:

- Remove the "Connect Bot Account" section from the chatbot config page
- Remove `/auth/bot` and `/auth/bot/callback` routes
- Remove `bot_access_token`, `bot_refresh_token`, `bot_token_expires_at`, `bot_username` columns (or just stop using them)
- The Connection tab just shows: "Bot: Atleta" with status (connected/disconnected) and the channel the bot will join

**Chatbot enable/disable** still works per-streamer — toggling it calls `joinChannel` or `partChannel`.

### Startup

On server boot:
1. If `BOT_TWITCH_USERNAME` and `BOT_TWITCH_TOKEN` are set, connect the shared client
2. Query all streamers with `chatbot_enabled = 1` and a `twitch_username`
3. Join all their channels

### Twitch Limits

- Unverified bot: ~200 channels, 20 joins per 10 seconds
- Verified bot: 2000 channels, 2000 joins per 10 seconds
- Rate-limit joins by queuing them with a small delay between each

## Database Changes

- No new columns needed
- Existing `bot_access_token`, `bot_refresh_token`, etc. become unused (can be left for now, no need to drop columns)
- `chatbot_enabled` and `twitch_username` remain the key fields for determining which channels to join

## Environment Variables

New:
- `BOT_TWITCH_USERNAME` — required for chatbot to function
- `BOT_TWITCH_TOKEN` — required, OAuth token with `chat:edit chat:read`

## Files Changed

- `src/config.js` — add `bot` config section
- `src/services/twitchChat.js` — full rewrite to shared connection model
- `src/routes/dashboard.js` — update chatbot enable/disable to call join/part
- `src/views/chatbot-config.ejs` — update Connection tab (remove bot OAuth, show global bot status)
- `src/routes/auth.js` — remove `/auth/bot` and `/auth/bot/callback` routes
- `src/index.js` — update startup to use new chatService.connect()

## Verification

1. Set `BOT_TWITCH_USERNAME` and `BOT_TWITCH_TOKEN` env vars
2. Start server — bot connects and joins channels of all enabled streamers
3. Type `!test` in a streamer's chat — bot responds
4. Enable chatbot for a new streamer — bot joins their channel
5. Disable chatbot — bot leaves the channel
6. Multiple streamers with different commands — commands route to the correct streamer
