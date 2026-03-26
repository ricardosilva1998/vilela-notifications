# Twitch Chatbot (Atleta) — Design Spec

## Context

The vilela-notifications project already has an OBS overlay notification system using Twitch EventSub for follows, subs, bits, and StreamElements donations. The user wants a Twitch chatbot ("Atleta") that joins their channel and sends customizable thank-you messages when these events occur, plus handles raids. The bot should also support custom chat commands managed from the existing dashboard.

## Goals

- Chatbot that sends customizable thank-you messages in Twitch chat for: follows, subscriptions, gift subs, bits, donations, and raids
- Raid support added to both chat AND overlay (new animated banner)
- Custom chat commands (e.g., `!socials`, `!discord`) creatable from the dashboard
- Bot runs as a separate Twitch account ("Atleta") — requires its own OAuth flow
- All configuration managed from the existing vilela-notifications dashboard

## Architecture

```
EventSub (existing)  ──→  Event Handler  ──→  Overlay Bus (existing)
                              │
                              ▼
                          Chat Service  ──→  tmi.js  ──→  Twitch Chat
                              │                              ↑
                              ▼                              │
                       Message Templates (DB)       Command Handler
```

**Event flow:**
1. EventSub receives an event (follow, sub, bits, raid)
2. Event handler sends to overlay bus (existing) AND chat service (new)
3. Chat service formats the message using the streamer's template and sends via tmi.js
4. For raids: also sends an overlay banner

**Chat commands flow:**
1. tmi.js receives a chat message
2. If it starts with `!`, look up the command in the DB for that streamer
3. If found and enabled, send the response (respecting cooldown)

## Components

### 1. Chat Service (`src/services/twitchChat.js`)

Manages per-streamer tmi.js connections. The bot connects using the **bot account's** OAuth token (separate from the broadcaster token used by EventSub).

- `TwitchChatClient` class — one instance per streamer
  - `connect()` — joins the streamer's Twitch channel using the bot's OAuth token
  - `sendMessage(channel, message)` — sends a chat message
  - `disconnect()` — leaves the channel
- `chatManager` — manages all per-streamer connections
  - `startAll()` / `startForStreamer(id)` / `stopForStreamer(id)` / `stopAll()`
- Listens for chat messages and routes `!commands` to the command handler

### 2. Bot Account OAuth

New OAuth flow at `/auth/bot` for the bot account:
- Scopes: `chat:edit chat:read`
- Stores: `bot_access_token`, `bot_refresh_token`, `bot_token_expires_at`, `bot_username` on the `streamers` table
- The streamer logs into the "Atleta" Twitch account and authorizes from the dashboard

### 3. Message Templates

Stored as columns on the `streamers` table with default values:

| Event | Column | Default Template |
|-------|--------|-----------------|
| Follow | `chat_follow_template` | `Welcome to the pit crew, {username}! 🏎️` |
| Subscription | `chat_sub_template` | `{username} just joined the podium! Tier {tier} for {months} months! 🏆` |
| Gift Sub | `chat_giftsub_template` | `{username} gifted {amount} subs! What a sponsor! 🎁` |
| Bits | `chat_bits_template` | `{username} fueled up {amount} bits! 🔥` |
| Donation | `chat_donation_template` | `{username} sponsored the team with ${amount}! 💰` |
| Raid | `chat_raid_template` | `{username} is raiding with {viewers} viewers! Welcome racers! 🏁` |

**Available variables per event:**
- Follow: `{username}`
- Subscription: `{username}`, `{tier}`, `{months}`, `{message}`
- Gift Sub: `{username}`, `{amount}`, `{tier}`
- Bits: `{username}`, `{amount}`, `{message}`
- Donation: `{username}`, `{amount}`, `{currency}`, `{message}`
- Raid: `{username}`, `{viewers}`

Per-event enable/disable toggles: `chat_follow_enabled`, `chat_sub_enabled`, `chat_giftsub_enabled`, `chat_bits_enabled`, `chat_donation_enabled`, `chat_raid_enabled` (all default to 1).

### 4. Custom Chat Commands

New table `chat_commands`:

```sql
CREATE TABLE chat_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  streamer_id INTEGER NOT NULL,
  command TEXT NOT NULL,
  response TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  cooldown INTEGER DEFAULT 5,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (streamer_id) REFERENCES streamers(id),
  UNIQUE(streamer_id, command)
);
```

- `command` stored without `!` prefix (e.g., `socials` not `!socials`)
- `response` is plain text sent to chat
- `cooldown` in seconds — prevents spam (per-command, per-channel)
- Dashboard CRUD: add, edit, delete, toggle enabled

### 5. Raid Support

