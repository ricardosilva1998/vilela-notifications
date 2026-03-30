# Chatbot Shared Connection Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the Twitch chatbot from per-streamer tmi.js connections to a single shared connection that joins all enabled channels.

**Architecture:** One tmi.js client connects as the Atleta bot (credentials from env vars), joins/leaves channels as streamers enable/disable. A channel→streamer map routes incoming commands. The `chatManager` API (`sendEventMessage`, `joinChannel`, `partChannel`) stays compatible so eventsub.js and streamelements.js need minimal changes.

**Tech Stack:** Existing — tmi.js (already installed), Node.js, SQLite

**Spec:** `docs/superpowers/specs/2026-03-26-chatbot-shared-connection-design.md`

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/config.js` | Modify | Add `bot` config section (env vars) |
| `src/services/twitchChat.js` | Rewrite | Shared single-connection model |
| `src/routes/dashboard.js` | Modify | Update chatbot enable/disable to use joinChannel/partChannel |
| `src/routes/auth.js` | Modify | Remove `/auth/bot` and `/auth/bot/callback` routes |
| `src/views/chatbot-config.ejs` | Modify | Update Connection tab — remove bot OAuth, show global bot status |
| `src/index.js` | Modify | Update startup to use new chatService |
| `.env.example` | Modify | Add BOT_TWITCH_USERNAME and BOT_TWITCH_TOKEN |

---

## Task 1: Add Bot Config to config.js and .env.example

**Files:**
- Modify: `src/config.js`
- Modify: `.env.example`

- [ ] **Step 1: Add bot config section to config.js**

In `src/config.js`, add after the `twitch` section in the exports:

```javascript
bot: {
  twitchUsername: process.env.BOT_TWITCH_USERNAME || '',
  twitchToken: process.env.BOT_TWITCH_TOKEN || '',
},
```

- [ ] **Step 2: Add to .env.example**

Append to `.env.example`:

```
# Chatbot (Atleta)
BOT_TWITCH_USERNAME=atleta
BOT_TWITCH_TOKEN=oauth:your_bot_token_here
```

- [ ] **Step 3: Commit**

```bash
git add src/config.js .env.example
git commit -m "feat: add global bot config for shared chatbot connection"
```

---

## Task 2: Rewrite twitchChat.js — Shared Connection

**Files:**
- Rewrite: `src/services/twitchChat.js`

Replace the entire file with a shared single-connection model. The exported API must stay compatible — `chatManager.sendEventMessage(streamerId, eventType, data)` is called by eventsub.js and streamelements.js.

- [ ] **Step 1: Rewrite twitchChat.js**

Replace `src/services/twitchChat.js` with:

```javascript
const tmi = require('tmi.js');
const config = require('../config');
const db = require('../db');

let client = null;
const channelMap = new Map(); // channelName -> streamerId
const cooldowns = new Map(); // "streamerId:command" -> timestamp

const chatTypeMap = { subscription: 'sub', follow: 'follow', giftsub: 'giftsub', bits: 'bits', donation: 'donation', raid: 'raid' };

