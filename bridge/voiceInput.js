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
let settings = {};
let getIracingStatus = null;

// Per-session speech process
let speechProcess = null;
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
  log('[Speech] Script not found in any location');
  return null;
}

function startListening() {
  if (!scriptPath) { log('[Speech] No script path'); return; }
  if (speechProcess) {
    // Kill previous session if still running
    try { speechProcess.kill(); } catch(e) {}
    speechProcess = null;
  }

  speechProcess = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', scriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  speechProcess.stdout.on('data', (data) => {
    const text = data.toString();
    stdout += text;
    // Check if we got the LISTENING signal
    if (text.includes('LISTENING')) {
      log('[Speech] Listening...');
    }
  });

  speechProcess.stderr.on('data', (data) => {
    // Diagnostic output from PowerShell
    const lines = data.toString().split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) log('[Speech] ' + trimmed);
    }
  });

  speechProcess.on('exit', (code) => {
    // Process the final stdout — last line is the recognized text
    const lines = stdout.trim().split('\n');
    const lastLine = lines[lines.length - 1]?.trim() || '';
    // Filter out the LISTENING marker
    const transcript = lastLine === 'LISTENING' ? '' : lastLine;

    log('[Speech] Session ended (code ' + code + '), transcript: "' + transcript + '"');

    if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
      voiceChatWindow.webContents.send('voice-transcript', transcript);
    }
    speechProcess = null;
  });

  log('[Speech] Session started');
}

function stopListening() {
  if (speechProcess) {
    log('[Speech] Killing speech process');
    // With synchronous Recognize(), we just kill the process on PTT release
    // The exit handler will read whatever stdout was produced
    try { speechProcess.kill(); } catch(e) {}
  }
}

function startVoiceInput(opts) {
  settings = opts.settings;
  getIracingStatus = opts.getStatus;

  if (settings.voiceChat && settings.voiceChat.pushToTalkKey) {
    applyPushToTalkKey(settings.voiceChat.pushToTalkKey);
  }

  // Find the speech script once
  scriptPath = findSpeechScript();

  // Global keyboard hook for push-to-talk
  uIOhook.on('keydown', (e) => {
    if (pushToTalkKeyCode !== null && !pushToTalkIsMouseButton && e.keycode === pushToTalkKeyCode) {
      if (!isKeyHeld) {
        isKeyHeld = true;
        log('[VoiceInput] PTT keydown (start)');
        startListening();
        if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
          voiceChatWindow.webContents.send('voice-state', 'listening');
        }
      }
    }
  });

  uIOhook.on('keyup', (e) => {
    if (pushToTalkKeyCode !== null && !pushToTalkIsMouseButton && e.keycode === pushToTalkKeyCode && isKeyHeld) {
      isKeyHeld = false;
      log('[VoiceInput] PTT keyup (stop)');
      stopListening();
    }
  });

  uIOhook.on('mousedown', (e) => {
    if (pushToTalkIsMouseButton && e.button === pushToTalkMouseButton && !isKeyHeld) {
      isKeyHeld = true;
      log('[VoiceInput] PTT mousedown (start)');
      startListening();
      if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
        voiceChatWindow.webContents.send('voice-state', 'listening');
      }
    }
  });

  uIOhook.on('mouseup', (e) => {
    if (pushToTalkIsMouseButton && e.button === pushToTalkMouseButton && isKeyHeld) {
      isKeyHeld = false;
      log('[VoiceInput] PTT mouseup (stop)');
      stopListening();
    }
  });

  uIOhook.start();
  log('[VoiceInput] Global hook started');

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
  if (speechProcess) { try { speechProcess.kill(); } catch(e) {} }
  log('[VoiceInput] Stopped');
}

module.exports = { startVoiceInput, stopVoiceInput, setVoiceChatWindow };
