# Atleta Notifications Helper

Self-service Discord notification bot for streamers. Monitors Twitch (live streams, clips, recaps, milestones), YouTube (videos, shorts, livestreams), and provides welcome messages, subscriber role sync, and weekly digests. Streamers configure everything through a web dashboard with multi-language support.

## Tech Stack

- **Runtime:** Node.js >= 20 (no TypeScript, no build step)
- **Backend:** Express v5, EJS templates (server-rendered)
- **Database:** SQLite via better-sqlite3 (WAL mode, foreign keys)
- **Bot:** discord.js v14
- **External APIs:** Twitch Helix, YouTube Data API v3 + RSS feeds, PayPal
- **i18n:** Custom JSON-based translation system (7 languages)
- **Deployment:** Docker on Railway with persistent volume at `/app/data`

## Commands

- `npm run dev` — run locally (loads `.env` via `--env-file`)
- `npm start` — production start

There are no tests or linting configured.

## Project Structure

```
src/
├── index.js              # Entry point — boots bot, pollers, and web server
├── config.js             # Env vars + tier definitions + intervals
├── db.js                 # SQLite schema, migrations (7), seeds, and all queries
├── server.js             # Express app + middleware (session, i18n, language)
├── discord.js            # Discord client + embed helpers (recap, digest, milestone)
├── i18n.js               # Translation helper — loads JSON locale files
├── commands.js           # Slash commands
├── welcome.js            # Welcome message listener
├── locales/              # Translation files (en, pt, es, fr, de, zh, ja)
├── pollers/
│   ├── manager.js        # Orchestrates all pollers + recap/milestone fan-out
│   ├── twitchLive.js     # Stream go-live + offline detection with recap data (60s)
│   ├── twitchClips.js    # New clips (5min)
│   ├── youtubeFeed.js    # YouTube RSS polling for videos/shorts (5min)
│   ├── youtubeLive.js    # YouTube live detection via API (2min)
│   ├── weeklyDigest.js   # Weekly highlights digest (Monday 09:00 UTC)
│   └── subSync.js        # Twitch sub role sync (10min)
├── services/
│   ├── twitch.js         # Twitch Helix API (streams, clips, users, followers, videos, games)
│   └── youtube.js        # YouTube API + RSS + channel resolver (@handle → channel ID)
├── routes/
│   ├── auth.js           # Discord + Twitch OAuth
│   ├── dashboard.js      # Dashboard, account, guild config (tabbed), stats, channel CRUD
│   ├── api.js            # API endpoints
│   ├── admin.js          # Admin panel
│   └── payment.js        # PayPal subscriptions
└── views/
    ├── header.ejs        # Global layout — nav, sidebar, CSS design system, JS utilities
    ├── footer.ejs        # Closing tags
    ├── login.ejs         # Landing page with feature cards
    ├── dashboard.ejs     # Server list with inline expandable stats per guild
    ├── account.ejs       # User profile, metrics charts, subscription, language, logout
    ├── guild-config.ejs  # Tabbed UI: Twitch | YouTube | Discord | Settings
    ├── guild-stats.ejs   # Per-server stats with period selector (24h/7d/30d/year/lifetime)
    ├── pricing.ejs       # 4-tier pricing grid
    ├── subscription.ejs  # Subscription management
    ├── tutorial.ejs      # 8-step setup guide
    ├── report-issue.ejs  # Bug report form
    └── admin-*.ejs       # Admin panel views
```

## Key Architecture

- **Polling-based:** Pollers run on intervals, detect state changes, and send Discord notifications
- **Tier system:** Free / Starter (€5/yr) / Pro (€10/yr) / Enterprise (€25/yr) — defined in `src/config.js`
- **Activity Feed:** Stream Recaps (Starter+), Milestone Celebrations (Starter+), Weekly Highlights (Pro+)
- **Auth flow:** Discord OAuth login → Twitch linking → bot invite → tabbed channel config
- **DB migrations:** 7 migrations auto-run on startup in `src/db.js`
- **DB seeds:** Enterprise subscriptions granted to specific users on startup
- **No ORM:** All SQL is raw in `db.js` (~1200 lines)
- **i18n:** `t(lang, key, params)` helper via `res.locals.t` — cookie-based language preference
- **YouTube setup:** Accepts @username or channel ID, resolves via page scraping, pre-populates known videos to avoid spam
- **Twitch profiles:** Fetched via `/users` API on channel add, cached in DB, backfilled on page load
- **YouTube profiles:** Extracted from channel page og:image, cached in DB, backfilled on page load
- **Bot leaves server:** `guild.leave()` called when user removes a server from dashboard
- **Global YouTube API key:** `YOUTUBE_API_KEY` env var used for all users' live detection

## Environment Variables

Required:
- `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`
- `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`

Optional:
- `YOUTUBE_API_KEY` — global key for YouTube live detection
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
