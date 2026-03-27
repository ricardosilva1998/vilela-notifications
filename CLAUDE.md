# Atleta Notifications Helper

Self-service Discord notification bot for streamers. Monitors Twitch (live streams, clips, recaps, milestones), YouTube (videos, shorts, livestreams), and provides welcome messages, subscriber role sync, and weekly digests. Includes chatbots for Twitch and YouTube with customizable thank-you messages and custom commands, OBS overlay with racing-themed animated notification banners and a visual overlay builder, and Spotify integration for `!song` commands. Streamers configure everything through a web dashboard with platform-tabbed layout and multi-language support.

## Tech Stack

- **Runtime:** Node.js >= 20 (no TypeScript, no build step)
- **Backend:** Express v5, EJS templates (server-rendered)
- **Database:** SQLite via better-sqlite3 (WAL mode, foreign keys)
- **Bot:** discord.js v14
- **External APIs:** Twitch Helix, Twitch EventSub (WebSocket), StreamElements (socket.io), YouTube Data API v3 + Live Chat API + RSS feeds, Spotify Web API, PayPal
- **Chatbot:** tmi.js (Twitch IRC) — single shared connection for all channels; YouTube Live Chat API polling
- **i18n:** Custom JSON-based translation system (7 languages)
- **Deployment:** Docker on Railway with persistent volume at `/app/data`

## Commands

- `npm run dev` — run locally (loads `.env` via `--env-file`)
- `npm start` — production start

There are no tests or linting configured.

## Project Structure

```
src/
├── index.js              # Entry point — boots bot, pollers, EventSub, StreamElements, chat managers, web server
├── config.js             # Env vars + tier definitions + intervals
├── db.js                 # SQLite schema, migrations, seeds, and all queries
├── server.js             # Express app + middleware (session, i18n, language, static files)
├── discord.js            # Discord client + embed helpers (recap, digest, milestone)
├── i18n.js               # Translation helper — loads JSON locale files
├── commands.js           # Slash commands
├── welcome.js            # Welcome message listener
├── locales/              # Translation files (en, pt, es, fr, de, zh, ja)
├── pollers/
│   ├── manager.js        # Orchestrates all pollers + recap/milestone fan-out + YouTube chat start/stop
│   ├── twitchLive.js     # Stream go-live + offline detection with recap data (60s)
│   ├── twitchClips.js    # New clips (5min)
│   ├── youtubeFeed.js    # YouTube RSS polling for videos/shorts (5min)
│   ├── youtubeLive.js    # YouTube live detection via API (2min)
│   ├── weeklyDigest.js   # Weekly highlights digest (Monday 09:00 UTC)
│   └── subSync.js        # Twitch sub role sync (10min)
├── services/
│   ├── twitch.js         # Twitch Helix API + broadcaster/bot token refresh
│   ├── youtube.js        # YouTube API + RSS + Live Chat API + channel resolver + bot token refresh
│   ├── spotify.js        # Spotify Web API — currently playing track + token refresh
│   ├── eventsub.js       # Twitch EventSub WebSocket (per-streamer connections for overlay/chat events)
│   ├── streamelements.js # StreamElements socket.io (per-streamer, donation tips)
│   ├── twitchChat.js     # Shared tmi.js chatbot — single connection, joins all enabled channels
│   ├── youtubeLiveChat.js # YouTube Live Chat poller — polls chat during live streams, handles events + commands
│   ├── timedNotifications.js # Sponsor image rotation — cycles enabled sponsors per-streamer, emits to overlay + chat
│   └── overlayBus.js     # EventEmitter singleton — routes events to overlay SSE + chat
├── routes/
│   ├── auth.js           # Discord + Twitch + YouTube + Spotify OAuth flows
│   ├── overlay.js        # OBS overlay SSE endpoint + overlay HTML page + custom designs
│   ├── dashboard.js      # Dashboard, account, guild config (tabbed), stats, channel CRUD, overlay config, chatbot config, overlay builder, YouTube chatbot, sound management, sponsor upload/settings
│   ├── api.js            # API endpoints
│   ├── admin.js          # Admin panel
│   └── payment.js        # PayPal subscriptions
└── views/
    ├── header.ejs        # Global layout — nav, sidebar, CSS design system, JS utilities
    ├── footer.ejs        # Closing tags
    ├── login.ejs         # Landing page with feature cards
    ├── dashboard.ejs     # Platform-tabbed dashboard (Discord | Twitch | YouTube | Kick | Admin)
    ├── account.ejs       # User profile, metrics charts, subscription, language, logout
    ├── guild-config.ejs  # Tabbed UI: Twitch | YouTube | Discord | iRacing (coming soon) | Settings
    ├── overlay-config.ejs # OBS overlay settings — per-event pill toggles, durations, sound upload/trim/preview, alert preview modal
    ├── overlay-builder.ejs # Visual overlay builder — customize colors, fonts, animations, position per event with live preview
    ├── chatbot-config.ejs # Twitch chatbot — tabbed: Connection | Event Messages (with test buttons) | Custom Commands
    ├── youtube-chatbot-config.ejs # YouTube chatbot — live stream connection, event templates, test buttons
    ├── timed-notifications.ejs # Sponsor rotation — image upload (drag & drop), per-image settings, interval/chat config
    ├── guild-stats.ejs   # Per-server stats with period selector (24h/7d/30d/year/lifetime)
    ├── donate.ejs        # Donation page (Buy me a coffee)
    ├── pricing.ejs       # Legacy pricing grid
    ├── subscription.ejs  # Subscription management
    ├── link-result.ejs   # Styled /link callback page
    ├── tutorial.ejs      # 8-step setup guide
    ├── report-issue.ejs  # Bug report form
    └── admin-*.ejs       # Admin panel views
public/
├── overlay/
│   ├── overlay.css       # Alert card styles — centered cards with per-event themes, full-screen effects
│   ├── overlay.js        # SSE client, event queue, card rendering, custom design application, synthesized racing sounds
│   └── sounds/           # Default sound directory (.gitkeep) — custom sounds stored in data/sounds/
data/
├── bot.db                # SQLite database (persistent volume on Railway)
├── sounds/               # Uploaded custom alert sounds (persistent, survives deploys)
└── sponsors/             # Uploaded sponsor images for rotation (persistent, survives deploys)
```

