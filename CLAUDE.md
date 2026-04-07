# Atleta Streamers Helper

Self-service streaming toolkit. Monitors Twitch (live streams, clips, recaps, milestones), YouTube (videos, shorts, livestreams — currently disabled via `features.youtube` flag), and provides welcome messages, subscriber role sync, and weekly digests. Includes chatbots for Twitch and YouTube with customizable thank-you messages, custom commands, 13 built-in fun commands, and chat moderation. OBS overlay with racing-themed animated notification banners, a visual overlay builder with advanced theme editor, and multiple card animations. PayPal donation system with direct-to-streamer payments and overlay alerts. Spotify integration for `!song` commands. Streamers configure everything through a web dashboard at `atletanotifications.com` with platform-tabbed layout, tab persistence, and multi-language support. Includes a standalone **Atleta Bridge** Electron desktop app for iRacing with real-time telemetry overlays (standings, relative, fuel, wind, proximity, track map, driver card, session laps, weather, race duration, voice chat) and voice-to-chat messaging.

## Tech Stack

- **Runtime:** Node.js >= 20 (no TypeScript, no build step)
- **Backend:** Express v5, EJS templates (server-rendered)
- **Database:** SQLite via better-sqlite3 (WAL mode, foreign keys)
- **Bot:** discord.js v14
- **External APIs:** Twitch Helix, Twitch EventSub (WebSocket), StreamElements (socket.io), YouTube Data API v3 + Live Chat API + RSS feeds, Spotify Web API, PayPal
- **Chatbot:** tmi.js (Twitch IRC) — single shared connection for all channels; YouTube Live Chat API polling
- **i18n:** Custom JSON-based translation system (7 languages)
- **Deployment:** Docker on Railway with persistent volume at `/app/data`
- **Testing:** Playwright E2E tests, run via pre-push git hook (must pass before push)
- **iRacing Bridge:** Electron 28, @emiliosp/node-iracing-sdk (koffi FFI), ws (WebSocket), uiohook-napi (global input hooks), electron-updater, electron-builder (NSIS installer)

## Commands

- `npm run dev` — run locally (loads `.env` via `--env-file`)
- `npm start` — production start

- `npx playwright test` — run Playwright E2E tests (public pages, authenticated flows, custom overlays)

