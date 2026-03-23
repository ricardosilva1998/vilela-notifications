# Stream Notifications Bot

A self-service Discord notification bot for Twitch streamers. Any streamer can sign up, add the bot to their Discord, and configure notifications — no code changes needed.

## Features

| Feature | Source | Interval |
|---|---|---|
| Twitch live notifications | Twitch Helix API | 60s |
| Twitch clip notifications | Twitch Helix API | 5min |
| YouTube video notifications | YouTube RSS feed | 5min |
| YouTube live notifications | YouTube Data API | 2min |
| Welcome messages | Discord event | Instant |
| Subscriber role sync | Twitch Subscriptions API | 10min |

## How It Works

1. Streamer logs in with Twitch at the web dashboard
2. Adds the bot to their Discord server
3. Configures which channels get which notifications
4. Bot starts monitoring and sending notifications automatically

## Setup

### 1. Create a Discord Application

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Create a new application
3. Go to **Bot** tab → **Reset Token** → copy it (`DISCORD_TOKEN`)
4. Enable **Server Members Intent** under Privileged Gateway Intents
5. Go to **OAuth2** → note the **Client ID**

### 2. Create a Twitch Application

1. Go to [dev.twitch.tv/console](https://dev.twitch.tv/console)
2. Register a new application
3. Set **Client Type** to **Confidential**
4. Copy **Client ID** (`TWITCH_CLIENT_ID`) and generate a **Client Secret** (`TWITCH_CLIENT_SECRET`)
5. Add OAuth Redirect URLs:
   - `https://YOUR_APP_URL/auth/login/callback`
   - `https://YOUR_APP_URL/auth/broadcaster/callback`
   - `https://YOUR_APP_URL/auth/link/callback`

### 3. Deploy to Railway

1. Push this repo to GitHub
2. Create a new project on [Railway](https://railway.app/)
3. Deploy from the GitHub repo
4. **Attach a Volume** mounted at `/app/data` (for SQLite persistence)
5. Add environment variables:
   - `DISCORD_TOKEN`
   - `TWITCH_CLIENT_ID`
   - `TWITCH_CLIENT_SECRET`
   - `APP_URL` (your Railway public URL, e.g., `https://your-app.up.railway.app`)
   - `SESSION_SECRET` (any random string)
   - `PORT` = `3000`
6. Generate a public domain in Railway for the service

### 4. Update Twitch Redirect URLs

After you have your Railway URL, go back to the Twitch Developer Console and add the redirect URLs with your actual URL.

## Local Development

```bash
cp .env.example .env
# Fill in your credentials
npm install
npm run dev
```

## Architecture

- **Backend:** Node.js + Express + discord.js
- **Database:** SQLite (via better-sqlite3)
- **Frontend:** Server-rendered EJS templates
- **Hosting:** Railway with a persistent volume