## Key Architecture

- **Dashboard:** Platform-tabbed main page (Discord | Twitch | YouTube | Kick | Admin). Discord tab shows guild management. Twitch tab shows overlay/chatbot/Spotify cards. YouTube tab shows chatbot config. Kick is coming soon. Admin tab is admin-only.
- **OBS Overlay:** EventSub receives Twitch events → overlayBus EventEmitter → SSE push to OBS browser source. Centered card design with per-event themes: Follow (tire marks + sparks), Subscription (confetti + camera flashes), Bits (gold rain), Donation (money rain), Raid (robots falling). YouTube events (Super Chat, Member, Gift) also emit to the same overlay. Custom designs stored in `overlay_designs` table.
- **Overlay Builder:** Visual editor at `/dashboard/overlay-builder` with left control panel + right live preview. Events grouped by platform tabs (Twitch/YouTube/Kick/General). Customize per-event: colors, fonts (Google Fonts with live preview dropdown), text, animation entrance/screen effects, card size, position (9-cell grid + free drag with pixel coordinates), border radius, theme presets. Preview shows stream screenshot background with fake webcam/chat/HUD and draggable alert card. Designs saved to DB (including `card_custom_x`/`card_custom_y` for drag positions) and applied at runtime via `applyCustomDesign()`.
- **Twitch Chatbot (Atleta):** Single shared tmi.js connection (env var credentials) joins all enabled channels. EventSub/StreamElements events trigger customizable thank-you messages. Custom `!commands` stored per-streamer in `chat_commands` table. Built-in `!song` command for Spotify.
- **YouTube Chatbot:** Polling-based via YouTube Live Chat API. Activates when stream goes live (auto-detected by poller or manual connect). Detects Super Chats, new members, gifted memberships, and `!commands`. Uses global bot YouTube account for sending messages.
- **Spotify Integration:** Streamer connects Spotify via OAuth. `!song` command in Twitch/YouTube chat returns currently playing track. Token auto-refresh.
- **Sound System:** Per-event sounds with synthesized racing defaults (engine revs, turbo blow-off, tire screeches via Web Audio API). Custom mp3 upload with client-side trim tool. Custom sounds stored in `data/sounds/` (persistent volume). Overlay tries custom mp3 first, falls back to synthesized.
- **Sponsor Rotation:** Streamers upload sponsor images (stored in `data/sponsors/`). `timedNotifications.js` cycles through enabled sponsors at a configurable interval, emitting `type: 'sponsor'` events to the overlay and optionally sending chat messages. Managed via `/dashboard/timed-notifications` with drag-and-drop upload, per-image enable/toggle, and settings (interval, chat toggle).
- **Polling-based Discord notifications:** Pollers run on intervals, detect state changes, and send Discord notifications
- **Free for all:** All features are free and unlimited for every user — no tier gating
- **Donations:** PayPal.me donation page at `/donate` (Buy me a coffee or candy)
- **Activity Feed:** Stream Recaps, Milestone Celebrations, Weekly Highlights — all free
- **Auth flows:** Discord OAuth login → Twitch linking → broadcaster auth (EventSub scopes) → bot account (global env var) → YouTube OAuth (streamer account for live detection) → Spotify OAuth (streamer account for !song)
- **YouTube Shorts:** Detected via YouTube Data API duration check (≤60s), separate notification format
- **User feedback:** Star rating + message on account page, visible in admin Feedback tab
- **Admin panel:** Accessible via Admin tab on dashboard (admin-only), tabbed UI with Stats/Users/Issues/Feedback/Discounts/Testing
- **iRacing (coming soon):** Full integration built but disabled — waiting for iRacing OAuth credentials
- **DB migrations:** Auto-run on startup in `src/db.js`
- **No ORM:** All SQL is raw in `db.js`
- **i18n:** `t(lang, key, params)` helper via `res.locals.t` — cookie-based language preference

