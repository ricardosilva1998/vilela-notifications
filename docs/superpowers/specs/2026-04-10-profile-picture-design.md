# Profile Picture Upload — Design Spec

## Summary

Allow users to upload a custom profile picture on the account settings page, replacing the Discord avatar everywhere it appears (nav bar, account page). Falls back to Discord avatar, then to initial letter.

## Database

Add `profile_picture TEXT` column to `streamers` table. Stores the filename (e.g., `avatar_1712345678.png`). `NULL` means "use Discord avatar fallback".

## Storage

- Directory: `data/avatars/<streamerId>/`
- Persistent volume (same as `data/sounds/`, `data/sponsors/`)
- Static route: `app.use('/avatars', express.static(path.join(__dirname, '..', 'data', 'avatars')))`
- Served as `/avatars/<streamerId>/<filename>`

## Upload Endpoint

`POST /dashboard/account/avatar` — raw body upload (same pattern as sponsor upload).

- Query params: `ext` (file extension)
- Accepts: jpg, jpeg, png, gif, webp
- Max size: enforced client-side (~2MB)
- Deletes previous avatar file if one exists
- Saves as `avatar_<timestamp>.<ext>`
- Updates `streamers.profile_picture` column
- Returns `{ ok: true, url: '/avatars/<id>/<filename>' }`

## Remove Endpoint

`DELETE /dashboard/account/avatar`

- Deletes the file from disk
- Sets `streamers.profile_picture = NULL`
- Returns `{ ok: true }`

## Avatar Resolution (all views)

Priority: `profile_picture` (custom upload) > `discord_avatar` > initial letter fallback.

Helper expression for the URL:
```
streamer.profile_picture
  ? '/avatars/' + streamer.id + '/' + streamer.profile_picture
  : streamer.discord_avatar
```

## UI (Account Page)

The existing 56px avatar in the profile header becomes interactive:

- Hover shows a semi-transparent overlay with a camera icon + "Change" text
- Click opens a hidden file input (accept: image/*)
- On file select: validate size (<2MB), upload via fetch, replace img src on success
- Small "Remove" link appears below avatar when a custom picture is set
- Toast/flash on success

## Affected Files

1. `src/db.js` — migration + update/clear prepared statements
2. `src/server.js` — static route for `/avatars`
3. `src/routes/dashboard.js` — POST upload + DELETE remove endpoints
4. `src/views/account.ejs` — interactive avatar with upload UI
5. `src/views/header.ejs` — avatar resolution (profile_picture > discord_avatar > letter)
