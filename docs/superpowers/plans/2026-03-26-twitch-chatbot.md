# Twitch Chatbot (Atleta) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Twitch chatbot ("Atleta") that sends customizable thank-you messages for follows, subs, bits, donations, and raids, plus handles custom chat commands — all integrated into the existing vilela-notifications project.

**Architecture:** tmi.js connects to Twitch IRC as the bot account. The existing EventSub service (extended with raids and gift sub distinction) triggers both overlay banners and chat messages. Custom commands are stored in SQLite and served from tmi.js's message handler. All configuration is managed from the dashboard.

**Tech Stack:** Existing (Node.js, Express, SQLite, EJS) + `tmi.js@1.8.5` (Twitch IRC client)

**Spec:** `docs/superpowers/specs/2026-03-26-twitch-chatbot-design.md`

---

## File Map

### New Files

| File | Purpose |
|------|---------|
| `src/services/twitchChat.js` | tmi.js chat client + manager (per-streamer), command handler, message sending |

### Modified Files

| File | Changes |
|------|---------|
| `src/db.js` | New migration (chatbot columns on streamers + chat_commands table), new query functions |
| `src/services/twitch.js` | Add `refreshBotToken()` function |
| `src/services/eventsub.js` | Add `channel.raid`, change `channel.subscription.gift` to normalize as `giftsub`, emit to chat service |
| `src/services/streamelements.js` | Emit to chat service for donations |
| `src/routes/auth.js` | Add bot account OAuth flow (`/auth/bot`, `/auth/bot/callback`) |
| `src/routes/dashboard.js` | Add chatbot config + commands routes |
| `src/views/chatbot-config.ejs` | Dashboard page for chatbot settings and message templates |
| `src/views/chatbot-commands.ejs` | Dashboard page for custom chat commands CRUD |
| `src/views/header.ejs` | Add "Chatbot" navigation link |
| `src/index.js` | Start chat manager on boot |
| `public/overlay/overlay.css` | Add raid banner styles |
| `public/overlay/overlay.js` | Add raid banner rendering |
| `package.json` | Add tmi.js dependency |

---

## Task 1: Install tmi.js

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install tmi.js**

```bash
cd /Users/ricardosilva/vilela-notifications
npm install tmi.js@1.8.5
```

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add tmi.js for Twitch chatbot"
```

---

## Task 2: Database Migration — Chatbot Columns + Commands Table

**Files:**
- Modify: `src/db.js`

Add chatbot columns to `streamers` table and create the `chat_commands` table.

- [ ] **Step 1: Add migration**

In `src/db.js`, after the overlay migration block, add:

```javascript
// Migration: Add chatbot columns to streamers
{
  const cols = db.pragma('table_info(streamers)').map(c => c.name);
  if (!cols.includes('bot_access_token')) {
    db.exec(`
      ALTER TABLE streamers ADD COLUMN bot_access_token TEXT;
      ALTER TABLE streamers ADD COLUMN bot_refresh_token TEXT;
      ALTER TABLE streamers ADD COLUMN bot_token_expires_at INTEGER;
      ALTER TABLE streamers ADD COLUMN bot_username TEXT;
      ALTER TABLE streamers ADD COLUMN chatbot_enabled INTEGER DEFAULT 0;
      ALTER TABLE streamers ADD COLUMN chat_follow_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN chat_sub_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN chat_giftsub_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN chat_bits_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN chat_donation_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN chat_raid_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN chat_follow_template TEXT DEFAULT 'Welcome to the pit crew, {username}! 🏎️';
      ALTER TABLE streamers ADD COLUMN chat_sub_template TEXT DEFAULT '{username} just joined the podium! Tier {tier} for {months} months! 🏆';
      ALTER TABLE streamers ADD COLUMN chat_giftsub_template TEXT DEFAULT '{username} gifted {amount} subs! What a sponsor! 🎁';
      ALTER TABLE streamers ADD COLUMN chat_bits_template TEXT DEFAULT '{username} fueled up {amount} bits! 🔥';
      ALTER TABLE streamers ADD COLUMN chat_donation_template TEXT DEFAULT '{username} sponsored the team with {amount}! 💰';
      ALTER TABLE streamers ADD COLUMN chat_raid_template TEXT DEFAULT '{username} is raiding with {viewers} viewers! Welcome racers! 🏁';
    `);
    console.log('[DB] Added chatbot columns to streamers');
  }
}