## Environment Variables

Required:
- `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`
- `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`

Optional:
- `BOT_TWITCH_USERNAME`, `BOT_TWITCH_TOKEN` — Twitch chatbot credentials (shared single connection)
- `YOUTUBE_API_KEY` — global key for YouTube live detection
- `YOUTUBE_BOT_CLIENT_ID`, `YOUTUBE_BOT_CLIENT_SECRET`, `YOUTUBE_BOT_REFRESH_TOKEN` — YouTube chatbot credentials
- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` — Spotify integration for !song command
- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MODE`
- `APP_URL`, `PORT`, `SESSION_SECRET`, `ADMIN_PASSWORD`
- Polling intervals: `TWITCH_POLL_INTERVAL`, `TWITCH_CLIPS_INTERVAL`, `YOUTUBE_FEED_INTERVAL`, `YOUTUBE_LIVE_INTERVAL`, `SUB_SYNC_INTERVAL`, `WEEKLY_DIGEST_INTERVAL`

## Conventions

- Plain CommonJS (`require`/`module.exports`), no ESM
- No framework abstractions — routes, DB queries, and pollers are straightforward procedural code
- All database operations go through `src/db.js`
- Config access via `require('./config')`
- `-1` means unlimited in tier limits
- CSS design system uses CSS custom properties (defined in `header.ejs`)
- Typography: Outfit (display) + DM Sans (body) via Google Fonts
- All user-facing text should use `t('key')` for i18n support
- Twitch notifications sent as embeds, clips and YouTube videos sent as plain text (for Discord auto-preview)
- Custom sounds stored in `data/sounds/` (persistent volume), not `public/overlay/sounds/`
- Sponsor images stored in `data/sponsors/` (persistent volume), served via `/sponsors/` static route
- Overlay designs stored in `overlay_designs` table (including `card_custom_x`/`card_custom_y` for drag positions), applied at runtime in `overlay.js` via `applyCustomDesign()`
