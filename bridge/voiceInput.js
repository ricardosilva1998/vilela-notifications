'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');
const { ipcMain } = require('electron');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const { sendChatCommand, setChatKey } = require('./keyboardSim');

const SERVER_URL = 'https://atletanotifications.com';

const logPath = path.join(os.homedir(), 'atleta-bridge.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(msg);
  try { fs.appendFileSync(logPath, line); } catch(e) {}
}

const keyCodeToName = {};
Object.entries(UiohookKey).forEach(([name, code]) => { keyCodeToName[code] = name; });
const mouseButtonNames = { 1: 'Mouse1', 2: 'Mouse2', 3: 'Mouse3', 4: 'Mouse4', 5: 'Mouse5' };

const CHAT_KEY_MAP = {
  'T': { vk: 0x54, scan: 0x14 },
  'Y': { vk: 0x59, scan: 0x15 },
  'U': { vk: 0x55, scan: 0x16 },
  'Enter': { vk: 0x0D, scan: 0x1C },
};

let voiceChatWindow = null;
let pushToTalkKeyCode = null;
let pushToTalkIsMouseButton = false;
let pushToTalkMouseButton = null;
let pushToTalkIsGamepad = false;
let pushToTalkGamepadIndex = null;
let pushToTalkGamepadButton = null;
let autoStopTimer = null;
let settings = {};
let getIracingStatus = null;

// Speech Recognition: Whisper via server-side proxy, with Windows SAPI fallback
let scriptPath = null;
let whisperProxyEnabled = false;
function fetchServerConfig() {
  https.get(SERVER_URL + '/api/bridge/config', { timeout: 5000 }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      try {
        const config = JSON.parse(body);
        whisperProxyEnabled = !!config.whisperProxyEnabled;
        log('[Speech] Whisper proxy ' + (whisperProxyEnabled ? 'enabled' : 'disabled'));
      } catch(e) {}
    });
  }).on('error', () => {});
}

// Upload a WAV file to the server-side Whisper proxy. Resolves with the
// transcribed text on success, or null on failure (caller falls back to SAPI).
function transcribeViaProxy(wavPath, bridgeId) {
  return new Promise((resolve) => {
    let fileData;
    try { fileData = fs.readFileSync(wavPath); } catch (e) { return resolve(null); }
    const url = new URL(SERVER_URL + '/api/bridge/whisper' + (bridgeId ? '?bridge_id=' + encodeURIComponent(bridgeId) : ''));
    const req = https.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': fileData.length,
      },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          log('[Speech] Proxy returned ' + res.statusCode + ': ' + body.slice(0, 200));
          return resolve(null);
        }
        try { resolve(JSON.parse(body).text || ''); }
        catch (e) { resolve(null); }
      });
    });
    req.on('error', (e) => { log('[Speech] Proxy error: ' + e.message); resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(fileData);
    req.end();
  });
}

function findSpeechScript() {
  if (process.platform !== 'win32') return null;
  const candidates = [
    path.join(__dirname, 'speechWorker.ps1'),
    path.join(process.resourcesPath || __dirname, 'speechWorker.ps1'),
    __dirname.replace('app.asar', 'app.asar.unpacked') + path.sep + 'speechWorker.ps1',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      log('[Speech] Found script: ' + p);
      return p;
    }
  }
  log('[Speech] Script not found');
  return null;
}

async function transcribeWav(wavPath) {
  // Always try Whisper first — user-supplied key, then server proxy, then
  // SAPI fallback. The proxy probe at startup may not have completed yet
  // (or may have hit a transient 401), so we don't gate on it; the proxy
  // path returns null on failure and we fall through to SAPI.
  const userKey = (settings.voiceChat && settings.voiceChat.openaiKey) || '';
  const bridgeId = (settings && settings.racingBridgeId) || (settings && settings.bridgeId) || '';

  log('[Speech] Transcribing via ' + (userKey ? 'user Whisper key' : 'server proxy') + ': ' + wavPath);
  const text = userKey
    ? await transcribeViaUserKey(wavPath, userKey)
    : await transcribeViaProxy(wavPath, bridgeId);
  if (text != null) {
    try { fs.unlinkSync(wavPath); } catch(e) {}
    log('[Speech] Done: "' + text + '"');
    if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
      voiceChatWindow.webContents.send('voice-transcript', text);
    }
    return;
  }
  log('[Speech] Whisper path failed (bridgeId=' + (bridgeId ? 'present' : 'missing') + '), falling back to SAPI');

  if (!scriptPath) {
    log('[Speech] No script — cannot transcribe');
    try { fs.unlinkSync(wavPath); } catch(e) {}
    if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
      voiceChatWindow.webContents.send('voice-transcript', '');
    }
    return;
  }

  log('[Speech] Transcribing via SAPI: ' + wavPath);
  const args = ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', scriptPath, wavPath];
  const proc = spawn('powershell', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  let stdout = '';
  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => {
    d.toString().split('\n').forEach(line => {
      const t = line.trim();
      if (t) log('[Speech] ' + t);
    });
  });

  proc.on('exit', (code) => {
    const transcript = stdout.trim();
    log('[Speech] SAPI done (code ' + code + '): "' + transcript + '"');
    try { fs.unlinkSync(wavPath); } catch(e) {}
    if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
      voiceChatWindow.webContents.send('voice-transcript', transcript);
    }
  });
}