No linting configured.

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
│   ├── chatModeration.js # Chat moderation filters — banned words, link protection, caps, emotes, repetition, symbols, escalation
│   ├── builtinCommands.js # 13 built-in chat commands — followage, 8ball, rps, roast, etc.
│   ├── youtubeLiveChat.js # YouTube Live Chat poller — polls chat during live streams, handles events + commands
│   ├── timedNotifications.js # Sponsor image rotation — cycles enabled sponsors per-streamer, emits to overlay + chat
│   └── overlayBus.js     # EventEmitter singleton — routes events to overlay SSE + chat
├── routes/
│   ├── auth.js           # Discord + Twitch + YouTube + Spotify OAuth flows
│   ├── overlay.js        # OBS overlay SSE endpoint + overlay HTML page + custom designs
│   ├── customOverlays.js # Custom overlays CRUD, SSE, file upload (DISABLED — commented out in server.js/overlay.js)
│   ├── dashboard.js      # Dashboard, account, guild config (tabbed), stats, channel CRUD, overlay config, chatbot config, overlay builder, YouTube chatbot, sound management, sponsor upload/settings, donation settings, built-in commands
│   ├── tip.js            # Public donation page — PayPal Checkout flow, captures payment, fires overlay alert
│   ├── api.js            # API endpoints
│   ├── admin.js          # Admin panel
│   └── payment.js        # PayPal subscriptions
└── views/
    ├── header.ejs        # Global layout — nav, sidebar, CSS design system, JS utilities
    ├── footer.ejs        # Closing tags
    ├── login.ejs         # Landing page with feature cards
    ├── dashboard.ejs     # Platform-tabbed dashboard (Discord | Twitch | YouTube | Kick | iRacing | Admin)
    ├── account.ejs       # User profile, metrics charts, subscription, language, logout
    ├── guild-config.ejs  # Tabbed UI: Twitch | YouTube | Discord | iRacing (coming soon) | Settings
    ├── overlay-config.ejs # OBS overlay settings — per-event pill toggles, durations, sound upload/trim/preview, alert preview modal
    ├── overlay-builder.ejs # Visual overlay builder — customize colors, fonts, animations, position per event with live preview
    ├── chatbot-config.ejs # Twitch chatbot — tabbed: Connection | Event Messages | Custom Commands (with built-in toggles) | Moderation (sub-tabbed: Filters | Users | Protection | Actions)
    ├── mod-log.ejs       # Moderation log — 7-day action history table
    ├── donation-settings.ejs # PayPal donation settings — email, currency, min amount, enable toggle
    ├── tip.ejs           # Public donation page — standalone PayPal Checkout for viewers
    ├── youtube-chatbot-config.ejs # YouTube chatbot — live stream connection, event templates, test buttons
    ├── timed-notifications.ejs # Sponsor rotation — image upload (drag & drop), per-image settings, interval/chat config
    ├── guild-stats.ejs   # Per-server stats with period selector (24h/7d/30d/year/lifetime)
    ├── donate.ejs        # Donation page (Buy me a coffee)
    ├── pricing.ejs       # Legacy pricing grid
    ├── subscription.ejs  # Subscription management
    ├── link-result.ejs   # Styled /link callback page
    ├── tutorial.ejs      # 8-step setup guide
    ├── report-issue.ejs  # Bug report form
    ├── custom-overlays.ejs # Custom overlays management page (DISABLED — not mounted)
    └── admin-*.ejs       # Admin panel views
public/
├── overlay/
│   ├── overlay.css       # Alert card styles — centered cards with per-event themes, full-screen effects
│   ├── overlay.js        # SSE client, event queue, card rendering, custom design application, synthesized racing sounds
│   ├── sponsors.js       # Sponsor overlay — independent OBS browser source for sponsor image rotation
│   ├── scenes.js         # Scene overlay OBS client (DISABLED — custom overlays feature)
│   ├── bar.js            # Info bar overlay OBS client (DISABLED — custom overlays feature)
│   ├── custom-alerts.js  # Custom alerts overlay OBS client (DISABLED — custom overlays feature)
│   └── sounds/           # Default sound directory (.gitkeep) — custom sounds stored in data/sounds/
tests/
├── public-pages.spec.js      # Playwright E2E tests for public pages (landing, pricing, tutorial, nav)
├── authenticated.spec.js     # Playwright E2E tests for authenticated flows
└── custom-overlays.spec.js   # Playwright E2E tests for custom overlay pages
data/
├── bot.db                # SQLite database (persistent volume on Railway)
├── sounds/               # Uploaded custom alert sounds (persistent, survives deploys)
└── sponsors/             # Uploaded sponsor images for rotation (persistent, survives deploys)
bridge/                     # Atleta Bridge — Electron desktop app for iRacing
├── main.js               # Electron main process — tray, control panel, overlay windows, IPC, camera switch
├── telemetry.js           # iRacing telemetry reader — standings, relative, fuel, wind, session info, iRating estimation
├── websocket.js           # WebSocket server (ws://localhost:9100) — per-client channel subscriptions, driver selection
├── settings.js            # Persistent settings in ~/Documents/Atleta Bridge/settings.json
├── keyboardSim.js         # Windows keyboard sim + iRacing camera switch via broadcast messages
├── voiceInput.js          # Global hotkey hooks (uiohook-napi), IPC coordination for voice chat
├── control-panel.html     # Sidebar-based settings — per-overlay tabs (General/Header/Content), updates, logs
├── installer.nsh          # Custom NSIS script to kill running app before install
├── package.json           # Electron 28, ws, @emiliosp/node-iracing-sdk, uiohook-napi, electron-updater
└── overlays/
    ├── standings.html     # Race standings — class-grouped, configurable columns/header, iRating gain, per-class SOF
    ├── relative.html      # Relative gaps — configurable columns/header, focusCar centering
    ├── fuel.html          # Fuel calculator — avg/lap, laps of fuel, fuel to finish (timed + lap races)
    ├── wind.html          # Wind compass — speed in km/h or mph, configurable colors
    ├── proximity.html     # Car proximity (coming soon)
    ├── trackmap.html      # Square track map — canvas with wind arrow, focused driver highlight
    ├── inputs.html        # Driver inputs — trace graph, pedal bars, gear, speed, steering wheel
    ├── raceduration.html  # Race duration — time left, estimated laps with multiclass + pit stop awareness
    ├── drivercard.html    # Driver card — focused driver: helmet, flag, name, position, iRating, class, laps
    ├── stintlaps.html     # Session laps — all laps with P/Q/R tags, best (purple), delta to best
    ├── weather.html       # Weather — animated sun/rain/clouds/fog, temps, humidity, wind, sky condition
    ├── chat.html          # Streaming chat — Twitch channel overlay
    ├── voicechat.html     # Voice chat — Whisper API transcription, push-to-talk, gamepad support
    └── helmets/           # Racing helmet PNG icons (2 styles) for driver card
