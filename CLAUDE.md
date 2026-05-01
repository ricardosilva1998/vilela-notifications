# Atleta Personal Helper

Two-product platform: **Streamer** (Twitch/YouTube/Discord tools) and **Racing** (iRacing telemetry & analysis). Each has its own auth system and dedicated landing page. Accounts are optionally linkable.

**Streamer:** Monitors Twitch (live streams, clips, recaps, milestones), YouTube (videos, shorts, livestreams — currently disabled via `features.youtube` flag), and provides welcome messages, subscriber role sync, and weekly digests. Includes chatbots for Twitch and YouTube with customizable thank-you messages, custom commands, 13 built-in fun commands, and chat moderation. OBS overlay with racing-themed animated notification banners, a visual overlay builder with advanced theme editor, and multiple card animations. PayPal donation system with direct-to-streamer payments and overlay alerts. Spotify integration for `!song` commands. Streamers configure everything through a web dashboard at `atletanotifications.com`. Requires Discord OAuth login.

**Racing:** Standalone username/password auth (no Discord required). **Atleta Racing** Electron desktop app for iRacing (renamed from "Atleta Bridge" in v3.26.0 — the codebase and filesystem still use `bridge/` / `atleta-bridge` internally) with real-time telemetry overlays (standings, relative, fuel, wind, proximity, track map, driver card, session laps, weather, race duration, flags, voice chat, live stats, pit strategy, pit timer, lap compare) and voice-to-chat messaging. Session capture pipeline records per-lap data + 10Hz telemetry traces during practice/qualify/race sessions and uploads progressively to the server. Track database page with Practice/Race tabs, session history with expandable lap details. Bridge requires Racing account login on startup.

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
- **Auth:** Discord OAuth (Streamer), bcryptjs username/password (Racing), linkable accounts
- **iRacing Bridge:** Electron 28, @emiliosp/node-iracing-sdk (koffi FFI), ws (WebSocket), pako (gzip), uiohook-napi (global input hooks), electron-updater, electron-builder (NSIS installer)

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
│   ├── overlayBus.js     # EventEmitter singleton — routes events to overlay SSE + chat
│   └── pitwallRelay.js   # Team Pitwall WebSocket relay — Bridge uplink (/ws/bridge) + viewer connections (/ws/pitwall), multi-team broadcast
├── routes/
│   ├── auth.js           # Discord + Twitch + YouTube + Spotify OAuth flows + Racing account linking
│   ├── racing-auth.js    # Racing standalone auth — signup, login, logout, login-api (Bridge)
│   ├── racing.js         # Racing dashboard, account settings, admin, avatar upload, pitwall routes
│   ├── racing-team.js    # Team management — multi-team CRUD, picture/banner upload at /racing/teams, /racing/teams/:teamId
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
    ├── login.ejs         # Homepage with two product cards (Streamer + Racing)
    ├── streamer-landing.ejs # Streamer product landing with Discord login
    ├── racing-landing.ejs   # Racing product landing with login/signup forms
    ├── racing-signup.ejs    # Racing account signup form
    ├── racing-dashboard.ejs # Racing home — quick links + session history
    ├── racing-account.ejs   # Racing account settings — avatar (interactive crop editor with drag/zoom/circular preview), profile, password, Discord/Twitch links
    ├── racing-teams.ejs     # Teams list — all user's teams as cards, pending invites, create/join (max 5)
    ├── racing-team-detail.ejs # Per-team management — banner/picture upload with crop editors, members, invite (autocomplete), kick, leave/delete
    ├── racing-pitwall.ejs   # Pitwall — live telemetry viewer, gridstack.js free-form layout, postMessage relay to overlay iframes
    ├── racing-pitwall-picker.ejs # Pitwall team picker — shown when user has 2+ teams
    ├── racing-admin.ejs     # Racing admin — user accounts, online status, unregistered bridges
    ├── tracks.ejs           # Track database — grid/list + detail with Practice/Race tabs
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
bridge/                     # Atleta Racing (formerly "Atleta Bridge") — Electron desktop app for iRacing; directory and npm package name stay `bridge`/`atleta-bridge` for stability
├── main.js               # Electron main process — tray, login window, control panel, overlay windows, IPC, camera switch
├── login.html            # Racing account login/signup screen (shown on startup if not authenticated)
├── telemetry.js           # iRacing telemetry reader — standings, relative, fuel, wind, session info, iRating estimation, session recorder integration, incident tracker integration
├── incidentTracker.js     # Pure state machine: per-session offtracks/penalties/slow-laps with attributed time loss (consumed by telemetry.js + raceduration overlay)
├── test-incidentTracker.js # node:test suite (28 tests) for incidentTracker.js
├── sidebarState.js        # Pure data helpers for control-panel sidebar (pushRecent, toggleFavorite, pruneStaleIds, isFavorite)
├── test-sidebarState.js   # node:test suite (15 tests) for sidebarState.js
├── flagState.js           # Pure state machine: flag priority ladder, dwell, blue cooldown + dropout debounce (consumed by telemetry.js + flags overlay)
├── test-flagState.js      # node:test suite (27 tests) for flagState.js
├── sessionRecorder.js     # Session capture — buffers 10Hz telemetry per lap, progressive upload to server
├── websocket.js           # WebSocket server (ws://localhost:9100) — per-client channel subscriptions, driver selection
├── pitwallUplink.js       # Team Pitwall uplink — connects to wss://atletanotifications.com/ws/bridge, multi-team broadcast selection
├── settings.js            # Persistent settings in ~/Documents/Atleta Racing/settings.json (auto-migrates from legacy ~/Documents/Atleta Bridge on first launch)
├── keyboardSim.js         # Windows keyboard sim + iRacing camera switch via broadcast messages
├── voiceInput.js          # Global hotkey hooks (uiohook-napi), Whisper transcription via server proxy (with SAPI fallback), IPC coordination for voice chat
├── speechWorker.ps1       # PowerShell SAPI fallback (offline transcription) — used when server Whisper proxy unreachable
├── control-panel.html     # Sidebar settings (search, Favorites, Recent, Broadcasting, Race/Car/Track/Stream, Account/Updates/Logs/About)
├── installer.nsh          # Custom NSIS script to kill running app before install
├── package.json           # Electron 28, ws, pako, @emiliosp/node-iracing-sdk, uiohook-napi, electron-updater
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
    ├── flags.html         # Flags — animated waving SVG for green/yellow/blue/white/black/checkered with priority ladder + blue throttle
    ├── chat.html          # Streaming chat — Twitch channel overlay
    ├── voicechat.html     # Voice chat — Whisper API transcription, push-to-talk, gamepad support
    ├── combined.html      # Single-window mode host (v3.28.0+) — fullscreen iframe container, opt-in via settings.singleWindowMode
    ├── overlay-utils.js   # Shared overlay utilities — header toggle, drag, click-through, CSS scale (single source for all overlays)
    └── helmets/           # Racing helmet PNG icons (2 styles) for driver card