// User-provided OpenAI key path — keeps backwards compat with the old
// "bring your own key" setting.
function transcribeViaUserKey(wavPath, apiKey) {
  return new Promise((resolve) => {
    let fileData;
    try { fileData = fs.readFileSync(wavPath); } catch (e) { return resolve(null); }
    const boundary = '----atleta-' + Math.random().toString(16).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="language"\r\n\r\nen\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="speech.wav"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, fileData, tail]);
    const req = https.request({
      method: 'POST',
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/audio/transcriptions',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length,
      },
      timeout: 15000,
    }, (res) => {
      let respBody = '';
      res.on('data', (d) => { respBody += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(respBody).text || ''); }
        catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// Voice Input System
function startVoiceInput(opts) {
  settings = opts.settings;
  getIracingStatus = opts.getStatus;

  if (settings.voiceChat && settings.voiceChat.pushToTalkKey) {
    applyPushToTalkKey(settings.voiceChat.pushToTalkKey);
  }
  if (settings.voiceChat && settings.voiceChat.chatKey && CHAT_KEY_MAP[settings.voiceChat.chatKey]) {
    const k = CHAT_KEY_MAP[settings.voiceChat.chatKey];
    setChatKey(k.vk, k.scan);
  }

  scriptPath = findSpeechScript();
  fetchServerConfig(); // Get shared API key from Atleta server

  // Toggle mode: press once to start, press again to stop
  let isRecording = false;
  let lastToggleTime = 0;
  let recordingStartTime = 0;

  function handlePttToggle() {
    if (!isRecording) {
      isRecording = true;
      recordingStartTime = Date.now();
      log('[VoiceInput] PTT toggle → START');
      if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
        voiceChatWindow.webContents.send('voice-start-recording');
      }
      if (autoStopTimer) clearTimeout(autoStopTimer);
      autoStopTimer = setTimeout(() => {
        if (isRecording) {
          log('[VoiceInput] Auto-stop after 30s');
          isRecording = false;
          if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
            voiceChatWindow.webContents.send('voice-stop-recording');
          }
        }
      }, 30000);
    } else {
      // Ignore stop if recording started less than 2 seconds ago (prevents key repeat from stopping)
      if (Date.now() - recordingStartTime < 2000) {
        log('[VoiceInput] PTT toggle ignored (too soon, ' + (Date.now() - recordingStartTime) + 'ms)');
        return;
      }
      isRecording = false;
      if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
      log('[VoiceInput] PTT toggle → STOP');
      if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
        voiceChatWindow.webContents.send('voice-stop-recording');
      }
    }
  }

  // Track hook health — restart if it stops receiving events
  let lastHookEvent = Date.now();

  uIOhook.on('keydown', (e) => {
    lastHookEvent = Date.now();
    if (pushToTalkKeyCode !== null && !pushToTalkIsMouseButton && e.keycode === pushToTalkKeyCode) {
      const now = Date.now();
      if (now - lastToggleTime < 500) return;
      lastToggleTime = now;
      handlePttToggle();
    }
  });

  uIOhook.on('mousedown', (e) => {
    lastHookEvent = Date.now();
    if (pushToTalkIsMouseButton && e.button === pushToTalkMouseButton) {
      const now = Date.now();
      if (now - lastToggleTime < 500) return;
      lastToggleTime = now;
      handlePttToggle();
    }
  });

  function startHook() {
    try {
      uIOhook.start();
      log('[VoiceInput] Global hook started');
    } catch(e) {
      log('[VoiceInput] Hook start failed: ' + e.message);
    }
  }

  startHook();

  // Periodic health check — restart hook if no events for 60 seconds
  // (uiohook can silently die after getUserMedia captures audio)
  setInterval(() => {
    if (Date.now() - lastHookEvent > 60000) {
      log('[VoiceInput] Hook appears dead (no events for 60s), restarting...');
      try { uIOhook.stop(); } catch(e) {}
      // Reset recording state in case it was stuck
      if (isRecording) {
        isRecording = false;
        if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
        if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
          voiceChatWindow.webContents.send('voice-stop-recording');
        }
      }
      setTimeout(startHook, 500);
    }
  }, 15000);

  ipcMain.on('voice-wav-ready', (event, wavPath) => { transcribeWav(wavPath); });

  ipcMain.on('voice-manual-stop', () => {
    isRecording = false;
    if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
    log('[VoiceInput] Manual stop from overlay');
  });

  ipcMain.on('voice-send-chat', (event, data) => {
    const status = getIracingStatus ? getIracingStatus() : { iracing: false };
    if (!status.iracing) {
      log('[VoiceInput] Cannot send — iRacing not connected');
      if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
        voiceChatWindow.webContents.send('voice-send-result', { success: false, reason: 'iRacing not connected' });
      }
      return;
    }
    sendChatCommand(data.command).then(success => {
      if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
        voiceChatWindow.webContents.send('voice-send-result', { success });
      }
    });
  });

  ipcMain.on('voice-capture-key', (event) => {
    let captured = false;
    const onKey = (e) => {
      if (captured) return;
      captured = true;
      const keyName = keyCodeToName[e.keycode] || ('Key' + e.keycode);
      const keyData = { type: 'keyboard', keycode: e.keycode, name: keyName };
      applyPushToTalkKey(keyData);
      event.reply('voice-key-captured', keyData);
      uIOhook.off('keydown', onKey);
      uIOhook.off('mousedown', onMouse);
    };
    const onMouse = (e) => {
      if (captured) return;
      if (e.button <= 2) return;
      captured = true;
      const name = mouseButtonNames[e.button] || ('Mouse' + e.button);
      const keyData = { type: 'mouse', button: e.button, name };
      applyPushToTalkKey(keyData);
      event.reply('voice-key-captured', keyData);
      uIOhook.off('keydown', onKey);
      uIOhook.off('mousedown', onMouse);
    };
    uIOhook.on('keydown', onKey);
    uIOhook.on('mousedown', onMouse);
    // Also tell overlay to start scanning gamepads
    if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
      voiceChatWindow.webContents.send('voice-capture-gamepad-start');
    }
  });

  // Gamepad button captured from overlay renderer
  ipcMain.on('voice-gamepad-captured', (event, keyData) => {
    applyPushToTalkKey(keyData);
    // Forward to control panel
    if (event.sender) event.sender.send('voice-key-captured', keyData);
    // Also forward to whoever started capture
    log('[VoiceInput] Gamepad PTT set: ' + keyData.name);
  });

  // Gamepad PTT press/release from overlay renderer
  ipcMain.on('voice-gamepad-ptt', (event, pressed) => {
    if (!pushToTalkIsGamepad) return;
    lastHookEvent = Date.now(); // Keep hook health check happy
    const now = Date.now();
    if (now - lastToggleTime < 500) return;
    lastToggleTime = now;
    handlePttToggle();
  });

  ipcMain.on('voice-settings-update', (event, newSettings) => {
    if (!settings.voiceChat) settings.voiceChat = {};
    Object.assign(settings.voiceChat, newSettings);
    if (newSettings.chatKey && CHAT_KEY_MAP[newSettings.chatKey]) {
      const k = CHAT_KEY_MAP[newSettings.chatKey];
      setChatKey(k.vk, k.scan);
    }
    if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
      voiceChatWindow.webContents.send('voice-settings-update', settings.voiceChat);
    }
  });
}

