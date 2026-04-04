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

// Build reverse lookup: keycode -> name
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

// Windows SAPI speech recognition worker
let speechProcess = null;
let speechReady = false;

function startSpeechWorker() {
  if (process.platform !== 'win32') {
    log('[Speech] Skipping — not Windows');
    return;
  }

  // Try multiple paths: dev (same dir), packaged (extraResources), asar-unpacked
  const candidates = [
    path.join(__dirname, 'speechWorker.ps1'),
    path.join(process.resourcesPath || __dirname, 'speechWorker.ps1'),
    path.join(__dirname, '..', 'speechWorker.ps1'),
    __dirname.replace('app.asar', 'app.asar.unpacked') + path.sep + 'speechWorker.ps1',
  ];
  let scriptPath = null;
  for (const p of candidates) {
    log('[Speech] Checking: ' + p + ' exists=' + fs.existsSync(p));
    if (fs.existsSync(p)) { scriptPath = p; break; }
  }
  if (!scriptPath) {
    log('[Speech] Worker script not found in any location');
    return;
  }
  log('[Speech] Using: ' + scriptPath);

  speechProcess = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', scriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let buffer = '';
  speechProcess.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line in buffer
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === 'READY') {
        speechReady = true;
        log('[Speech] Worker ready');
      } else if (trimmed === 'LISTENING') {
        log('[Speech] Listening...');
        if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
          voiceChatWindow.webContents.send('voice-state', 'listening');
        }
      } else if (trimmed.startsWith('RESULT:')) {
        const text = trimmed.substring(7).trim();
        log('[Speech] Result: "' + text + '"');
        if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
          voiceChatWindow.webContents.send('voice-transcript', text);
        }
      } else if (trimmed.startsWith('ERROR:')) {
        log('[Speech] Error: ' + trimmed.substring(6));
        if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
          voiceChatWindow.webContents.send('voice-error', trimmed.substring(6));
        }
      }
    }
  });

  speechProcess.stderr.on('data', (data) => {
    log('[Speech] stderr: ' + data.toString().trim());
  });

  speechProcess.on('exit', (code) => {
    log('[Speech] Worker exited: ' + code);
    speechReady = false;
    speechProcess = null;
    // Auto-restart after unexpected exit (not during app shutdown)
    if (!stopping) {
      log('[Speech] Auto-restarting worker in 2 seconds...');
      setTimeout(startSpeechWorker, 2000);
    }
  });

  log('[Speech] Worker spawned');
}

let stopping = false;

function stopSpeechWorker() {
  stopping = true;
  if (speechProcess) {
    try { speechProcess.stdin.write('EXIT\n'); } catch(e) {}
    setTimeout(() => {
      if (speechProcess) { try { speechProcess.kill(); } catch(e) {} }
    }, 1000);
  }
}

function startListening() {
  if (speechProcess && speechReady) {
    speechProcess.stdin.write('START\n');
  } else {
    log('[Speech] Worker not ready');
  }
}

function stopListening() {
  if (speechProcess && speechReady) {
    speechProcess.stdin.write('STOP\n');
  }
}

/**
 * Initialize the voice input system.
 */
function startVoiceInput(opts) {
  settings = opts.settings;
  getIracingStatus = opts.getStatus;

  if (settings.voiceChat && settings.voiceChat.pushToTalkKey) {
    applyPushToTalkKey(settings.voiceChat.pushToTalkKey);
  }

  // Start Windows SAPI speech worker
  startSpeechWorker();

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
  stopSpeechWorker();
  log('[VoiceInput] Stopped');
}

module.exports = { startVoiceInput, stopVoiceInput, setVoiceChatWindow };