// Migration: Create chat_commands table
{
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      streamer_id INTEGER NOT NULL,
      command TEXT NOT NULL,
      response TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      cooldown INTEGER DEFAULT 5,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (streamer_id) REFERENCES streamers(id),
      UNIQUE(streamer_id, command)
    )
  `);
}
```

- [ ] **Step 2: Add query functions**

Add these functions and add ALL of them to the `module.exports` block at the bottom of db.js: `updateBotTokens`, `getChatbotEnabledStreamers`, `getChatCommands`, `getChatCommand`, `addChatCommand`, `updateChatCommand`, `deleteChatCommand`, `updateChatbotConfig`.

```javascript
function updateBotTokens(streamerId, accessToken, refreshToken, expiresAt, username) {
  db.prepare(`
    UPDATE streamers SET bot_access_token = ?, bot_refresh_token = ?, bot_token_expires_at = ?, bot_username = ?
    WHERE id = ?
  `).run(accessToken, refreshToken, expiresAt, username, streamerId);
}

function getChatbotEnabledStreamers() {
  return db.prepare(`
    SELECT * FROM streamers
    WHERE chatbot_enabled = 1
    AND bot_access_token IS NOT NULL
    AND bot_access_token != ''
    AND twitch_username IS NOT NULL
  `).all();
}

function getChatCommands(streamerId) {
  return db.prepare('SELECT * FROM chat_commands WHERE streamer_id = ? ORDER BY command').all(streamerId);
}

function getChatCommand(streamerId, command) {
  return db.prepare('SELECT * FROM chat_commands WHERE streamer_id = ? AND command = ? AND enabled = 1').get(streamerId, command);
}

function addChatCommand(streamerId, command, response, cooldown) {
  return db.prepare('INSERT INTO chat_commands (streamer_id, command, response, cooldown) VALUES (?, ?, ?, ?)').run(streamerId, command, response, cooldown || 5);
}

function updateChatCommand(id, streamerId, command, response, enabled, cooldown) {
  db.prepare('UPDATE chat_commands SET command = ?, response = ?, enabled = ?, cooldown = ? WHERE id = ? AND streamer_id = ?')
    .run(command, response, enabled, cooldown, id, streamerId);
}

function deleteChatCommand(id, streamerId) {
  db.prepare('DELETE FROM chat_commands WHERE id = ? AND streamer_id = ?').run(id, streamerId);
}

// Add CHATBOT_COLUMNS whitelist for updateChatbotConfig (same pattern as overlay)
const CHATBOT_COLUMNS = new Set([
  'chatbot_enabled',
  'chat_follow_enabled', 'chat_sub_enabled', 'chat_giftsub_enabled',
  'chat_bits_enabled', 'chat_donation_enabled', 'chat_raid_enabled',
  'chat_follow_template', 'chat_sub_template', 'chat_giftsub_template',
  'chat_bits_template', 'chat_donation_template', 'chat_raid_template',
]);

function updateChatbotConfig(streamerId, config) {
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(config)) {
    if (!CHATBOT_COLUMNS.has(key)) continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (fields.length === 0) return;
  values.push(streamerId);
  db.prepare(`UPDATE streamers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}
