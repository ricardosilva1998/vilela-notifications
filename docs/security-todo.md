# Security TODO — Remaining Vulnerabilities

Last audited: 2026-04-11

## High Priority

### 1. OpenAI API Key Exposed via API
- **File:** `src/server.js` (GET `/api/bridge/config`)
- **Issue:** Returns `process.env.OPENAI_API_KEY` to any authenticated user. Bridge voice chat uses it client-side for Whisper API calls.
- **Fix:** Build a server-side Whisper transcription proxy (`POST /api/bridge/transcribe` accepting audio, calling OpenAI server-side, returning text). Then remove the key from the config endpoint. Requires updating `bridge/voiceInput.js` to use the proxy instead of direct OpenAI calls.
- **Complexity:** High — voice chat pipeline refactor

### 2. Electron nodeIntegration:true + contextIsolation:false
- **Files:** `bridge/main.js` (lines 139, 397, 463 — all BrowserWindow creations)
- **Issue:** All windows (login, control panel, overlays) have full Node.js access. Combined with any XSS, an attacker gets filesystem + shell access.
- **Fix:** Set `nodeIntegration: false`, `contextIsolation: true`. Create preload scripts that expose only needed APIs via `contextBridge.exposeInMainWorld()`. Refactor all 18 overlay HTML files to use the exposed API instead of `require()`.
- **Complexity:** High — every overlay uses `require('fs')`, `require('path')`, `require('os')`, `require('electron').ipcRenderer`

### 3. Windows Code Signing Disabled
- **File:** `bridge/package.json` (`"signAndEditExecutable": false`)
- **Issue:** Bridge EXE is not code-signed. Users get Windows SmartScreen warnings. A MITM could serve fake updates.
- **Fix:** Purchase a Windows code signing certificate (EV recommended for SmartScreen reputation). Configure in `electron-builder` config and GitHub Actions secrets.
- **Complexity:** Medium — needs certificate purchase + CI config

### 4. CSRF Protection Missing on POST Endpoints
- **Files:** `src/routes/racing-team.js` (create, invite, kick, leave, delete), `src/routes/tip.js` (donation form)
- **Issue:** No CSRF tokens on form submissions. Attacker can forge POST requests via malicious links/images.
- **Fix:** Add CSRF middleware (e.g., `csrf-csrf` or `csurf`). Generate token per-session, embed in hidden form fields, validate on POST.
- **Complexity:** Medium — needs middleware + all forms updated

### 5. Pitwall Token in JSON Response
- **File:** `src/routes/racing-auth.js` (line 143, `/racing/auth/login-api`)
- **Issue:** `pitwallToken` returned in JSON. Could be logged, cached, or intercepted.
- **Fix:** Return token in HTTP-only cookie instead. Update `bridge/login.html` and `bridge/pitwallUplink.js` to read from cookie or use a separate token exchange.
- **Complexity:** Medium

## Medium Priority

### 6. Avatar Upload No Image Format Validation
- **File:** `src/routes/racing.js` (avatar endpoint)
- **Issue:** Only checks `data:image/` prefix and size. No magic byte validation.
- **Fix:** Decode base64, check first bytes for PNG (89 50 4E 47) / JPEG (FF D8 FF) / GIF (47 49 46) / WebP (52 49 46 46) headers.
- **Complexity:** Low

### 7. Overlay Token Rate Limiting
- **File:** `src/routes/overlay.js`
- **Issue:** No rate limiting on overlay SSE endpoint. Tokens could be enumerated.
- **Fix:** Add `express-rate-limit` middleware: 10 requests/min per IP on `/overlay/events/:token`.
- **Complexity:** Low

### 8. Session Expiry Not Extended on Activity
- **Files:** `src/server.js`, `src/routes/racing-auth.js`
- **Issue:** Sessions expire after 7 days regardless of activity.
- **Fix:** On each authenticated request, extend `expires_at` by 7 days if less than 1 day remaining.
- **Complexity:** Low

### 9. Timing Oracle on Username Existence
- **File:** `src/routes/racing-auth.js` (login endpoints)
- **Issue:** User-not-found returns faster than wrong-password (bcrypt compare is slow).
- **Fix:** On user-not-found, do a dummy `bcrypt.compare('x', DUMMY_HASH)` before returning.
- **Complexity:** Low

## Low Priority

### 10. Bridge ID in URL Query String
- **File:** `bridge/overlays/spotify.html`
- **Issue:** Bridge ID sent as `?bridge_id=...` in GET request. Logged in server access logs, referrer headers.
- **Fix:** Use POST with body instead of GET with query params. Add `Referrer-Policy: no-referrer`.
- **Complexity:** Low

### 11. Socket.io-client CVEs (Transitive)
- **Package:** `socket.io-client` → `parseuri` (ReDoS)
- **Issue:** 3 moderate CVEs in transitive dependency. No fix available without major version upgrade.
- **Fix:** Wait for upstream fix or replace StreamElements socket.io with direct API/WebSocket.
- **Complexity:** High (StreamElements integration rewrite)

## Completed (for reference)

- ✅ Team invite codes: 4 bytes → 16 bytes base64url
- ✅ User search: rate limited 10/min, removed iracing_name from results
- ✅ Bridge ID: UUID format validation on Spotify endpoints
- ✅ WebSocket: driver team validation before spectating
- ✅ Tip page: removed query param fallback (XSS)
- ✅ PayPal order ID: format validation
- ✅ Sponsor upload: extension whitelist + 5MB limit
- ✅ Sound upload: 10MB size limit
- ✅ XSS: driver names escaped in standings + relative overlays
- ✅ XSS: track/artist names escaped in Spotify overlay
- ✅ XSS: album art URL validated as HTTPS
- ✅ XSS: team names escaped in control panel
- ✅ XSS: release notes escaped in control panel
- ✅ Electron: permissions restricted to media/microphone/clipboard
- ✅ Dependencies: 5 CVEs fixed via npm audit fix
- ✅ Global `_esc()` HTML escape function in overlay-utils.js