```

## Key Architecture

- **Dashboard:** Platform-tabbed main page (Discord | Twitch | YouTube | Kick | iRacing | Admin) with localStorage tab persistence. Discord tab shows guild management. Twitch tab shows 7-day activity stats card (follows/subs/bits/donations/raids/giftsubs) + overlay/chatbot/Spotify/donations/sponsor cards. YouTube tab shows "Coming Soon" (disabled via features flag). Kick is coming soon. iRacing tab has sub-tabs: App Download (Bridge installer), Stream Overlays (overlay URLs + settings), Track Upload (admin-only: .ibt upload, track database, missing tracks). Admin tab is admin-only.
- **OBS Overlay:** EventSub receives Twitch events → overlayBus EventEmitter → SSE push to OBS browser source. Centered card design with per-event themes and full-screen effects (confetti, gold rain, money rain, robots, tire marks). All event types use the same card structure: top-accent + card-body (with optional side icons) + car-track (always visible for consistent height). Card animations built dynamically by `buildBottomAnimation()` — bottom-track types (car, checkered, equalizer) stay in track; full-card types (flames, sparkles, lightning, neon sweep, pulse) use `.card-anim-overlay` div. YouTube events (Super Chat, Member, Gift) also emit to the same overlay. Custom designs stored in `overlay_designs` table with advanced theme columns (opacity, gradient, border, glow, shadow). Donation alerts show message on separate line below amount. Moderation actions use Twitch Helix API (not tmi.js IRC) for message deletion/timeouts.
- **Overlay Builder:** Visual editor at `/dashboard/overlay-builder` with left control panel + right live preview. Events grouped by platform tabs (Twitch/YouTube/Kick/General). Customize per-event: colors, fonts (Google Fonts with live preview dropdown), text, animation entrance/screen effects, card size, position (9-cell grid + free drag with pixel coordinates), border radius. Advanced theme editor with 14 presets, gradient direction (7 options + solid), background opacity, border thickness/opacity, glow intensity, shadow blur/spread/opacity. Card animations split into Card Animation tab (entrance + bottom bar) and Canvas Animation tab (screen effects). Bottom bar animations: Car L→R, Car R→L, Checkered Flag, Equalizer (bottom track); Flames, Sparkles, Lightning, Neon Sweep, Pulse (full-card overlays). Preview shows stream screenshot background with draggable alert card. Designs saved to DB and applied at runtime via `applyCustomDesign()`.
- **Feature Flags:** `config.features.youtube` controls YouTube UI visibility across all pages. When `false`, YouTube tabs show "Coming Soon" placeholder. Set in `src/config.js`.
- **Twitch Chatbot (Atleta):** Single shared tmi.js connection (env var credentials) joins all enabled channels (requires `chatbot_enabled = 1` and `twitch_username` set). EventSub/StreamElements events trigger customizable thank-you messages. Custom `!commands` stored per-streamer in `chat_commands` table. Built-in `!song` command for Spotify. 13 toggleable built-in commands: `!followage`, `!subage`, `!uptime`, `!accountage`, `!8ball`, `!roll`, `!hug`, `!slap`, `!love`, `!rps`, `!coinflip`, `!quote`, `!roast`, plus `!commands` to list all available. Stored as `cmd_*_enabled` columns on `streamers` table.
- **Chat Moderation:** Per-feature toggleable moderation system in `chatModeration.js`. Features: banned words (always enforced, even for subs/VIPs), link protection with `!permit`, caps filter, emote spam, repetition filter, symbol spam, follow age gate, first-time chatter flag, slow mode command, raid protection (auto followers-only), escalation ladder, and moderation log (stored in `moderation_log` table, 7-day retention). Uses Twitch Helix API for message deletion and timeouts (not tmi.js IRC commands). Bot user ID resolved via OAuth validate endpoint to handle third-party token Client-IDs. Moderation tab organized into sub-tabs: Message Filters | User Management | Protection | Actions.
- **YouTube Chatbot:** Polling-based via YouTube Live Chat API. Activates when stream goes live (auto-detected by poller or manual connect). Detects Super Chats, new members, gifted memberships, and `!commands`. Uses global bot YouTube account for sending messages.
- **Spotify Integration:** Streamer connects Spotify via OAuth. `!song` command in Twitch/YouTube chat returns currently playing track. Token auto-refresh.
- **Sound System:** Per-event sounds with synthesized racing defaults (engine revs, turbo blow-off, tire screeches via Web Audio API). Custom mp3 upload with client-side trim tool. Custom sounds stored in `data/sounds/` (persistent volume). Overlay tries custom mp3 first, falls back to synthesized.
- **Sponsor Rotation:** Streamers upload sponsor images (stored in `data/sponsors/`). `timedNotifications.js` cycles through enabled sponsors at a configurable interval, emitting `type: 'sponsor'` events to the overlay and optionally sending chat messages. Managed via `/dashboard/timed-notifications` with drag-and-drop upload, per-image enable/toggle, and settings (interval, chat toggle).
- **Polling-based Discord notifications:** Pollers run on intervals, detect state changes, and send Discord notifications
- **Free for all:** All features are free and unlimited for every user — no tier gating
- **Donations (PayPal):** Streamers configure their PayPal email in `/dashboard/donations`. Public tip page at `/tip/:username` uses PayPal Checkout API with `payee: { email_address }` — money goes directly to the streamer's PayPal. On successful capture, fires overlay alert + chatbot message. Donation details (donor, message, amount, currency) stored in cookies during PayPal redirect. Donation messages shown on separate line below amount in overlay card. Event logged to `overlay_events` table. Legacy donate page at `/donate` (Buy me a coffee).
- **Overlay Event Logging:** All overlay events (follows, subs, bits, donations, raids) logged to `overlay_events` table. 7-day stats shown on Twitch tab dashboard card. 30-day retention with auto-cleanup.
- **Activity Feed:** Stream Recaps, Milestone Celebrations, Weekly Highlights — all free
- **Auth flows:** Discord OAuth login → Twitch linking → broadcaster auth (EventSub scopes) → bot account (global env var) → YouTube OAuth (streamer account for live detection) → Spotify OAuth (streamer account for !song)
- **YouTube Shorts:** Detected via YouTube Data API duration check (≤60s), separate notification format
- **User feedback:** Star rating + message on account page, visible in admin Feedback tab
- **Admin panel:** Accessible via Admin tab on dashboard (admin-only), tabbed UI with Stats/Users/Issues/Feedback/Discounts/Testing
- **Custom Overlays (DISABLED):** Template-based scene banners, info bars, and custom alerts controlled via chat commands. Code exists (`customOverlays.js`, `scenes.js`, `bar.js`, `custom-alerts.js`, `custom-overlays.ejs`) but all integrations are commented out in `server.js`, `overlay.js`, `twitchChat.js`, `dashboard.ejs`, `overlay-builder.ejs`, `overlay-config.ejs`, and `overlay.css`. DB table `custom_overlays` exists. Re-enable by uncommenting the marked sections.
- **Sponsor Overlay (separate source):** Sponsors have their own OBS browser source at `/overlay/sponsors/TOKEN` via `sponsors.js`, independent from the main alert overlay.
- **iRacing Bridge (Electron Desktop App):** Standalone Windows app (`bridge/`) that reads iRacing telemetry via `@emiliosp/node-iracing-sdk` (koffi FFI to shared memory) and displays transparent always-on-top overlays. WebSocket server on port 9100 with channel-based subscriptions (fuel 10Hz, wind 10Hz, proximity 10Hz, standings 1Hz, relative 2Hz, trackmap 2Hz). Overlays: Standings (class-grouped, configurable columns/header, estimated iRating gain/loss, per-class SOF, per-class max cars), Relative (configurable columns/header, focusCar centering, behind-closest-first order), Fuel Calculator (avg/lap, laps of fuel, fuel to finish for timed AND lap races, session time estimation), Wind Direction (km/h or mph, configurable colors, follows focused driver heading), Track Map (square canvas, wind chevron arrow, focused driver green highlight), Driver Inputs (toggleable: trace graph, pedal bars, gear, speed, steering wheel), Race Duration (time remaining, estimated laps with multiclass awareness + pit stop time deduction), Driver Card (focused driver: helmet icon, country flag, name, position, iRating change, class badge, best/last lap), Session Laps (all laps with P/Q/R session tags, fastest in purple, delta to best), Weather (animated sun/rain/clouds/fog based on humidity/precipitation, track time, temps, wind), Stream Chat, Voice Chat (Whisper API, push-to-talk, gamepad). Overlays are frameless, transparent, `alwaysOnTop: 'screen-saver'` with 2-second re-assert interval. Draggable via IPC-based mouse handling (mousedown/mousemove on header → `drag-overlay` IPC). Position configurable via X/Y settings with live preview. Settings persisted to `~/Documents/Atleta Bridge/settings.json`. Auto-updater via `electron-updater` with Windows system notifications. Proper semver versioning. Built with GitHub Actions (`.github/workflows/build-bridge.yml`) producing NSIS Windows installer. Version from `package.json` (no auto-increment).
- **Bridge Control Panel:** Sidebar-based settings window (800x650). Sidebar: Overview + per-overlay tabs + Updates/Logs/About. Each overlay tab has sub-tabs (General/Header/Content for standings/relative). Column drag-to-reorder with toggle switches. Session header items configurable. Font size scales all elements proportionally. Row height configurable. Position X/Y with live move preview. "Settings saved!" toast. Proximity marked "Coming Soon".
- **Bridge Driver Selection:** Click a driver row in standings → iRacing camera switches to them via broadcast message API (`IRSDK_BROADCASTMSG` / `CamSwitchNum`). Standings/relative highlight follows selection (green for spectated, purple for player). Track map shows focused driver as green dot. Wind overlay uses focused driver's estimated heading. Selection resets when iRacing camera changes (2s grace period) or player enters car.
- **Bridge Session Management:** Detects session changes via `SESSION_NUM`. Clears cached data on practice→qualify transitions. Keeps data on qualify→race. Excludes spectators (`IsSpectator`) and pace cars from standings. Session laps overlay clears on session number change.
- **Bridge Pit Time Tracking:** Measures pit stop time loss per class by detecting `CAR_IDX_ON_PIT_ROAD` transitions. When a driver exits pit and completes the pit lap, delta = pitLapTime - bestLap. Running average per class with 5-120s sanity bounds. Persisted per track to `~/Documents/Atleta Bridge/pittimes.json` — accumulates over time, loaded on session start so future races at the same track have historical pit data.
- **Bridge Race Duration:** Multiclass-aware timed race prediction. Uses overall leader's last lap (race pace) to determine when checkered falls: `totalTimeToCheckered = timeRemain + overallLeaderLastLap`. Focus class laps = `floor((totalTime - pitTimeLoss) / focusClassPace)`. Pit stops estimated from fuel data (fuel/lap vs tank capacity). Shows `~20 (1p)` format when pit stops are factored in.
- **Bridge Weather Overlay:** Animated weather conditions inferred from telemetry. For dynamic weather (skies="Dynamic"), infers from humidity: >75% = cloudy, 45-75% = partly cloudy, <45% = clear. CSS animations: spinning sun with rays, drifting clouds, falling raindrops, fog layers. Shows track time, sky label, air/track temp (color-coded), humidity, rain, wind direction/speed. iRacing SDK does NOT expose weather forecast data — only current conditions available.
- **Bridge Driver Card:** Shows focused driver's helmet icon (2 PNG styles selectable in config), country flag (SVG from flags/ directory, COUNTRY_TO_ISO mapping), name, position badge, iRating with gain/loss color, class badge (black text on white for light class colors), best/last lap times.
- **Bridge Session Laps:** Tracks all laps for the focused driver with session type tags: P (gray/practice), Q (yellow/qualify), R (green/race). Tags determined from `SessionInfo.Sessions[sessionNum].SessionType` at the time each lap is recorded. Clears on session number change. Shows best (purple), last, avg, and scrollable lap list with delta to best.
- **Bridge iRating Estimation:** Exact iRacing formula from official spreadsheet (source: `github.com/arrecio/ircalculator`). Calculated **per-class** in multiclass races. Formula:
  ```
  BR = 1600 / ln(2)  ≈ 2308.31
  chance(a, b) = Qa / (Qa + Qb)
    where Qa = (1 - exp(-a/BR)) * exp(-b/BR)
          Qb = (1 - exp(-b/BR)) * exp(-a/BR)
  expected[i] = -0.5 + SUM(chance(iR[i], iR[j])) for all j in class
  factor = ((N - nNonStarters/2) / 2 - pos) / 100
  change = round((N - pos - expected[i] - factor) * 200 / nStarters)
  ```
  Key: uses `exp()` not `pow(10)`, divisor is `1600/ln(2)` not `1600`. The `-0.5` offset accounts for self-pairing. The `factor` is a position-based correction. Shows green +N or red -N next to iRating on standings/relative. SOF calculated as harmonic mean of class iRatings, rounded to nearest 100. Matches iOverlay within ±1-2 points for most drivers.
- **Track Map System:** Browser-side .ibt parser extracts Lat/Lon (radians→degrees) + track name from session YAML. Uploads to server under both geoId and display name. Bridge fetches by geoKey then by name. Track database viewer on dashboard shows canvas previews. Missing tracks list compares against ~50 known iRacing tracks.
- **Voice Chat System:** Push-to-talk (global hotkey via `uiohook-napi` with key-down/key-up detection, supports keyboard keys, mouse side buttons, and gamepad buttons via Gamepad API) and wake word ("message") always-listening mode. OpenAI Whisper API for transcription (via PowerShell script, server-shared API key). Voice parsing: "all [text]", "number [#] [text]", "[name] [text]", "team [text]" with Levenshtein fuzzy matching. Confirmation UI. Sends to iRacing via `keyboardSim.js` — clipboard paste into iRacing chat. Configurable chat open key (T/Y/U/Enter).
- **iRacing Web Integration (coming soon):** Full integration built but disabled — waiting for iRacing OAuth credentials
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
- Overlay designs stored in `overlay_designs` table (including `card_custom_x`/`card_custom_y` for drag positions, advanced theme: `bg_opacity`, `gradient_direction`, `border_thickness`, `border_opacity`, `glow_intensity`, `shadow_*`), applied at runtime in `overlay.js` via `applyCustomDesign()`
- `applyCustomDesign()` must NOT overwrite dynamic detail text for donations/subs/bits/raids — only for follows
- Tab persistence uses `localStorage` across all tabbed pages (dashboard, guild-config, overlay-config, chatbot-config + moderation sub-tabs)
- Open Graph meta tags in `header.ejs` for social sharing previews
- Domain: `atletanotifications.com` (Cloudflare DNS → Railway)
- Public tip pages at `/tip/:username` are NOT behind auth middleware
- Bridge overlays follow same visual pattern: dark semi-transparent panel (`rgba(12,13,20,0.85)`), header with status dot, consistent color scheme
- Bridge overlays are `transparent: true` + `alwaysOnTop: 'screen-saver'` — dragging via IPC (mousedown/mousemove on header → `drag-overlay` IPC, NOT `-webkit-app-region: drag` which doesn't work on Windows transparent windows)
- Bridge overlays connect to `ws://localhost:9100` and subscribe to channels for real-time data
- Bridge uses `nodeIntegration: true` + `contextIsolation: false` in all overlay windows (local files only)
- Bridge overlay settings: per-overlay font size (scales ALL elements via proportional fsSmall/fsTiny/fsMed), row height, configurable columns (drag-to-reorder), session header items, position X/Y, color customization (wind arrow/compass, track map track/player/focus colors)
- `koffi` is available as a transitive dependency via `@emiliosp/node-iracing-sdk` — no need to list separately in package.json
- Bridge GitHub Actions build: `.github/workflows/build-bridge.yml` → produces NSIS installer → publishes to GitHub Releases (version from package.json, proper semver)
- Bridge control panel fetches release notes from GitHub Releases API (hardcoded array as fallback)
- `keyboardSim.js` also handles iRacing camera switching via `RegisterWindowMessageA('IRSDK_BROADCASTMSG')` + `SendNotifyMessageA`/`PostMessageA` with `HWND_BROADCAST`
- Track map API endpoints (`GET /api/track-maps`, `GET /api/track-map/:name`, `POST /api/track-map`) are public — placed BEFORE the `/api` auth middleware in `server.js`

## Overlay Consistency Rule

**The overlay builder (`overlay-builder.ejs`) is the source of truth for how alerts look.** The actual OBS overlay (`overlay.js` + `overlay.css`), the overlay config preview (`overlay-config.ejs` iframe), and the builder preview must all render cards identically:

- **Card structure:** All event types must use the same HTML structure: `top-accent` + `card-body` (with `wrapWithSideIcons`) + `car-track`. No event-specific custom sections (e.g., no crowd sections for raid, no missing car tracks for subscription).
- **Screen effects:** Direction-based effects (up/down/left/right) must work in both the builder preview (`renderScreenEffect()` in overlay-builder.ejs) and the OBS overlay (`spawnEffects()` in overlay.js). CSS classes for effects must NOT hardcode positional properties (`top`, `left`, etc.) — positions are set dynamically by JS based on direction.
- **Design application:** `applyCustomDesign()` in overlay.js and `updatePreview()` in overlay-builder.ejs must apply the same visual properties (colors, fonts, sizes, border-radius, animations, side icons).
- **When adding/changing any visual property:** Update all three rendering paths — builder preview, OBS overlay `generateCardHTML()`/`applyCustomDesign()`, and the EVENT_DEFAULTS in the builder.