function getStreamerIdForChannel(channel) {
  // tmi.js channels are lowercase with # prefix
  const clean = channel.replace(/^#/, '').toLowerCase();
  return channelMap.get(clean);
}

function handleMessage(channel, tags, message, self) {
  if (self) return;
  if (!message.startsWith('!')) return;

  const commandName = message.split(' ')[0].substring(1).toLowerCase();
  const streamerId = getStreamerIdForChannel(channel);
  if (!streamerId) return;

  console.log(`[Chat] Command received: !${commandName} from ${tags.username} in ${channel}`);

  const cmd = db.getChatCommand(streamerId, commandName);
  if (!cmd) return;

  // Check cooldown
  const cooldownKey = `${streamerId}:${commandName}`;
  const now = Date.now();
  const lastUsed = cooldowns.get(cooldownKey) || 0;
  if (now - lastUsed < cmd.cooldown * 1000) return;

  cooldowns.set(cooldownKey, now);
  console.log(`[Chat] Sending response for !${commandName} in ${channel}`);
  client.say(channel, cmd.response).catch((err) => {
    console.error(`[Chat] Failed to send !${commandName} response:`, err.message);
  });
}

const chatManager = {
  connect() {
    const { twitchUsername, twitchToken } = config.bot;
    if (!twitchUsername || !twitchToken) {
      console.log('[Chat] Bot not configured (BOT_TWITCH_USERNAME / BOT_TWITCH_TOKEN not set)');
      return;
    }

    console.log(`[Chat] Connecting as ${twitchUsername}...`);

    client = new tmi.Client({
      options: { debug: false },
      connection: { reconnect: true, secure: true },
      identity: {
        username: twitchUsername,
        password: twitchToken.startsWith('oauth:') ? twitchToken : `oauth:${twitchToken}`,
      },
      channels: [], // Join channels after connecting
    });

    client.on('connected', () => {
      console.log(`[Chat] Bot connected as ${twitchUsername}`);

      // Join all enabled channels
      const streamers = db.getChatbotEnabledStreamers();
      let joinDelay = 0;
      for (const s of streamers) {
        if (s.twitch_username) {
          setTimeout(() => {
            this.joinChannel(s.id, s.twitch_username);
          }, joinDelay);
          joinDelay += 500; // Rate limit: 2 joins per second
        }
      }
      console.log(`[Chat] Queued ${streamers.length} channel joins`);
    });

    client.on('disconnected', (reason) => {
      console.log(`[Chat] Bot disconnected: ${reason}`);
    });

    client.on('join', (channel, username, self) => {
      if (self) console.log(`[Chat] Joined ${channel}`);
    });

    client.on('part', (channel, username, self) => {
      if (self) console.log(`[Chat] Left ${channel}`);
    });

    client.on('message', handleMessage);

    client.connect().catch((err) => {
      console.error(`[Chat] Failed to connect:`, err.message);
    });
  },

  disconnect() {
    if (client) {
      client.disconnect().catch(() => {});
      client = null;
    }
    channelMap.clear();
    cooldowns.clear();
  },

  joinChannel(streamerId, channel) {
    if (!client) return;
    const clean = channel.toLowerCase();
    channelMap.set(clean, streamerId);
    client.join(clean).catch((err) => {
      console.error(`[Chat] Failed to join #${clean}:`, err.message);
    });
  },

  partChannel(channel) {
    if (!client) return;
    const clean = channel.toLowerCase();
    channelMap.delete(clean);
    client.part(clean).catch((err) => {
      console.error(`[Chat] Failed to leave #${clean}:`, err.message);
    });
  },

  isConnected() {
    return client !== null && client.readyState() === 'OPEN';
  },

  getJoinedChannels() {
    return Array.from(channelMap.keys());
  },

  // Called by EventSub/StreamElements when an event occurs
  sendEventMessage(streamerId, eventType, data) {
    if (!client) return;

    const streamer = db.getStreamerById(streamerId);
    if (!streamer || !streamer.chatbot_enabled || !streamer.twitch_username) return;

    const mappedType = chatTypeMap[eventType] || eventType;

    // Check if this event type is enabled
    const enabledKey = `chat_${mappedType}_enabled`;
    if (!streamer[enabledKey]) return;

    // Get template
    const templateKey = `chat_${mappedType}_template`;
    const template = streamer[templateKey];
    if (!template) return;

    // Replace variables
    let message = template;
    for (const [key, value] of Object.entries(data)) {
      message = message.replace(new RegExp(`\\{${key}\\}`, 'g'), value ?? '');
    }

    client.say(streamer.twitch_username, message).catch((err) => {
      console.error(`[Chat] Failed to send event message for streamer ${streamerId}:`, err.message);
    });
  },

  // Backward-compatible aliases
  startAll() { this.connect(); },
  startForStreamer(streamerId) {
    const streamer = db.getStreamerById(streamerId);
    if (streamer && streamer.twitch_username) {
      this.joinChannel(streamerId, streamer.twitch_username);
    }
  },
  stopForStreamer(streamerId) {
    const streamer = db.getStreamerById(streamerId);
    if (streamer && streamer.twitch_username) {
      this.partChannel(streamer.twitch_username);
    }
  },
  stopAll() { this.disconnect(); },
};

module.exports = { chatManager };
```

**Key changes from the old file:**
- No more `TwitchChatClient` class — single shared `client`
- `channelMap` maps channel names to streamer IDs for routing
- Cooldowns keyed by `streamerId:command` to avoid cross-channel conflicts
- Rate-limited channel joins (500ms delay between each)
- `startAll`/`startForStreamer`/`stopForStreamer`/`stopAll` kept as backward-compatible aliases so eventsub.js, streamelements.js, and dashboard.js don't need API changes

- [ ] **Step 2: Commit**

```bash
git add src/services/twitchChat.js
git commit -m "refactor: rewrite chatbot to use single shared tmi.js connection"
```

---

## Task 3: Update Startup in index.js

**Files:**
- Modify: `src/index.js`

The startup call `chatManager.startAll()` already works via the backward-compatible alias, but we should also pass through `connect()` directly for clarity.

- [ ] **Step 1: Read and verify startup code**

Read `src/index.js` and check lines 32-33. The existing `chatManager.startAll()` call will work because the new module exports the same API. No code change needed — just verify.

```bash
cd /Users/ricardosilva/vilela-notifications
grep -n "chatManager" src/index.js
```

Expected: `chatManager.startAll()` — this calls `connect()` via the alias. No change needed.

- [ ] **Step 2: No commit needed** (no changes)

---

## Task 4: Update Dashboard Routes

**Files:**
- Modify: `src/routes/dashboard.js`

The dashboard's chatbot enable/disable handler calls `chatManager.startForStreamer` / `stopForStreamer` which now maps to `joinChannel` / `partChannel` via backward-compatible aliases. No code change needed for the route logic.

However, we should pass the bot connection status to the chatbot page.

- [ ] **Step 1: Update GET /chatbot route to pass bot status**

In `src/routes/dashboard.js`, find the `GET /chatbot` route and update it to pass bot connection info:

```javascript
router.get('/chatbot', (req, res) => {
  const streamer = req.streamer;
  const commands = db.getChatCommands(req.streamer.id);
  let botConnected = false;
  let botUsername = '';
  try {
    const { chatManager } = require('../services/twitchChat');
    botConnected = chatManager.isConnected();
    botUsername = require('../config').bot.twitchUsername;
  } catch (e) {}
  res.render('chatbot-config', { streamer, commands, botConnected, botUsername });
});
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/dashboard.js
git commit -m "feat: pass global bot connection status to chatbot dashboard"
```

---

## Task 5: Update Chatbot Config Template — Connection Tab

**Files:**
- Modify: `src/views/chatbot-config.ejs`

Replace the per-streamer bot OAuth section with a global bot status display.

- [ ] **Step 1: Read the current chatbot-config.ejs**

Read `src/views/chatbot-config.ejs` to understand the current Connection tab structure.

- [ ] **Step 2: Replace the Connection tab content**

Replace the content inside `<div class="tab-content" id="tab-connection">` with:

- Remove the "Connect Bot Account" button and per-streamer bot OAuth flow
- Remove bot_linked/bot_error success/error banners
- Show instead:
  - If `botConnected` and `botUsername`: green status "Bot **{botUsername}** is online" + which channel it will join (`streamer.twitch_username`)
  - If not connected: warning "Bot is not connected. Ask the admin to configure BOT_TWITCH_USERNAME and BOT_TWITCH_TOKEN environment variables."
  - If `streamer.twitch_username` is not set: warning "Link your Twitch account first" with link to `/auth/twitch`
- Keep the chatbot enable/disable toggle and its Save form

- [ ] **Step 3: Commit**

```bash
git add src/views/chatbot-config.ejs
git commit -m "feat: update chatbot Connection tab for global shared bot"
```

---

## Task 6: Remove Bot OAuth Routes

**Files:**
- Modify: `src/routes/auth.js`

Remove the `/bot` and `/bot/callback` routes since the bot is now globally configured.

- [ ] **Step 1: Remove bot OAuth routes from auth.js**

Read `src/routes/auth.js` and remove the `// --- Bot account OAuth ---` section (the `GET /bot` and `GET /bot/callback` routes). These are around lines 197-260.

- [ ] **Step 2: Commit**

```bash
git add src/routes/auth.js
git commit -m "refactor: remove per-streamer bot OAuth routes (bot is now global)"
```

---

## Task 7: Set Environment Variables on Railway + Verify

- [ ] **Step 1: Update .env.example if not already done**

Verify `.env.example` has the bot env vars from Task 1.

- [ ] **Step 2: Remind user to set env vars on Railway**

The user needs to set these on Railway:
- `BOT_TWITCH_USERNAME` — the bot's Twitch login name
- `BOT_TWITCH_TOKEN` — the bot's OAuth token (with `oauth:` prefix or without, both work)

- [ ] **Step 3: Push and verify**

```bash
git push origin main
```

After Railway deploys:
1. Check logs for `[Chat] Bot connected as atleta`
2. Check logs for `[Chat] Joined #ricardobsilva98`
3. Type `!test` in chat — bot should respond
4. Enable chatbot for a second streamer — bot should join their channel too

---

## Verification Checklist

1. Server starts, bot connects with env var credentials
2. Bot auto-joins channels of all chatbot-enabled streamers
3. `!commands` work and route to the correct streamer
4. Event messages (follow, sub, bits, donation, raid) send to the correct channel
5. Enabling chatbot on dashboard → bot joins that channel
6. Disabling chatbot → bot leaves that channel
7. Dashboard Connection tab shows bot status correctly