├── tests/                  # Overlay UI/UX test infrastructure
│   ├── serve.js           # Test server — serves overlays with mocked Node.js APIs + mock WebSocket
│   ├── mock-data.js       # Realistic mock data for all WebSocket channels (4 scenarios)
│   ├── overlays.spec.js   # Playwright tests — bounds, scales, fonts, headers (496 tests)
│   ├── playground.html    # Interactive visual playground for manual overlay testing
│   ├── gallery.js         # Screenshot gallery server for reviewing test results
│   └── playwright.config.js # Separate Playwright config for bridge tests
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
- **Dual Auth System:** Two independent auth systems: Discord OAuth (Streamer product) and username/password with bcrypt (Racing product). Session middleware loads both `req.streamer` and `req.racingUser`, cross-loading linked accounts. Sessions table has both `streamer_id` and `racing_user_id` columns (nullable). Racing accounts stored in `racing_users` table with username (case-insensitive), password_hash, iracing_name, bridge_id, avatar (base64, 128×128 JPEG via interactive crop editor), display_name. Account linking: Racing → Discord via OAuth callback detection, or Discord → Racing. Linked accounts see both product sections in sidebar.
- **Racing Auth Routes:** `/racing/auth/signup` (form + JSON for Bridge), `/racing/auth/login` (form redirect), `/racing/auth/login-api` (JSON for Bridge app), `/racing/auth/logout`. Bridge login screen (`bridge/login.html`) shown on startup if `settings.racingUsername` is not set. Login rate limiting with account locking.
- **Homepage:** `/` always shows two product cards (Streamer + Racing), no redirect. `/streamer` = Streamer landing with Discord login. `/racing` = Racing dashboard (if logged in) or login form (if not).
- **Auth flows (Streamer):** Discord OAuth login → Twitch linking → broadcaster auth (EventSub scopes) → bot account (global env var) → YouTube OAuth (streamer account for live detection) → Spotify OAuth (streamer account for !song)
- **Session Capture Pipeline:** Bridge's `sessionRecorder.js` captures per-lap data + 10Hz telemetry traces during P/Q/R/Offline Testing sessions. Progressive upload: session created on first lap (`POST /api/session`), each subsequent lap appended immediately (`POST /api/session/:id/lap`), session finalized on end (`PATCH /api/session/:id/finish`). Telemetry stored as gzip-compressed JSON arrays (pako) in `lap_telemetry` table. DB tables: `racing_sessions` (session metadata, privacy, share tokens), `session_laps` (per-lap data), `lap_telemetry` (compressed traces). Failed uploads queued to `pending-sessions.json` and retried on next startup.
- **Track Database Page:** Standalone page at `/tracks` (accessible to both Streamer and Racing users). Grid/list view of all tracks. Detail page with Practice/Race tabs. Practice tab shows recorded practice sessions. Race tab shows class-based race type statistics + recorded race sessions. Sessions expandable inline to show lap details (time, delta, fuel, temp). Import Race Data via modal popup (JSON/CSV/screenshot). 152 known iRacing tracks with category tags.
- **YouTube Shorts:** Detected via YouTube Data API duration check (≤60s), separate notification format
- **User feedback:** Star rating + message on account page, visible in admin Feedback tab
- **Admin panel:** Accessible via Admin tab on dashboard (admin-only), tabbed UI with Stats/Users/Issues/Feedback/Discounts/Testing
- **Custom Overlays (DISABLED):** Template-based scene banners, info bars, and custom alerts controlled via chat commands. Code exists (`customOverlays.js`, `scenes.js`, `bar.js`, `custom-alerts.js`, `custom-overlays.ejs`) but all integrations are commented out in `server.js`, `overlay.js`, `twitchChat.js`, `dashboard.ejs`, `overlay-builder.ejs`, `overlay-config.ejs`, and `overlay.css`. DB table `custom_overlays` exists. Re-enable by uncommenting the marked sections.
- **Sponsor Overlay (separate source):** Sponsors have their own OBS browser source at `/overlay/sponsors/TOKEN` via `sponsors.js`, independent from the main alert overlay.
- **iRacing Bridge (Electron Desktop App):** Standalone Windows app (`bridge/`) that reads iRacing telemetry via `@emiliosp/node-iracing-sdk` (koffi FFI to shared memory) and displays transparent always-on-top overlays. WebSocket server on port 9100 with channel-based subscriptions (fuel 10Hz, wind 10Hz, proximity 10Hz, standings 1Hz, relative 2Hz, trackmap 2Hz). Overlays: Standings (class-grouped, configurable columns/header, estimated iRating gain/loss, per-class SOF, per-class max cars), Relative (configurable columns/header, focusCar centering, behind-closest-first order), Fuel Calculator (avg/lap, laps of fuel, fuel to finish for timed AND lap races, session time estimation), Wind Direction (km/h or mph, configurable colors, follows focused driver heading), Track Map (square canvas, wind chevron arrow, focused driver green highlight), Driver Inputs (toggleable: trace graph, pedal bars, gear, speed, steering wheel), Race Duration (time remaining, estimated laps with multiclass awareness + pit stop time deduction), Driver Card (focused driver: helmet icon, country flag, name, position, iRating change, class badge, best/last lap), Session Laps (all laps with P/Q/R session tags, fastest in purple, delta to best), Weather (animated sun/rain/clouds/fog based on humidity/precipitation, track time, temps, wind), Stream Chat, Voice Chat (Whisper API, push-to-talk, gamepad). Overlays are frameless, transparent, `alwaysOnTop: 'screen-saver'` with 2-second re-assert interval. Draggable via IPC-based mouse handling (mousedown/mousemove on header → `drag-overlay` IPC). Position configurable via X/Y settings with live preview. Settings persisted to `~/Documents/Atleta Racing/settings.json` (legacy `~/Documents/Atleta Bridge/` directory auto-migrated on first launch of v3.26.0+). Auto-updater via `electron-updater` with Windows system notifications. Proper semver versioning. Built with GitHub Actions (`.github/workflows/build-bridge.yml`) producing NSIS Windows installer. Version from `package.json` (no auto-increment).
- **Bridge Control Panel (v3.24+):** Sidebar-based settings window (1000x750, maximizable). Sidebar layout (top to bottom): live `🔎 Search overlays…` field → `⊞ Overview` / `★ Favorites` / `🕒 Recent` / `📡 Broadcasting` (all card-grid pages sharing the same renderer) → divider → categorized accordions (`Race`, `Car`, `Track`, `Stream`) collapsed by default with persisted state → spacer → `Account`, `Updates`, `Logs`, `About` anchored at the bottom. Each per-overlay panel still has the existing sub-tabs (General/Header/Content for standings/relative), drag-to-reorder columns, configurable session header items, font size, row height, position X/Y. The shared overlay card on Overview/Favorites/Recent shows icon + name + enable toggle + ⚙ jump-to-settings + ★ favorite. ⌘K / Ctrl+K focuses the search field from anywhere in the panel. Search dims non-matching rows and auto-expands groups containing matches. UI state persists in `settings.json` under three keys: `uiFavorites`, `uiRecent` (max 5), `uiSidebarGroups`. Pure data helpers (`pushRecent`, `toggleFavorite`, `pruneStaleIds`) live in `bridge/sidebarState.js` with a `node:test` suite. The 📡 Broadcasting page lets the user toggle which teams see live telemetry (replaces the old Overview "Team Broadcasting" section); re-renders on every navigation so the toggle state always reflects the persisted `pitwallBroadcastTeamIds`.
- **Bridge Driver Selection:** Click a driver row in standings → iRacing camera switches to them via broadcast message API (`IRSDK_BROADCASTMSG` / `CamSwitchNum`). Standings/relative highlight follows selection (green for spectated, purple for player). Track map shows focused driver as green dot. Wind overlay uses focused driver's estimated heading. Selection resets when iRacing camera changes (2s grace period) or player enters car.
- **Bridge Session Management:** Detects session changes via `SESSION_NUM`. Clears cached data on practice→qualify transitions. Keeps data on qualify→race. Excludes spectators (`IsSpectator`) and pace cars from standings. Session laps overlay clears on session number change.
- **Bridge Pit Time Tracking:** Measures pit stop time loss per class by detecting `CAR_IDX_ON_PIT_ROAD` transitions. When a driver exits pit and completes the pit lap, delta = pitLapTime - bestLap. Running average per class with 5-120s sanity bounds. Persisted per track to `~/Documents/Atleta Racing/pittimes.json` — accumulates over time, loaded on session start so future races at the same track have historical pit data.
- **Bridge Race Duration:** Multiclass-aware timed race prediction. Uses overall leader's last lap (race pace) to determine when checkered falls: `totalTimeToCheckered = timeRemain + overallLeaderLastLap`. Focus class laps = `floor((totalTime - pitTimeLoss) / focusClassPace)`. Pit stops estimated from fuel data (fuel/lap vs tank capacity). Shows `~20 (1p)` format when pit stops are factored in. Window height is `170px` by default to fit the v3.23.0 incident counter footer (3 rows: off-tracks / penalties / slow laps with attributed time loss). Saved height < 170 is auto-migrated on startup. Footer is toggleable via the `Incident counters` checkbox in the raceduration panel (default on).
- **Bridge Incident Counters (v3.23+):** Per-session tracker for off-tracks, penalties, and slow laps with attributed time loss. Lives in `bridge/incidentTracker.js` as a self-contained factory module (no electron/SDK imports — testable). Telemetry.js calls `tick()` per poll, `onLapComplete()` from the existing lap-completion block, `onSessionChange()` from the session-num-change block, and embeds `getState()` into the `session` WS channel payload as `data.incidents`. Detection rules: **off-track** = any positive delta in `PlayerCarMyIncidentCount` (v3.25.3+; the earlier surface-window gate silently dropped brief 4-wheel-offs that slipped between 10Hz polls). **Penalty** = edge transition into `CarIdxSessionFlags[playerCarIdx]` bits `0x10000` (black), `0x100000` (meatball/repair), `0x80000` (furled/move-over). **Slow lap** = lap time > `max(2.0s, cleanMedian × 5%)` slower than the rolling median of the last 5 valid clean laps. Time-loss attribution priority: penalty > offtrack > slow lap (so the three `timeLost` numbers sum to total time lost vs clean pace, no double counting). Counters carry over P→Q transitions and reset on entry into a Race session (`onSessionChange` detects via case-insensitive substring match on session type). 28 unit tests in `bridge/test-incidentTracker.js` cover detection logic + attribution + reset. The `raceduration.html` overlay renders the three counters as a footer block when `data.incidents` is present.
- **Bridge Flag Overlay (v3.26.7+):** `bridge/overlays/flags.html` — small draggable waving-SVG overlay for green/yellow/blue/white/black/checkered flags. State lives in `bridge/flagState.js` as a self-contained factory module (same pattern as `incidentTracker.js`), consumed by `telemetry.js` per poll and broadcast on a new `flags` WS channel. Priority ladder: **black > checkered > white > yellow > blue > green**. Minimum 3s on-screen dwell after iRacing clears a flag. Blue-flag cooldown: 15s after blue clears before it can re-trigger, preventing multi-class spam. Blue-dropout debounce of 300ms absorbs single-tick SDK polling races before committing to a cooldown. Client-side `showBlue` toggle hides blue entirely for drivers who don't want it. Unit tests in `bridge/test-flagState.js` (27 tests) cover priority, dwell, throttle, and dropout debounce. Run via `cd bridge && node --test test-incidentTracker.js test-sidebarState.js test-flagState.js` (70 tests total).
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
- **Voice Chat System:** Push-to-talk (global hotkey via `uiohook-napi` with key-down/key-up detection, supports keyboard keys, mouse side buttons, and gamepad buttons via Gamepad API) and wake word ("message") always-listening mode. Whisper transcription via **server-side proxy** at `POST /api/bridge/whisper` (added v3.22.2) — Bridge uploads raw WAV bytes via Node `https.request`, server forwards multipart to OpenAI, returns transcribed text. The OpenAI key never leaves the server. Auth via session cookie OR `?bridge_id=<uuid>` query param against `racing_users.bridge_id`. Bridge falls back to PowerShell SAPI (`speechWorker.ps1`) on Windows if the proxy is unreachable. Bridge feature-detects via `GET /api/bridge/config` which returns `{ whisperProxyEnabled: boolean }` (no auth required — public health check, no secrets in response). Users can also bring their own OpenAI key via `settings.voiceChat.openaiKey` which short-circuits the proxy. Voice parsing: "all [text]", "number [#] [text]", "[name] [text]", "team [text]" with Levenshtein fuzzy matching. Confirmation UI. Sends to iRacing via `keyboardSim.js` — clipboard paste into iRacing chat. Configurable chat open key (T/Y/U/Enter).
- **Team Pitwall:** Live telemetry sharing with teammates. Users can be in up to 5 teams simultaneously. DB tables: `teams` (name, owner, invite_code, picture, banner), `team_members` (team_id, user_id, role — `UNIQUE(team_id, user_id)`), `team_invites`. Query functions: `getTeamsForUser(userId)` returns array of all memberships, `countTeamsForUser(userId)` for max-5 cap, `getTeamForUser(userId)` returns first team (backward compat). Routes at `/racing/teams` (list), `/racing/teams/:teamId` (detail), old `/racing/team` redirects. WebSocket relay (`pitwallRelay.js`): Bridge connects to `/ws/bridge` with userId + pitwall_token, receives team list, sends `set-teams` to choose which teams see telemetry (multi-select, persisted to Bridge settings as `pitwallBroadcastTeamIds`). Pitwall viewers connect to `/ws/pitwall` via session cookie, send `select-team` to pick which team to watch, then `subscribe` to channels + `view-driver` to select a driver. Relay stores `teamIds: Set` per bridge client, filters data via `driverClient.teamIds.has(viewer.teamId)`. Throttle rates per channel (inputs 50ms, standings/fuel/session 250ms, relative/wind/trackmap 150ms). Pitwall page (`/racing/pitwall`) uses gridstack.js for free-form drag/resize/toggle layout with localStorage persistence. Overlay iframes use `?pitwall=1` param to detect pitwall mode — listen for `postMessage` from parent page instead of opening WebSocket. Parent pitwall page has single WS connection to relay, forwards `data` messages to iframes via `postMessage`. Users can view own telemetry. Shows team picker if 2+ teams, skips to pitwall if 1 team, redirects to `/racing/teams` if 0. Bridge control panel has a dedicated `📡 Broadcasting` sidebar tab (v3.25.0+) with one card per team and a toggle each — re-renders on every navigation so the toggle state always reflects the persisted `pitwallBroadcastTeamIds`. Card grid pattern matches Favorites/Recent. Talks to main via the `get-pitwall-teams` / `set-pitwall-broadcast` / `pitwall-teams` IPC channels (renderer cannot `require('./pitwallUplink')` directly because renderer windows get separate module instances). **Pitwall Edit Mode (v3.26.3+):** the pitwall page has a discoverable `✎ Edit Layout` button in the top bar next to the ⚙ settings gear. Clicking it applies an `.editing` class to `#pitwall-grid` which: adds a 2px purple border + drag grip strip at the top of every tile, makes all eight gridstack resize handles visible (`handles: 'n,e,s,w,ne,nw,se,sw'`), and — crucially — shows a transparent `.pitwall-iframe-shield` div on top of each iframe to intercept clicks gridstack would otherwise lose to the iframe's own document. The shield is the linchpin; without it, drag handles feel invisible because the iframe swallows every pointer event except the 1px tile border. Gridstack config uses `float: true` (dropped panels stay where you put them) and `maxRow: 10` (so resizes can't push panels past the bottom of the viewport where they'd be unreachable). Escape exits edit mode — but the pre-existing document-level Escape handler that navigates to `/racing/teams` is guarded with `if (isEditing) return;` so edit mode owns Escape entirely when active. Layout persists in `localStorage.pitwall-gridstack-v2`; `loadLayout()` clamps any saved item with `y + h > 10` on load to recover layouts that were saved before `maxRow` was enforced. The old `Lock Layout` button in the settings panel was removed — edit mode replaces it. `racing-pitwall.ejs:addWidget()` injects `.pitwall-drag-strip` and `.pitwall-iframe-shield` into every tile's content template; both are `display: none` by default and only shown under `#pitwall-grid.editing`.
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
- `EMAIL_USER`, `EMAIL_PASS` — Gmail + App Password for password reset emails (optional, admin can generate reset links manually)
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
- Session data API endpoints (`POST /api/session`, `POST /api/session/:id/lap`, `PATCH /api/session/:id/finish`, `GET /api/sessions/:trackName`, `GET /api/session/:id`, `GET /api/session/share/:token`) are public — placed BEFORE auth middleware
- Racing auth endpoints (`/racing/auth/*`) are public. Racing dashboard routes (`/racing/*` except `/` and `/signup`) require `req.racingUser`
- Team routes mounted at `/racing/teams` (not `/racing/team`). Old `/racing/team` URL redirects to `/racing/teams`. Team detail routes use `/racing/teams/:teamId/...` pattern (invite, kick, leave, delete, picture, banner). Max 5 teams per user enforced in both routes and DB transaction functions.
- Team customization: owners can upload team picture (circular, 128×128 JPEG, base64 in `teams.picture`) and banner (800×200 JPEG, base64 in `teams.banner`) via interactive crop editors on team detail page. Same UX pattern as avatar crop editor on `racing-account.ejs`. Permission check uses `role === 'owner' || role === 'admin'` (admin role future-proofed but not yet implemented). `_getTeamMemberships` query returns `team_picture` and `team_banner` aliases.
- Pitwall relay (`pitwallRelay.js`) initialized in `src/index.js` via `pitwallRelay.init(httpServer)`. Bridge uplink (`bridge/pitwallUplink.js`) connects to `wss://atletanotifications.com/ws/bridge`. Bridge persists `pitwallBroadcastTeamIds` array in settings.json.
- Pitwall overlay iframes: loaded with `?pitwall=1&driver=ID`. Overlays detect `PITWALL_MODE` and use `window.addEventListener('message')` instead of WebSocket. Parent page forwards relay data via `postMessage`. All `require()` calls in overlays wrapped in try/catch for browser compatibility.
- Pitwall static route `/pitwall/overlays/*` (`src/server.js:64-74`) uses **split Cache-Control headers**: `.html`/`.js` get `no-cache, no-store, must-revalidate` so deploys ship fresh overlay code immediately, but all other assets (SVG flags, PNG helmets, CSS, images) get `public, max-age=3600`. Without the split, `relative.html` and `standings.html` rebuild their row HTML via `innerHTML = rows.join('')` every 2Hz/1Hz respectively, each rebuild destroys+recreates every `<img class="flag-img">`, and `no-store` forced a fresh network round-trip per img — producing a visible flicker on every country flag. Keep this split in place if you ever change static-file headers.
- Bridge control panel is a renderer process — communicates with main process via IPC, NOT `require('./module')` (renderer gets separate module instances). Team broadcast uses `get-pitwall-teams` / `set-pitwall-broadcast` / `pitwall-teams` IPC channels.
- Bridge logout: IPC `logout` handler clears credentials from settings, calls `app.relaunch()` + `app.quit()`.
- Password reset: `password_reset_tokens` table (user_id, token, expires_at, used). Self-service via email (`nodemailer` + Gmail) at `/racing/auth/forgot` → `/racing/auth/reset`. Admin can generate 24h reset links via Racing admin panel "Reset PW" button (`POST /racing/admin/reset-password/:id`). Also available as API at `POST /admin/racing-reset-password` (requires Discord admin auth).
- Standings gap columns: in qualifying/practice, gap and gapLdr show best lap time difference to class leader. In race, show time-based `gapToLeader`. Controlled by `_isRaceSession` flag from session data `eventType`. Relative overlay uses the same `_isRaceSession` flag to gate the red/blue lap-diff name coloring — in P/Q, drivers with different lap counts are not treated as lapped (since everyone joins at different times and lap count gaps are meaningless outside a race). Must be declared near the top of the script alongside `let ws`/`let bridgeConnected` — declaring it below the top-level `renderDemo…()` call causes a temporal dead zone crash that silently stops `connectBridge()` from running and leaves the overlay stuck showing "Demo Mode".
- `racing_users` table uses `COLLATE NOCASE` for username (case-insensitive login)
- `racing_sessions` table is separate from web auth `sessions` table. Query functions: `getRacingSessionById` (not `getSessionById`), `deleteRacingSession` (not `deleteSession`) to avoid collision with web auth session functions
- Bridge overlay drag/click-through: ALL overlays use `overlay-utils.js` as single source. No inline drag/click-through handlers in overlay HTML files.
- Bridge overlay scale: `applyScale()` in overlay-utils.js uses CSS `transform: scale()` + `overflow: visible` without locking dimensions. ResizeObserver re-syncs window size when content changes.
- Bridge auto-updater checks once, 5 seconds after startup. The per-minute `setInterval` was removed in v3.26.4 to cut background CPU/network on race machines — updates are picked up on next launch instead. Remote log upload (`uploadLogs` in `main.js`) also throttled from 60s to 5 min in v3.26.5 for the same reason.
- Bridge broadcast throttling (v3.27.0+): three layers cut hot-path work without changing what overlays/viewers see. (1) `bridge/pitwallUplink.js:sendTelemetry` short-circuits when `broadcastTeamIds.length === 0` (no point sending to nobody) and applies a per-channel rate limit that **must mirror** `src/services/pitwallRelay.js:THROTTLE` — anything sent faster is discarded server-side anyway. Update both maps together if you tune one. (2) `bridge/telemetry.js:broadcastToChannel` applies a `LOCAL_THROTTLE` map to data events for slow-changing channels (standings 4Hz, fuel 2Hz, wind/trackmap/proximity 10Hz, session 4Hz); `inputs` is uncapped because the trace graph genuinely needs 30Hz; `relative` is already gated to 6Hz at its broadcast site (`pollCount % 5`); `flags` only fires on state change; status/`_all` events bypass the throttle. (3) `bridge/websocket.js:broadcastToChannel` skips `JSON.stringify` allocation when `clients.size === 0`. The poll loop itself still runs at 30Hz — only the broadcasts are throttled — because the SDK refresh feeds session-change detection, lap recording, and pit timing which all need full rate.
- Bridge always-on-top re-assert (v3.27.0+): a single shared `_globalTopInterval` in `bridge/main.js` iterates `overlayWindows` (and `combinedWindow` if open) every 2s and calls `setAlwaysOnTop(true, 'screen-saver')` for each. Replaces the old per-overlay setInterval-per-window pattern. `ensureGlobalTopInterval()` starts it on overlay creation; `maybeStopGlobalTopInterval()` clears it when the last overlay AND combined window are gone. Keep it as one timer — N overlays × N timers was wasted work for identical cadence.
- Bridge single-window mode (v3.28.0+): experimental architecture that hosts every overlay (except `voicechat`) as an `<iframe>` inside one fullscreen transparent click-through window (`bridge/overlays/combined.html`) instead of N separate `BrowserWindow`s. Single Electron renderer process for the entire overlay set — cuts per-overlay-window RAM (each `BrowserWindow` is ~50–150MB) down to one shared process. Enabled by setting `singleWindowMode: true` in `~/Documents/Atleta Racing/settings.json` (no UI toggle in v3.28.0; UI lands in a follow-up). The combined window uses `webPreferences.nodeIntegrationInSubFrames: true` so each iframe still gets `require('electron')` for `overlay-utils.js`. `set-ignore-mouse` IPC works unchanged because iframe `event.sender` resolves to the parent window. `drag-overlay`, `auto-resize-height`, `resize-overlay-wh` IPCs no-op when `isFromCombinedWindow(event)` is true (would resize/move the wrong target — the host window covers the whole screen). Per-overlay IPCs that take an `overlayId` (`move-overlay`, `resize-overlay`, `resize-overlay-height`, `get-overlay-position`, `save-overlay-settings`, `reset-overlay`) check `combinedOverlayIds.has(overlayId)` and forward to `combined.html` via `combinedSend(...)` instead of operating on a `BrowserWindow`. Voice chat always falls through to a classic per-window because `voiceInput.js` holds a window reference for global hotkey + audio routing. Drag-to-position is **not** supported in single-window mode v1 — user uses the control panel X/Y inputs; drag IPCs from inside iframes are intentionally dropped (would move the entire host window). `persistSettings()` writes the union of `Object.keys(overlayWindows)` and `combinedOverlayIds` into `settings.enabledOverlays` so combined-mode entries survive restart. Toggling `singleWindowMode` requires app restart in v1.
- Bridge overlays hidden on startup when autoHide is on (shown when iRacing connects)
- iRacing WindDir from SDK is the SOURCE direction (N = wind coming FROM north). No flip needed in overlays.
- Race types use proper case: `VRS Sprint`, `VRS Open`, `VRS Endurance`, `IMSA Sprint`, `IMSA Open`, `IMSA Endurance`, `Global Endurance`, `Regionals`, `LMP2 Sprint`, `Proto Sprint`. DB migration normalizes old snake_case on startup.
- Bridge telemetry `getRaceType()` returns proper case directly (no snake_case)
- Bridge UI state for the v3.24+ sidebar redesign lives in `settings.json` under three top-level keys: `uiFavorites: string[]`, `uiRecent: string[]` (max 5), `uiSidebarGroups: { race, car, track, stream }` (booleans, true = collapsed). Loaded by main.js after `loadSettings()`, exposed via `get-ui-state` (sync IPC) / `save-ui-state` (async IPC, partial-patch merge). Pure data helpers in `bridge/sidebarState.js` are the only place that mutate the arrays.
- Bridge `bridge/incidentTracker.js` is a self-contained factory module — `createIncidentTracker()` returns `{ init, tick, onLapComplete, onSessionChange, getState, reset }`. Telemetry.js calls all of them. The module is pure JS (no electron, no SDK imports) so it can be unit-tested with `node:test`. Run via `cd bridge && node --test test-incidentTracker.js test-sidebarState.js test-flagState.js` (70 tests total).
- Bridge Whisper proxy: `POST /api/bridge/whisper` accepts raw WAV bytes (≤5MB), forwards to OpenAI Whisper, returns `{ text }`. Auth via session cookie OR `?bridge_id=<uuid>` query param against `racing_users.bridge_id`. The OPENAI key never ships to clients. `GET /api/bridge/config` returns `{ whisperProxyEnabled }` only — no auth required, no secrets in response.
- `OPENAI_API_KEY` env var is optional but required for the Whisper proxy. Without it, voice chat falls back to PowerShell SAPI on Windows.
- SQLite pragmas applied at startup in `src/db.js`: `journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`, `cache_size=-64000`, `temp_store=MEMORY`, `mmap_size=256MB`. Hot-path indexes on `subscriptions(streamer_id, status)`, `watched_channels(twitch_username)`, `watched_youtube_channels(youtube_channel_id)`.
- `process.on('unhandledRejection')` and `uncaughtException` handlers in `src/index.js` log and continue (long-running server must not crash on a single bad promise).
- Token refresh paths in `src/services/twitch.js` and `src/services/spotify.js` use in-flight promise locks (per-streamer for spotify, single global for twitch app auth) to prevent concurrent callers from racing parallel refresh requests.
- `src/services/chatModeration.js` in-memory Maps (`permits`, `lastMessages`, `followCache`, `offenseCounts`) sweep stale entries every 60s with `.unref()` so they don't hold the process.
- `.dockerignore` excludes `node_modules`, `.git`, `data`, `bridge/*` (but **re-includes `bridge/overlays` + `bridge/overlays/**` at the bottom of the file** so the pitwall iframes can be served from `/pitwall/overlays/*` on Railway — without this, helmet PNGs and flag SVGs would also fall under the global `*.png` rule), `docs`, `tests`, `*.png`, `bun.lock`, `.playwright-mcp`, `.superpowers`, `.env*`. Keeps the Railway image lean (577MB `bridge/` tree is mostly Electron node_modules) while still shipping the 3.4MB overlay HTML/SVG/CSS/JS the pitwall needs.
- `.worktrees/` is gitignored — used for isolated branches during subagent-driven development.