```

- [ ] **Step 3: Test migration**

```bash
node -e "require('./src/db'); console.log('Migration OK');"
```

- [ ] **Step 4: Commit**

```bash
git add src/db.js
git commit -m "feat: add chatbot database migration and query functions"
```

---

## Task 3: Bot Account OAuth + Token Refresh

**Files:**
- Modify: `src/routes/auth.js`
- Modify: `src/services/twitch.js`

Add a new OAuth flow for the bot account and a bot token refresh function.

- [ ] **Step 1: Add bot OAuth routes to auth.js**

Read `src/routes/auth.js` and find the existing broadcaster auth routes (around line 148). Add similar routes for the bot account after them:

```javascript
// --- Bot account OAuth ---
router.get('/bot', (req, res) => {
  if (!req.streamer) return res.redirect('/auth/login');
  const streamerId = req.streamer.id;
  const redirectUri = `${config.app.url}/auth/bot/callback`;
  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'chat:edit chat:read',
    state: String(streamerId),
  });
  res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
});

router.get('/bot/callback', async (req, res) => {
  const { code, state: streamerId } = req.query;
  if (!code || !streamerId) return res.status(400).send('Missing parameters');

  try {
    const redirectUri = `${config.app.url}/auth/bot/callback`;
    const params = new URLSearchParams({
      client_id: config.twitch.clientId,
      client_secret: config.twitch.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });

    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      body: params,
    });
    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
    const tokenData = await tokenRes.json();

    // Get bot user info
    const userRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'Client-Id': config.twitch.clientId,
      },
    });
    if (!userRes.ok) throw new Error('Failed to get bot user info');
    const userData = await userRes.json();
    const botUser = userData.data[0];

    db.updateBotTokens(
      parseInt(streamerId),
      tokenData.access_token,
      tokenData.refresh_token,
      Date.now() + tokenData.expires_in * 1000 - 60_000,
      botUser.login
    );

    // Redirect back to chatbot config with success
    res.redirect('/dashboard/chatbot?bot_linked=1');
  } catch (err) {
    console.error('[Auth] Bot OAuth error:', err);
    res.redirect('/dashboard/chatbot?bot_error=' + encodeURIComponent(err.message));
  }
});
```

NOTE: Check what `link-result.ejs` expects — read it to make sure the variables match. It may use different property names.

- [ ] **Step 2: Add `refreshBotToken` to twitch.js**

Add to `src/services/twitch.js`:

```javascript
async function refreshBotToken(streamer) {
  if (!streamer.bot_refresh_token) throw new Error('No bot refresh token');

  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    client_secret: config.twitch.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: streamer.bot_refresh_token,
  });

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    body: params,
  });

  if (!res.ok) throw new Error(`Bot token refresh failed: ${res.status}`);

  const data = await res.json();
  db.updateBotTokens(
    streamer.id,
    data.access_token,
    data.refresh_token,
    Date.now() + data.expires_in * 1000 - 60_000,
    streamer.bot_username
  );

  return data.access_token;
}
```

Export it alongside `refreshBroadcasterToken`.

- [ ] **Step 3: Commit**

```bash
git add src/routes/auth.js src/services/twitch.js
git commit -m "feat: add bot account OAuth flow and token refresh"
```

---

## Task 4: Twitch Chat Service

**Files:**
- Create: `src/services/twitchChat.js`

The chat service manages per-streamer tmi.js connections. It sends formatted thank-you messages and handles custom commands.

- [ ] **Step 1: Write twitchChat.js**

Create `src/services/twitchChat.js`:

```javascript
const tmi = require('tmi.js');
const db = require('../db');
const { refreshBotToken } = require('./twitch');

class TwitchChatClient {
  constructor(streamerId) {
    this.streamerId = streamerId;
    this.client = null;
    this.running = false;
    this.cooldowns = new Map(); // command -> last used timestamp
  }

