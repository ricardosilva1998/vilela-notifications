'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { ipcMain } = require('electron');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const { sendChatCommand, setChatKey } = require('./keyboardSim');

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
let autoStopTimer = null;
let settings = {};
let getIracingStatus = null;

// Speech Recognition via PowerShell SAPI (transcribes WAV files)
let scriptPath = null;

// Fetch shared API key from Atleta server (so users don't need their own)
let serverApiKey = '';
function fetchServerConfig() {
  const https = require('https');
  https.get('https://atletanotifications.com/api/bridge/config', { timeout: 5000 }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      try {
        const config = JSON.parse(body);
        if (config.openaiKey) {
          serverApiKey = config.openaiKey;
          log('[Speech] Got server API key');
        }
      } catch(e) {}
    });
  }).on('error', () => {});
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

function transcribeWav(wavPath) {
  if (!scriptPath) { log('[Speech] No script'); return; }
  // User's own key takes priority, then server-provided key
  const apiKey = (settings.voiceChat && settings.voiceChat.openaiKey) || serverApiKey || '';
  log('[Speech] Transcribing: ' + wavPath + (apiKey ? ' (Whisper API)' : ' (SAPI fallback)'));

  const args = ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', scriptPath, wavPath];
  if (apiKey) args.push(apiKey);

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
    log('[Speech] Done (code ' + code + '): "' + transcript + '"');
    try { fs.unlinkSync(wavPath); } catch(e) {}

    if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
      voiceChatWindow.webContents.send('voice-transcript', transcript);
    }
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
    const onKey = (e) => {
      const keyName = keyCodeToName[e.keycode] || ('Key' + e.keycode);
      const keyData = { type: 'keyboard', keycode: e.keycode, name: keyName };
      applyPushToTalkKey(keyData);
      event.reply('voice-key-captured', keyData);
      uIOhook.off('keydown', onKey);
      uIOhook.off('mousedown', onMouse);
    };
    const onMouse = (e) => {
      if (e.button <= 2) return;
      const name = mouseButtonNames[e.button] || ('Mouse' + e.button);
      const keyData = { type: 'mouse', button: e.button, name };
      applyPushToTalkKey(keyData);
      event.reply('voice-key-captured', keyData);
      uIOhook.off('keydown', onKey);
      uIOhook.off('mousedown', onMouse);
    };
    uIOhook.on('keydown', onKey);
    uIOhook.on('mousedown', onMouse);
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
  if (keyData.type === 'mouse') {
    pushToTalkIsMouseButton = true;
    pushToTalkMouseButton = keyData.button;
    pushToTalkKeyCode = null;
  } else {
    pushToTalkIsMouseButton = false;
    pushToTalkMouseButton = null;
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