**EventSub addition:** Add `channel.raid` (v1) to the existing EventSub subscription types. Condition: `{ to_broadcaster_user_id: broadcasterId }`. Required scope: none (no additional scope needed for incoming raids).

**Raid event payload:**
```json
{
  "from_broadcaster_user_id": "1234",
  "from_broadcaster_user_login": "raider",
  "from_broadcaster_user_name": "Raider",
  "to_broadcaster_user_id": "5678",
  "viewers": 42
}
```

**Overlay banner:**
- Theme: "Incoming Raid!" — dark red gradient (`#2e0a0a → #4a1a1a`)
- Red checkered borders
- Animation: Multiple cars zooming in from left
- Text: raider name + viewer count

**Chat message:** Uses the raid template.

### 6. Dashboard Pages

**Chatbot Config Page** (`/dashboard/chatbot`):
- Bot account connection status + "Connect Bot Account" button (links to `/auth/bot`)
- Chatbot enable/disable master toggle
- Per-event message templates (textarea for each) with variable reference
- Per-event enable/disable toggles
- Save button

**Custom Commands Page** (`/dashboard/chatbot/commands`):
- List of existing commands with edit/delete/toggle
- "Add Command" form: command name, response text, cooldown
- Inline edit for existing commands

Or combine both into a single tabbed page — implementation can decide based on the existing dashboard patterns.

### 7. Integration with Existing EventSub

The existing `eventsub.js` currently emits events to the overlay bus. Changes needed:
- Add `channel.raid` to `SUBSCRIPTION_TYPES`
- Modify `normalizeEvent` to distinguish gift subs: `channel.subscription.gift` should normalize to `type: 'giftsub'` (separate from `type: 'subscription'`). The overlay should treat both as `subscription` for the banner, but the chat service uses the distinct type to pick the correct template.
- After normalizing an event, emit to BOTH the overlay bus AND the chat service
- The chat service formats the message from the template and sends via tmi.js

### 8. OAuth Scopes Update

The bot account OAuth flow needs: `chat:edit chat:read`

The broadcaster OAuth scopes remain unchanged (EventSub scopes are already set).

## Database Changes

### New columns on `streamers`:
- `bot_access_token TEXT`
- `bot_refresh_token TEXT`
- `bot_token_expires_at INTEGER`
- `bot_username TEXT`
- `chatbot_enabled INTEGER DEFAULT 0`
- `chat_follow_enabled INTEGER DEFAULT 1`
- `chat_sub_enabled INTEGER DEFAULT 1`
- `chat_giftsub_enabled INTEGER DEFAULT 1`
- `chat_bits_enabled INTEGER DEFAULT 1`
- `chat_donation_enabled INTEGER DEFAULT 1`
- `chat_raid_enabled INTEGER DEFAULT 1`
- `chat_follow_template TEXT DEFAULT 'Welcome to the pit crew, {username}! 🏎️'`
- `chat_sub_template TEXT DEFAULT '{username} just joined the podium! Tier {tier} for {months} months! 🏆'`
- `chat_giftsub_template TEXT DEFAULT '{username} gifted {amount} subs! What a sponsor! 🎁'`
- `chat_bits_template TEXT DEFAULT '{username} fueled up {amount} bits! 🔥'`
- `chat_donation_template TEXT DEFAULT '{username} sponsored the team with ${amount}! 💰'`
- `chat_raid_template TEXT DEFAULT '{username} is raiding with {viewers} viewers! Welcome racers! 🏁'`

### New table: `chat_commands`
As defined above.

## Bot Token Refresh

The bot OAuth tokens will expire. Add a `refreshBotToken(streamer)` function (similar to the existing `refreshBroadcasterToken`) that refreshes the bot tokens and updates `bot_access_token`, `bot_refresh_token`, `bot_token_expires_at` in the DB. The chat service should check token expiry before connecting and refresh if needed.

## New Dependencies

- `tmi.js` — Twitch IRC client for joining chat and sending messages

## Verification

1. **Bot connects:** Start server, verify Atleta joins the streamer's Twitch channel
2. **Follow message:** Trigger a follow (or test from dashboard), verify chat message appears
3. **Sub message:** Test sub notification, verify chat message with correct tier/months
4. **Bits message:** Test bits, verify amount shows correctly
5. **Donation message:** Test StreamElements donation, verify chat message
6. **Raid message + overlay:** Test raid, verify BOTH chat message and overlay banner
7. **Custom commands:** Create `!socials` from dashboard, type it in chat, verify response
8. **Command cooldown:** Spam a command, verify cooldown is enforced
9. **Template customization:** Change a template in dashboard, trigger event, verify new message
10. **Enable/disable:** Disable follow messages, trigger follow, verify no chat message sent