  async connect() {
    let streamer = db.getStreamerById(this.streamerId);
    if (!streamer || !streamer.bot_access_token || !streamer.twitch_username) {
      console.log(`[Chat] Streamer ${this.streamerId}: bot not configured, skipping`);
      return;
    }

    // Refresh token if expired
    let token = streamer.bot_access_token;
    if (streamer.bot_token_expires_at && Date.now() >= streamer.bot_token_expires_at) {
      try {
        token = await refreshBotToken(streamer);
        streamer = db.getStreamerById(this.streamerId);
      } catch (err) {
        console.error(`[Chat] Bot token refresh failed for streamer ${this.streamerId}:`, err.message);
        return;
      }
    }

    this.running = true;
    const channel = streamer.twitch_username;

    console.log(`[Chat] Connecting bot to #${channel}...`);

    this.client = new tmi.Client({
      options: { debug: false },
      connection: { reconnect: true, secure: true },
      identity: {
        username: streamer.bot_username,
        password: `oauth:${token}`,
      },
      channels: [channel],
    });

    this.client.on('connected', () => {
      console.log(`[Chat] Bot connected to #${channel}`);
    });

    this.client.on('disconnected', (reason) => {
      console.log(`[Chat] Bot disconnected from #${channel}: ${reason}`);
    });

    // Handle chat commands
    this.client.on('message', (ch, tags, message, self) => {
      if (self) return;
      if (!message.startsWith('!')) return;

      const commandName = message.split(' ')[0].substring(1).toLowerCase();
      this.handleCommand(ch, commandName, tags);
    });

    this.client.connect().catch((err) => {
      console.error(`[Chat] Failed to connect bot to #${channel}:`, err.message);
    });
  }

  handleCommand(channel, commandName, tags) {
    const cmd = db.getChatCommand(this.streamerId, commandName);
    if (!cmd) return;

    // Check cooldown
    const now = Date.now();
    const lastUsed = this.cooldowns.get(commandName) || 0;
    if (now - lastUsed < cmd.cooldown * 1000) return;

    this.cooldowns.set(commandName, now);
    this.client.say(channel, cmd.response).catch(() => {});
  }

  sendMessage(message) {
    if (!this.client) return;
    const streamer = db.getStreamerById(this.streamerId);
    if (!streamer || !streamer.twitch_username) return;

    this.client.say(streamer.twitch_username, message).catch((err) => {
      console.error(`[Chat] Failed to send message for streamer ${this.streamerId}:`, err.message);
    });
  }

  sendEventMessage(eventType, data) {
    const streamer = db.getStreamerById(this.streamerId);
    if (!streamer || !streamer.chatbot_enabled) return;

    // Check if this event type is enabled
    const enabledKey = `chat_${eventType}_enabled`;
    if (!streamer[enabledKey]) return;

    // Get template
    const templateKey = `chat_${eventType}_template`;
    const template = streamer[templateKey];
    if (!template) return;

    // Replace variables
    let message = template;
    for (const [key, value] of Object.entries(data)) {
      message = message.replace(new RegExp(`\\{${key}\\}`, 'g'), value ?? '');
    }

    this.sendMessage(message);
  }

  disconnect() {
    this.running = false;
    if (this.client) {
      this.client.disconnect().catch(() => {});
      this.client = null;
    }
  }
}

const clients = new Map();

const chatManager = {
  startAll() {
    const streamers = db.getChatbotEnabledStreamers();
    for (const s of streamers) {
      this.startForStreamer(s.id);
    }
    console.log(`[Chat] Started ${streamers.length} bot connections`);
  },

  startForStreamer(streamerId) {
    this.stopForStreamer(streamerId);
    const client = new TwitchChatClient(streamerId);
    clients.set(streamerId, client);
    client.connect();
  },

  stopForStreamer(streamerId) {
    const client = clients.get(streamerId);
    if (client) {
      client.disconnect();
      clients.delete(streamerId);
    }
  },

  stopAll() {
    for (const [id, client] of clients) {
      client.disconnect();
    }
    clients.clear();
  },

  // Called by EventSub/StreamElements when an event occurs
  sendEventMessage(streamerId, eventType, data) {
    const client = clients.get(streamerId);
    if (client) {
      client.sendEventMessage(eventType, data);
    }
  },
};

