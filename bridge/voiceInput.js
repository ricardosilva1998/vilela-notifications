'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ipcMain } = require('electron');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const { sendChatCommand } = require('./keyboardSim');

const logPath = path.join(require('os').homedir(), 'atleta-bridge.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(msg);
  try { fs.appendFileSync(logPath, line); } catch(e) {}
}

const keyCodeToName = {};
Object.entries(UiohookKey).forEach(([name, code]) => { keyCodeToName[code] = name; });
const mouseButtonNames = { 1: 'Mouse1', 2: 'Mouse2', 3: 'Mouse3', 4: 'Mouse4', 5: 'Mouse5' };

let voiceChatWindow = null;
let pushToTalkKeyCode = null;
let pushToTalkIsMouseButton = false;
let pushToTalkMouseButton = null;
let isKeyHeld = false;
let autoStopTimer = null;
let settings = {};
let getIracingStatus = null;
let scriptPath = null;

function findSpeechScript() {
  if (process.platform !== 'win32') return null;
  const candidates = [
    path.join(__dirname, 'speechWorker.ps1'),
    path.join(process.resourcesPath || __dirname, 'speechWorker.ps1'),
    path.join(__dirname, '..', 'speechWorker.ps1'),
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

/**
 * Transcribe a WAV file using Windows SAPI.
 * @param {string} wavPath - Path to the WAV file
 */
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
    log('[Speech] Transcription done (code ' + code + '): "' + transcript + '"');
    // Clean up temp file
    try { fs.unlinkSync(wavPath); } catch(e) {}

    if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
      voiceChatWindow.webContents.send('voice-transcript', transcript);
    }
  });
}

function startVoiceInput(opts) {
  settings = opts.settings;
  getIracingStatus = opts.getStatus;

  if (settings.voiceChat && settings.voiceChat.pushToTalkKey) {
    applyPushToTalkKey(settings.voiceChat.pushToTalkKey);
  }

  scriptPath = findSpeechScript();

  // Global keyboard hook for push-to-talk
  uIOhook.on('keydown', (e) => {
    if (pushToTalkKeyCode !== null && !pushToTalkIsMouseButton && e.keycode === pushToTalkKeyCode) {
      if (!isKeyHeld) {
        isKeyHeld = true;
        log('[VoiceInput] PTT keydown (start)');
        if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
          voiceChatWindow.webContents.send('voice-start-recording');
        }
        // Auto-stop after 15 seconds in case keyup is missed
        if (autoStopTimer) clearTimeout(autoStopTimer);
        autoStopTimer = setTimeout(() => {
          if (isKeyHeld) {
            log('[VoiceInput] Auto-stop after 15s timeout');
            isKeyHeld = false;
            if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
              voiceChatWindow.webContents.send('voice-stop-recording');
            }
          }
        }, 15000);
      }
    }
  });

  // Log ALL keyup events to diagnose missing keyup
  uIOhook.on('keyup', (e) => {
    if (pushToTalkKeyCode !== null && e.keycode === pushToTalkKeyCode) {
      log('[VoiceInput] Raw keyup: keycode=' + e.keycode + ' isKeyHeld=' + isKeyHeld + ' isMouse=' + pushToTalkIsMouseButton);
    }
    if (pushToTalkKeyCode !== null && !pushToTalkIsMouseButton && e.keycode === pushToTalkKeyCode && isKeyHeld) {
      isKeyHeld = false;
      if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
      log('[VoiceInput] PTT keyup (stop)');
      if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
        voiceChatWindow.webContents.send('voice-stop-recording');
      }
    }
  });

  uIOhook.on('mousedown', (e) => {
    if (pushToTalkIsMouseButton && e.button === pushToTalkMouseButton && !isKeyHeld) {
      isKeyHeld = true;
      log('[VoiceInput] PTT mousedown (start)');
      if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
        voiceChatWindow.webContents.send('voice-start-recording');
      }
    }
  });

  uIOhook.on('mouseup', (e) => {
    if (pushToTalkIsMouseButton && e.button === pushToTalkMouseButton && isKeyHeld) {
      isKeyHeld = false;
      log('[VoiceInput] PTT mouseup (stop)');
      if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
        voiceChatWindow.webContents.send('voice-stop-recording');
      }
    }
  });

  uIOhook.start();
  log('[VoiceInput] Global hook started');

  // IPC: Overlay sends recorded WAV file for transcription
  ipcMain.on('voice-wav-ready', (event, wavPath) => {
    transcribeWav(wavPath);
  });

  // IPC: Overlay sends confirmed chat command
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

  // IPC: Control panel requests to set push-to-talk key
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

  // IPC: Control panel updates voice settings
  ipcMain.on('voice-settings-update', (event, newSettings) => {
    if (!settings.voiceChat) settings.voiceChat = {};
    Object.assign(settings.voiceChat, newSettings);
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
  if (win && !win.isDestroyed() && settings.voiceChat) {
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('voice-settings-update', settings.voiceChat);
    });
  }
}

function stopVoiceInput() {
  try { uIOhook.stop(); } catch(e) {}
  log('[VoiceInput] Stopped');
}

module.exports = { startVoiceInput, stopVoiceInput, setVoiceChatWindow };
