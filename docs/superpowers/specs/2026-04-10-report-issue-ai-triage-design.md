# Report Issue with Screenshots + AI Agent Triage — Design Spec

## Summary

Extend the existing report issue feature with screenshot uploads (max 3 per report) and an automated AI triage pipeline. When a user submits a bug report, Claude analyzes the report + screenshots + relevant bridge source code, produces a diagnosis and (if possible) a patch. The admin dashboard shows the AI analysis and a "Fix It" button that applies the patch, creates a branch, commits, pushes, and opens a PR on GitHub. Scoped to the racing/bridge part of the app only.

## 1. Screenshot Upload

### Database

Add `screenshots TEXT` column to `issues` table. Stores comma-separated filenames (e.g., `shot_1712345678.png,shot_1712345679.jpg`). `NULL` means no screenshots.

### Storage

- Directory: `data/issues/<issueId>/`
- Persistent volume (same pattern as `data/sounds/`, `data/sponsors/`, `data/avatars/`)
- Static route: `app.use('/issues-files', express.static(path.join(__dirname, '..', 'data', 'issues')))`
- Served as `/issues-files/<issueId>/<filename>`

### Report Form Changes (`report-issue.ejs`)

- Add drag-and-drop zone below the description textarea
- File input accepts `image/png, image/jpeg, image/gif, image/webp`
- Client-side validation: max 3 files, max 5MB each
- Show thumbnail previews with remove (X) button before submit
- Form submission via `fetch()` with sequential raw-body uploads:
  1. First POST uploads issue text (subject + description) → returns `{ ok: true, issueId }`
  2. Then POST each screenshot to `/dashboard/report/<issueId>/screenshot?ext=png` as raw body
  3. On completion, redirect to success page
- This follows the existing raw-body upload pattern (sponsors, avatars)

### Routes

- `POST /dashboard/report` — changed from form redirect to JSON response returning `{ ok: true, issueId }`. Saves subject + description, returns the new issue ID.
- `POST /dashboard/report/:id/screenshot` — new endpoint. Accepts raw body image. Query param `ext` for extension. Saves to `data/issues/<id>/`. Updates the `screenshots` column (appends filename). Max 3 enforced server-side.

## 2. AI Agent Triage

### Trigger

After all screenshots are uploaded (or immediately if none), the client calls `POST /dashboard/report/:id/analyze`. This kicks off an async Claude API call. The response returns immediately with `{ ok: true, status: 'analyzing' }`. The analysis runs in the background.

### Claude API Call

**Model:** `claude-sonnet-4-6` (fast, capable enough for code analysis)

**Input:**
- Issue subject and description (text)
- Screenshots as base64-encoded images (vision input)
- Bridge source files as text context. Files included:
  - `bridge/main.js`
  - `bridge/telemetry.js`
  - `bridge/websocket.js`
  - `bridge/settings.js`
  - `bridge/fuel-calculator.js`
  - `bridge/relative.js`
  - `bridge/keyboardSim.js`
  - `bridge/voiceInput.js`
  - `bridge/sessionRecorder.js`
  - `bridge/trackExtractor.js`
  - `bridge/control-panel.html`
  - All `bridge/overlays/*.html` files
- If the report mentions server-side racing features, also include:
  - `src/routes/racing.js`
  - Racing-related sections of `src/db.js`

**System prompt:** Instructs Claude to act as a senior developer triaging a bug report for the Atleta Bridge (Electron iRacing app). Must:
1. Analyze the bug description and screenshots
2. Identify the likely root cause with file + line references
3. Assess whether it can produce a reliable fix
4. If fixable, produce a JSON patch array: `[{ "file": "bridge/main.js", "old": "exact old code", "new": "replacement code" }]`
5. Respond in a structured JSON format