module.exports = { chatManager };
```

- [ ] **Step 2: Commit**

```bash
git add src/services/twitchChat.js
git commit -m "feat: add Twitch chat service with tmi.js for bot messages and commands"
```

---

## Task 5: Modify EventSub — Add Raids, Gift Sub Distinction, Chat Integration

**Files:**
- Modify: `src/services/eventsub.js`

Three changes: add `channel.raid` subscription, normalize `channel.subscription.gift` as `giftsub` type, and emit events to the chat service.

- [ ] **Step 1: Add raid to SUBSCRIPTION_TYPES**

In `src/services/eventsub.js`, add to the `SUBSCRIPTION_TYPES` array:

```javascript
{ type: 'channel.raid', version: '1', conditionKey: 'to_broadcaster_user_id' },
```

Note: `channel.raid` uses `to_broadcaster_user_id` instead of `broadcaster_user_id` in the condition. Update `createSubscription` to handle this — check for `subType.conditionKey` and use it if present, otherwise default to `broadcaster_user_id`.

- [ ] **Step 2: Update createSubscription for raid condition**

Change the condition building in `createSubscription`:

```javascript
const conditionKey = subType.conditionKey || 'broadcaster_user_id';
const condition = { [conditionKey]: streamer.twitch_user_id };
if (subType.needsModerator) {
  condition.moderator_user_id = streamer.twitch_user_id;
}
```

- [ ] **Step 3: Change gift sub normalization**

In `normalizeEvent`, change `channel.subscription.gift` to return `type: 'giftsub'`:

```javascript
case 'channel.subscription.gift':
  return {
    type: 'giftsub',
    data: {
      username: event.is_anonymous ? 'Anonymous' : event.user_name,
      tier: event.tier === '1000' ? '1' : event.tier === '2000' ? '2' : '3',
      amount: event.total,
      message: `Gifted ${event.total} sub${event.total > 1 ? 's' : ''}!`,
    },
  };
```

- [ ] **Step 4: Add raid normalization**

In `normalizeEvent`, add a case for `channel.raid`:

```javascript
case 'channel.raid':
  return {
    type: 'raid',
    data: {
      username: event.from_broadcaster_user_name,
      viewers: event.viewers,
    },
  };
