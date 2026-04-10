const Anthropic = require('@anthropic-ai/sdk').default;
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');

const BRIDGE_DIR = path.join(__dirname, '..', '..', 'bridge');

// Bridge source files to include in context
const BRIDGE_FILES = [
  'main.js', 'telemetry.js', 'websocket.js', 'settings.js',
  'fuel-calculator.js', 'relative.js', 'keyboardSim.js',
  'voiceInput.js', 'sessionRecorder.js', 'trackExtractor.js',
];

const OVERLAY_DIR = path.join(BRIDGE_DIR, 'overlays');

function loadBridgeSources() {
  const sources = [];

  for (const file of BRIDGE_FILES) {
    const filePath = path.join(BRIDGE_DIR, file);
    if (fs.existsSync(filePath)) {
      sources.push({ file: `bridge/${file}`, content: fs.readFileSync(filePath, 'utf8') });
    }
  }

  const cpPath = path.join(BRIDGE_DIR, 'control-panel.html');
  if (fs.existsSync(cpPath)) {
    sources.push({ file: 'bridge/control-panel.html', content: fs.readFileSync(cpPath, 'utf8') });
  }

  if (fs.existsSync(OVERLAY_DIR)) {
    const overlays = fs.readdirSync(OVERLAY_DIR).filter(f => f.endsWith('.html'));
    for (const file of overlays) {
      sources.push({
        file: `bridge/overlays/${file}`,
        content: fs.readFileSync(path.join(OVERLAY_DIR, file), 'utf8'),
      });
    }
  }

  const racingPath = path.join(__dirname, '..', 'routes', 'racing.js');
  if (fs.existsSync(racingPath)) {
    sources.push({ file: 'src/routes/racing.js', content: fs.readFileSync(racingPath, 'utf8') });
  }

  return sources;
}

function loadScreenshots(issueId, screenshotNames) {
  const images = [];
  const issueDir = path.join(__dirname, '..', '..', 'data', 'issues', String(issueId));
  if (!screenshotNames || !fs.existsSync(issueDir)) return images;

  const files = screenshotNames.split(',').filter(Boolean);
  for (const file of files) {
    const filePath = path.join(issueDir, file);
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath);
      const ext = path.extname(file).slice(1).toLowerCase();
      const mediaType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      images.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: data.toString('base64') },
      });
    }
  }
  return images;
}

const SYSTEM_PROMPT = `You are a senior developer triaging a bug report for Atleta Bridge, an Electron desktop app for iRacing sim racing. The app reads iRacing telemetry via shared memory (node-iracing-sdk) and displays transparent always-on-top overlays (standings, relative, fuel, wind, track map, driver card, session laps, weather, inputs, race duration, voice chat, etc.). It has a WebSocket server on port 9100, a control panel for settings, and session recording.

Your job:
1. Analyze the bug description and any screenshots provided
2. Search the source code to identify the likely root cause — cite specific file(s) and line(s)
3. Assess whether you can produce a reliable fix
4. If fixable, produce a JSON patch array with exact string replacements

Respond with ONLY valid JSON (no markdown fences):
{
  "summary": "Brief 1-2 sentence diagnosis",
  "root_cause": "Detailed explanation — which file, what code, why it fails",
  "can_fix": true or false,
  "confidence": "high" or "medium" or "low",
  "patch": [
    {
      "file": "bridge/main.js",
      "old": "exact existing code to replace (copy-paste from source)",
      "new": "replacement code"
    }
  ],
  "notes": "Caveats, things to watch, or testing suggestions"
}

If you cannot fix it, set can_fix to false, patch to [], and explain why in notes.
Keep patches minimal — fix only what's broken, don't refactor surrounding code.`;

async function analyzeIssue(issueId) {
  const issue = db.getIssueById(issueId);
  if (!issue) throw new Error('Issue not found');

  console.log(`[AgentTriage] Analyzing issue #${issueId}: ${issue.subject}`);
  db.updateIssueAgentStatus(issueId, 'analyzing');

  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const sources = loadBridgeSources();
  const sourceContext = sources.map(s => `--- ${s.file} ---\n${s.content}`).join('\n\n');

  const content = [];

  const screenshots = loadScreenshots(issueId, issue.screenshots);
  for (const img of screenshots) {
    content.push(img);
  }

  content.push({
    type: 'text',
    text: `## Bug Report\n\n**Subject:** ${issue.subject}\n\n**Description:** ${issue.description}\n\n**Reported by:** ${issue.discord_username}\n\n## Source Code\n\n${sourceContext}`,
  });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6-20250514',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  });

  const text = response.content.find(b => b.type === 'text')?.text || '';

  let analysis;
  try {
    const cleaned = text.replace(/^```json?\s*\n?/m, '').replace(/\n?```\s*$/m, '');
    analysis = JSON.parse(cleaned);
  } catch (e) {
    analysis = { summary: 'Failed to parse AI response', root_cause: text, can_fix: false, confidence: 'low', patch: [], notes: 'Raw response saved' };
  }

  db.updateIssueAnalysis(issueId, JSON.stringify(analysis), 'done');
  console.log(`[AgentTriage] Issue #${issueId} analyzed: can_fix=${analysis.can_fix}, confidence=${analysis.confidence}`);
  return analysis;
}

module.exports = { analyzeIssue };