## Bridge Overlay Testing

Automated UI/UX test infrastructure in `bridge/tests/`:
- `node bridge/tests/serve.js` — test server that serves overlays with mocked Node.js APIs (require, electron, fs) + mock WebSocket for data injection. Each overlay rendered at its real Electron window dimensions from `main.js` OVERLAYS array.
- `node bridge/tests/gallery.js` — screenshot gallery server at `http://localhost:9401` with filterable grid view
- `cd bridge/tests && npx playwright test --config=playwright.config.js` — 496 automated tests across 14 overlays (trackmap excluded — canvas with aspect-ratio:1)
- Tests cover: bounds at 6 scales × 3 scenarios, 4 font sizes, header toggle × 3 scales, 6 stress combos, data rendering, scale visibility
- `bridge/tests/playground.html` — interactive visual playground with all overlays in a grid

## Overlay Consistency Rule

**The overlay builder (`overlay-builder.ejs`) is the source of truth for how alerts look.** The actual OBS overlay (`overlay.js` + `overlay.css`), the overlay config preview (`overlay-config.ejs` iframe), and the builder preview must all render cards identically:

- **Card structure:** All event types must use the same HTML structure: `top-accent` + `card-body` (with `wrapWithSideIcons`) + `car-track`. No event-specific custom sections (e.g., no crowd sections for raid, no missing car tracks for subscription).
- **Screen effects:** Direction-based effects (up/down/left/right) must work in both the builder preview (`renderScreenEffect()` in overlay-builder.ejs) and the OBS overlay (`spawnEffects()` in overlay.js). CSS classes for effects must NOT hardcode positional properties (`top`, `left`, etc.) — positions are set dynamically by JS based on direction.
- **Design application:** `applyCustomDesign()` in overlay.js and `updatePreview()` in overlay-builder.ejs must apply the same visual properties (colors, fonts, sizes, border-radius, animations, side icons).
- **When adding/changing any visual property:** Update all three rendering paths — builder preview, OBS overlay `generateCardHTML()`/`applyCustomDesign()`, and the EVENT_DEFAULTS in the builder.


## Team Activity Log

This section is the shared coordination surface for the dev team (team-leader + frontend-dev + backend-dev + team-security + team-qa + team-ux + team-deployment). Every team member reads the last few entries before working and appends one entry after.

Format per entry:

```
### YYYY-MM-DD HH:MM — <role>
**Task:** <one line>
**Files:** <comma-separated paths or "none">
**Decisions:** <2-4 bullets the next teammate needs to know>
**Open:** <followups, or "none">
```

(No entries yet — the next `/dev-team` round will append here.)