```

- [ ] **Step 5: Update notification handler to emit to chat**

In the `notification` case of `handleMessage`, after emitting to the overlay bus, also emit to the chat service. Add `const { chatManager } = require('./twitchChat');` at the top.

Update the notification handler:

```javascript
case 'notification': {
  const subType = msg.metadata.subscription_type;
  const event = msg.payload.event;
  this.resetKeepalive(10);

  const normalized = this.normalizeEvent(subType, event);
  if (normalized) {
    const streamer = db.getStreamerById(this.streamerId);

    // Emit to overlay — giftsub shows as subscription banner
    const overlayType = normalized.type === 'giftsub' ? 'subscription' : normalized.type;
    const typeMap = { follow: 'follow', subscription: 'sub', giftsub: 'sub', bits: 'bits', donation: 'donation', raid: 'raid' };
    const enabledKey = `overlay_${typeMap[overlayType] || overlayType}_enabled`;
    if (streamer && streamer[enabledKey]) {
      bus.emit(`overlay:${this.streamerId}`, { ...normalized, type: overlayType });
    }

    // Emit to chat service
    chatManager.sendEventMessage(this.streamerId, normalized.type, normalized.data);
  }
  break;
}
```

- [ ] **Step 6: Add overlay raid columns to database**

The overlay needs `overlay_raid_enabled` and `overlay_raid_duration` columns. Add a new migration block to `src/db.js` (after the chatbot migration from Task 2):

```javascript
// Migration: Add overlay raid columns
{
  const cols = db.pragma('table_info(streamers)').map(c => c.name);
  if (!cols.includes('overlay_raid_enabled')) {
    db.exec(`
      ALTER TABLE streamers ADD COLUMN overlay_raid_enabled INTEGER DEFAULT 1;
      ALTER TABLE streamers ADD COLUMN overlay_raid_duration INTEGER DEFAULT 7;
    `);
    console.log('[DB] Added overlay raid columns');
  }
}
```

Also add `'overlay_raid_enabled'` and `'overlay_raid_duration'` to the `OVERLAY_COLUMNS` Set in db.js.

- [ ] **Step 7: Commit**

```bash
git add src/services/eventsub.js src/db.js
git commit -m "feat: add raid support, gift sub distinction, and chat integration to EventSub"
```

---

## Task 6: Update StreamElements to Emit to Chat

**Files:**
- Modify: `src/services/streamelements.js`

Add chat message sending when a donation is received.

- [ ] **Step 1: Add chat integration**

In `src/services/streamelements.js`, add at the top:
```javascript
const { chatManager } = require('./twitchChat');
```

In the `handleTip` function, after emitting to the overlay bus, add:
```javascript
chatManager.sendEventMessage(this.streamerId, 'donation', {
  username: event.data.username,
  amount: event.data.amount,
  currency: event.data.currency || 'USD',
  message: event.data.message || '',
});
```

- [ ] **Step 2: Commit**

```bash
git add src/services/streamelements.js
git commit -m "feat: send chat messages for StreamElements donations"
```

---

## Task 7: Raid Overlay Banner

**Files:**
- Modify: `public/overlay/overlay.css`
- Modify: `public/overlay/overlay.js`

Add the raid-themed overlay banner (dark red, multiple cars zooming in).

- [ ] **Step 1: Add raid CSS to overlay.css**

Append to `public/overlay/overlay.css`:

```css
/* Raid: multiple cars zoom in from left */
.banner-raid { background: linear-gradient(90deg, #2e0a0a, #4a1a1a 50%, #2e0a0a); }
.banner-raid .checker-top { background: repeating-linear-gradient(90deg, #ff4444 0px, #ff4444 8px, #661111 8px, #661111 16px); }
.banner-raid .checker-bottom { background: repeating-linear-gradient(90deg, #661111 0px, #661111 8px, #ff4444 8px, #ff4444 16px); }
.banner-raid .banner-title { color: #ff4444; }

.raid-car-1 {
  position: absolute; font-size: 28px; z-index: 10; top: 25%;
  transform: translateY(-50%) scaleX(-1);
  animation: raidDrive1 2s ease-out infinite;
}
.raid-car-2 {
  position: absolute; font-size: 28px; z-index: 10; top: 50%;
  transform: translateY(-50%) scaleX(-1);
  animation: raidDrive2 2s ease-out 0.3s infinite;
}
.raid-car-3 {
  position: absolute; font-size: 28px; z-index: 10; top: 75%;
  transform: translateY(-50%) scaleX(-1);
  animation: raidDrive3 2s ease-out 0.6s infinite;
}

@keyframes raidDrive1 {
  0% { left: -50px; opacity: 0; } 20% { left: 5%; opacity: 1; }
  80% { left: 5%; opacity: 1; } 100% { left: -50px; opacity: 0; }
}
@keyframes raidDrive2 {
  0% { left: -50px; opacity: 0; } 20% { left: 3%; opacity: 1; }
  80% { left: 3%; opacity: 1; } 100% { left: -50px; opacity: 0; }
}
@keyframes raidDrive3 {
  0% { left: -50px; opacity: 0; } 20% { left: 7%; opacity: 1; }
  80% { left: 7%; opacity: 1; } 100% { left: -50px; opacity: 0; }
}
```

- [ ] **Step 2: Add raid case to overlay.js**

In `public/overlay/overlay.js`, add a `case 'raid':` in the `buildBannerContent` switch:

```javascript
case 'raid':
  return `${checkers}
    <div class="raid-car-1">🏎️</div>
    <div class="raid-car-2">🏎️</div>
    <div class="raid-car-3">🏎️</div>
    <div class="banner-content"><div style="text-align:center">
      <div class="banner-title">Incoming Raid!</div>
      <div class="banner-name">${esc(event.data.username)}</div>
      <div class="banner-sub">raiding with <span style="color:#ff4444;font-weight:bold">${event.data.viewers} viewers</span>! 🏁</div>
    </div></div>`;
```

Also add `raid: '/overlay/sounds/raid.mp3'` to the `soundMap` object.

- [ ] **Step 3: Commit**

```bash
git add public/overlay/overlay.css public/overlay/overlay.js
git commit -m "feat: add raid overlay banner with racing theme"
```

---

## Task 8: Dashboard — Chatbot Config Page

**Files:**
- Create: `src/views/chatbot-config.ejs`
- Modify: `src/routes/dashboard.js`
- Modify: `src/views/header.ejs`

Add the chatbot configuration page to the dashboard.

- [ ] **Step 1: Read existing templates for patterns**

Read `src/views/overlay-config.ejs` and `src/views/header.ejs` to match the existing design patterns exactly.

- [ ] **Step 2: Add chatbot routes to dashboard.js**

Add these routes to `src/routes/dashboard.js`:

```javascript
// Chatbot config page
router.get('/chatbot', (req, res) => {
  const streamer = req.streamer;
  res.render('chatbot-config', { streamer });
});

// Save chatbot settings
router.post('/chatbot', (req, res) => {
  const b = req.body;
  db.updateChatbotConfig(req.streamer.id, {
    chatbot_enabled: b.chatbot_enabled ? 1 : 0,
    chat_follow_enabled: b.chat_follow_enabled ? 1 : 0,
    chat_sub_enabled: b.chat_sub_enabled ? 1 : 0,
    chat_giftsub_enabled: b.chat_giftsub_enabled ? 1 : 0,
    chat_bits_enabled: b.chat_bits_enabled ? 1 : 0,
    chat_donation_enabled: b.chat_donation_enabled ? 1 : 0,
    chat_raid_enabled: b.chat_raid_enabled ? 1 : 0,
    chat_follow_template: b.chat_follow_template || '',
    chat_sub_template: b.chat_sub_template || '',
    chat_giftsub_template: b.chat_giftsub_template || '',
    chat_bits_template: b.chat_bits_template || '',
    chat_donation_template: b.chat_donation_template || '',
    chat_raid_template: b.chat_raid_template || '',
  });

  // Start/stop chat bot based on enabled state
  try {
    const { chatManager } = require('../services/twitchChat');
    if (b.chatbot_enabled) {
      chatManager.startForStreamer(req.streamer.id);
    } else {
      chatManager.stopForStreamer(req.streamer.id);
    }
  } catch (e) {}

  res.redirect('/dashboard/chatbot');
});
```

- [ ] **Step 3: Create chatbot-config.ejs**

Create `src/views/chatbot-config.ejs` following existing patterns. Include:

- Bot connection status — show bot username if connected, or "Connect Bot Account" button (links to `/auth/bot`)
- Master enable/disable toggle
- Per-event sections (follow, sub, gift sub, bits, donation, raid) each with:
  - Enable/disable checkbox
  - Template textarea showing the current template
  - Variable reference hint below the textarea (e.g., "Variables: {username}, {tier}, {months}, {message}")
- Save button
- Link to Custom Commands page (`/dashboard/chatbot/commands`)

Read `src/views/overlay-config.ejs` for the exact EJS include patterns and CSS classes.

- [ ] **Step 4: Add "Chatbot" to navigation**

In `src/views/header.ejs`, add a "Chatbot" sidebar link near the "Overlay" link.

- [ ] **Step 5: Commit**

```bash
git add src/routes/dashboard.js src/views/chatbot-config.ejs src/views/header.ejs
git commit -m "feat: add chatbot configuration page to dashboard"
```

---

## Task 9: Dashboard — Custom Commands Page

**Files:**
- Create: `src/views/chatbot-commands.ejs`
- Modify: `src/routes/dashboard.js`

Dashboard page for CRUD on custom chat commands.

- [ ] **Step 1: Add command routes to dashboard.js**

```javascript
// Custom commands page
router.get('/chatbot/commands', (req, res) => {
  const commands = db.getChatCommands(req.streamer.id);
  res.render('chatbot-commands', { streamer: req.streamer, commands });
});

// Add command
router.post('/chatbot/commands', (req, res) => {
  const { command, response, cooldown } = req.body;
  if (!command || !response) return res.redirect('/dashboard/chatbot/commands');
  // Strip ! prefix if user included it
  const cleanCmd = command.replace(/^!/, '').toLowerCase().trim();
  if (!cleanCmd) return res.redirect('/dashboard/chatbot/commands');

  try {
    db.addChatCommand(req.streamer.id, cleanCmd, response, parseInt(cooldown) || 5);
  } catch (err) {
    // UNIQUE constraint — command already exists
    console.log(`[Dashboard] Command !${cleanCmd} already exists`);
  }
  res.redirect('/dashboard/chatbot/commands');
});

// Update command
router.post('/chatbot/commands/:id/update', (req, res) => {
  const { command, response, enabled, cooldown } = req.body;
  const cleanCmd = (command || '').replace(/^!/, '').toLowerCase().trim();
  db.updateChatCommand(
    parseInt(req.params.id),
    req.streamer.id,
    cleanCmd,
    response,
    enabled ? 1 : 0,
    parseInt(cooldown) || 5
  );
  res.redirect('/dashboard/chatbot/commands');
});

// Delete command
router.post('/chatbot/commands/:id/delete', (req, res) => {
  db.deleteChatCommand(parseInt(req.params.id), req.streamer.id);
  res.redirect('/dashboard/chatbot/commands');
});
```

- [ ] **Step 2: Create chatbot-commands.ejs**

Create `src/views/chatbot-commands.ejs` with:
- "Add Command" form at the top: command name input, response textarea, cooldown number input, Add button
- Table/list of existing commands showing: `!command`, response (truncated), cooldown, enabled toggle, edit/delete buttons
- Each command row has an inline edit form (or modal)

Follow existing EJS/CSS patterns from the dashboard.

- [ ] **Step 3: Commit**

```bash
git add src/routes/dashboard.js src/views/chatbot-commands.ejs
git commit -m "feat: add custom chat commands CRUD page to dashboard"
```

---

## Task 10: Startup Integration

**Files:**
- Modify: `src/index.js`

Wire the chat manager into the server boot sequence.

- [ ] **Step 1: Add chat manager to startup**

In `src/index.js`, after the EventSub and StreamElements managers start, add:

```javascript
const { chatManager } = require('./services/twitchChat');
chatManager.startAll();
```

- [ ] **Step 2: Commit**

```bash
git add src/index.js
git commit -m "feat: start chatbot manager on server boot"
```

---

## Task 11: End-to-End Verification

- [ ] **Step 1: Start server, check no errors**

```bash
npm run dev
```

Verify no startup crashes. Check logs for chatbot/EventSub status.

- [ ] **Step 2: Test chatbot dashboard**

1. Log in to dashboard
2. Navigate to "Chatbot" page
3. Click "Connect Bot Account" — log in as the Atleta Twitch account
4. Verify bot username appears as connected
5. Enable the chatbot, save

- [ ] **Step 3: Test custom commands**

1. Navigate to "Custom Commands" page
2. Add a test command: `!socials` → "Follow me on Twitter!"
3. Verify it appears in the list
4. Type `!socials` in Twitch chat — verify bot responds
5. Spam `!socials` — verify cooldown works

- [ ] **Step 4: Test chat messages**

The existing overlay test buttons emit directly to the overlay bus, not through EventSub — so they won't trigger chat messages. To test chat messages, add test buttons to the chatbot dashboard page that call `chatManager.sendEventMessage()` directly. Or type in Twitch chat to test `!commands` and wait for real events to test thank-you messages.

- [ ] **Step 5: Test raid overlay**

Use the overlay test mechanism or simulate a raid — verify the red raid banner appears.

- [ ] **Step 6: Test template customization**

1. Change the follow template to something custom
2. Trigger a follow test
3. Verify the custom message appears in chat

- [ ] **Step 7: Commit if any fixes needed**

```bash
git add -A
git commit -m "feat: Twitch chatbot (Atleta) complete"
```