function applyPushToTalkKey(keyData) {
  if (!keyData) return;
  pushToTalkIsMouseButton = false;
  pushToTalkIsGamepad = false;
  pushToTalkMouseButton = null;
  pushToTalkKeyCode = null;
  pushToTalkGamepadIndex = null;
  pushToTalkGamepadButton = null;

  if (keyData.type === 'mouse') {
    pushToTalkIsMouseButton = true;
    pushToTalkMouseButton = keyData.button;
  } else if (keyData.type === 'gamepad') {
    pushToTalkIsGamepad = true;
    pushToTalkGamepadIndex = keyData.gamepadIndex;
    pushToTalkGamepadButton = keyData.button;
  } else {
    pushToTalkKeyCode = keyData.keycode;
  }
  if (!settings.voiceChat) settings.voiceChat = {};
  settings.voiceChat.pushToTalkKey = keyData;
}

function setVoiceChatWindow(win) {
  voiceChatWindow = win;
  if (win && !win.isDestroyed()) {
    win.webContents.once('did-finish-load', () => {
      if (settings.voiceChat) win.webContents.send('voice-settings-update', settings.voiceChat);
    });
  }
}

function stopVoiceInput() {
  try { uIOhook.stop(); } catch(e) {}
  log('[VoiceInput] Stopped');
}

module.exports = { startVoiceInput, stopVoiceInput, setVoiceChatWindow };