**Response format:**
```json
{
  "summary": "Brief diagnosis of the problem",
  "root_cause": "Detailed explanation of what's wrong and where",
  "can_fix": true,
  "confidence": "high|medium|low",
  "patch": [
    {
      "file": "bridge/main.js",
      "old": "the exact code to replace",
      "new": "the replacement code"
    }
  ],
  "notes": "Any caveats or things to watch for"
}
```

### Database

Add columns to `issues` table:
- `agent_analysis TEXT` — full JSON response from Claude
- `agent_status TEXT DEFAULT NULL` — `'analyzing'`, `'done'`, `'error'`

### Admin Dashboard Changes

In the Issues tab, for issues with `agent_status = 'done'`:
- Show a collapsible "AI Analysis" section below the description
- Display: summary, root cause, confidence badge (green/yellow/red)
- If `can_fix = true`: show a "Fix It" button
- If `can_fix = false`: show the analysis as informational only
- While `agent_status = 'analyzing'`: show a spinner with "AI is analyzing..."

## 3. Auto-Fix Pipeline

### Trigger

`POST /admin/issues/:id/fix` — admin-only endpoint.

### Process

1. Read the stored `agent_analysis` JSON, extract the `patch` array
2. For each patch entry:
   - Read the target file from disk
   - Verify the `old` string exists in the file (safety check)
   - Replace `old` with `new`
   - Write the file back
3. If all patches apply cleanly:
   - Create branch: `fix/issue-<id>-<slugified-subject>` (max 50 chars)
   - Stage changed files
   - Commit with message: `fix: <issue subject> (auto-fix from issue #<id>)`
   - Push branch to origin
   - Create PR via GitHub API (`POST /repos/:owner/:repo/pulls`)
   - Update issue: `status = 'in_progress'`, store PR URL in `admin_reply`
4. If any patch fails to apply:
   - Roll back all file changes
   - Return error to admin with details of which patch failed
   - Do NOT create branch/commit

### Git Operations

Uses `child_process.execSync` for git commands (simple, synchronous, server-side only). The server must have git available and the repo must be a git checkout (true on Railway with Docker).

### GitHub API

Uses `GITHUB_TOKEN` with the GitHub REST API via `https` (no extra dependency). Endpoints needed:
- `POST /repos/{owner}/{repo}/pulls` — create PR

Repository owner/repo derived from git remote URL or configured as `GITHUB_REPO` env var.

## 4. Environment Variables

Add to `src/config.js`:
- `ANTHROPIC_API_KEY` — required for AI triage
- `GITHUB_TOKEN` — required for auto-fix (push + PR creation)
- `GITHUB_REPO` — optional, defaults to parsing from git remote (format: `owner/repo`)

## 5. Dependencies

- `@anthropic-ai/sdk` — Anthropic SDK for Claude API calls (add to `package.json`)
- No other new dependencies. GitHub API called via native `https`.

## 6. File Changes Summary

| File | Change |
|------|--------|
| `src/db.js` | Add `screenshots`, `agent_analysis`, `agent_status` columns to `issues` table. Update `createIssue` to return `lastInsertRowid`. Add `updateIssueScreenshots`, `updateIssueAnalysis` functions. |
| `src/config.js` | Add `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `GITHUB_REPO` |
| `src/routes/dashboard.js` | Rewrite `POST /report` to return JSON. Add `POST /report/:id/screenshot`. Add `POST /report/:id/analyze`. |
| `src/routes/admin.js` | Add `POST /admin/issues/:id/fix` endpoint |
| `src/views/report-issue.ejs` | Add drag-and-drop screenshot upload zone, thumbnail previews, fetch-based submission |
| `src/views/admin-dashboard.ejs` | Add AI analysis display, "Fix It" button, analyzing spinner |
| `src/server.js` | Add `/issues-files` static route |
| `src/services/agentTriage.js` | New file — Claude API call logic, prompt construction, source file loading |
| `src/services/autoFix.js` | New file — patch application, git operations, GitHub PR creation |
| `package.json` | Add `@anthropic-ai/sdk` dependency |
