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
  log('[Speech] Transcribing: ' + wavPath);

  const proc = spawn('powershell', [
    '-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', scriptPath, wavPath
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

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

  // Toggle mode: press once to start, press again to stop
  let isRecording = false;
  let lastToggleTime = 0;

  function handlePttToggle() {
    if (!isRecording) {
      isRecording = true;
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
      isRecording = false;
      if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
      log('[VoiceInput] PTT toggle → STOP');
      if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
        voiceChatWindow.webContents.send('voice-stop-recording');
      }
    }
  }

  uIOhook.on('keydown', (e) => {
    if (pushToTalkKeyCode !== null && !pushToTalkIsMouseButton && e.keycode === pushToTalkKeyCode) {
      const now = Date.now();
      if (now - lastToggleTime < 500) return;
      lastToggleTime = now;
      handlePttToggle();
    }
  });

  uIOhook.on('mousedown', (e) => {
    if (pushToTalkIsMouseButton && e.button === pushToTalkMouseButton) {
      const now = Date.now();
      if (now - lastToggleTime < 500) return;
      lastToggleTime = now;
      handlePttToggle();
    }
  });

  uIOhook.start();
  log('[VoiceInput] Global hook started');

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
