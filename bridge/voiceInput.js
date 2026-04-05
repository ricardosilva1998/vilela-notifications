'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { ipcMain } = require('electron');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const { sendChatCommand, setChatKey } = require('./keyboardSim');

// Map key names to VK codes + scan codes
const CHAT_KEY_MAP = {
  'T': { vk: 0x54, scan: 0x14 },
  'Y': { vk: 0x59, scan: 0x15 },
  'U': { vk: 0x55, scan: 0x16 },
  'Enter': { vk: 0x0D, scan: 0x1C },
};

const logPath = path.join(os.homedir(), 'atleta-bridge.log');
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
let autoStopTimer = null;
let settings = {};
let getIracingStatus = null;

// ─── Whisper Speech Recognition ──────────────────────────────
let whisperPipeline = null;
let whisperLoading = false;

async function initWhisper() {
  if (whisperPipeline || whisperLoading) return;
  whisperLoading = true;
  log('[Whisper] Loading model (whisper-tiny.en)...');

  try {
    const { pipeline, env } = await import('@xenova/transformers');
    const cacheDir = path.join(os.homedir(), 'Documents', 'Atleta Bridge', 'whisper-models');
    env.cacheDir = cacheDir;
    env.allowLocalModels = true;

    const startTime = Date.now();
    whisperPipeline = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
      quantized: true,
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log('[Whisper] Model loaded in ' + elapsed + 's');

    if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
      voiceChatWindow.webContents.send('voice-whisper-ready');
    }
  } catch(e) {
    log('[Whisper] Failed to load: ' + e.message);
    if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
      voiceChatWindow.webContents.send('voice-error', 'Whisper model failed to load: ' + e.message);
    }
  }
  whisperLoading = false;
}

async function transcribeWav(wavPath) {
  if (!whisperPipeline) {
    log('[Whisper] Pipeline not ready, initializing...');
    await initWhisper();
    if (!whisperPipeline) {
      log('[Whisper] Still not ready, aborting');
      if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
        voiceChatWindow.webContents.send('voice-error', 'Whisper not ready');
      }
      return;
    }
  }

  log('[Whisper] Transcribing: ' + wavPath);
  const startTime = Date.now();

  try {
    // Read WAV file and extract PCM audio as Float32Array
    const wavBuffer = fs.readFileSync(wavPath);
    const audioData = decodeWav(wavBuffer);

    const result = await whisperPipeline(audioData, {
      language: 'english',
      task: 'transcribe',
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const transcript = (result.text || '').trim();
    log('[Whisper] Result (' + elapsed + 's): "' + transcript + '"');

    // Clean up temp file
    try { fs.unlinkSync(wavPath); } catch(e) {}

    if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
      voiceChatWindow.webContents.send('voice-transcript', transcript);
    }
  } catch(e) {
    log('[Whisper] Transcription error: ' + e.message);
    try { fs.unlinkSync(wavPath); } catch(e2) {}
    if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
      voiceChatWindow.webContents.send('voice-error', 'Transcription failed: ' + e.message);
    }
  }
}

/**
 * Decode a WAV file buffer to Float32Array of audio samples.
 */
function decodeWav(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  // Parse WAV header
  const numChannels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  // Find data chunk
  let dataOffset = 44; // standard WAV header
  const dataSize = view.getUint32(40, true);
  const numSamples = dataSize / (bitsPerSample / 8) / numChannels;

  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const offset = dataOffset + i * numChannels * (bitsPerSample / 8);
    if (bitsPerSample === 16) {
      samples[i] = view.getInt16(offset, true) / 32768;
    } else if (bitsPerSample === 32) {
      samples[i] = view.getFloat32(offset, true);
    }
  }

  log('[Whisper] Audio: ' + sampleRate + 'Hz, ' + bitsPerSample + 'bit, ' + numSamples + ' samples (' + (numSamples / sampleRate).toFixed(1) + 's)');
  return samples;
}

// ─── Voice Input System ──────────────────────────────────────
function startVoiceInput(opts) {
  settings = opts.settings;
  getIracingStatus = opts.getStatus;

  if (settings.voiceChat && settings.voiceChat.pushToTalkKey) {
    applyPushToTalkKey(settings.voiceChat.pushToTalkKey);
  }

  // Apply saved chat key
  if (settings.voiceChat && settings.voiceChat.chatKey && CHAT_KEY_MAP[settings.voiceChat.chatKey]) {
    const k = CHAT_KEY_MAP[settings.voiceChat.chatKey];
    setChatKey(k.vk, k.scan);
  }

  // Whisper loads lazily on first transcription (pre-loading uses too much memory)

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

  // IPC: Overlay sends recorded WAV file for transcription
  ipcMain.on('voice-wav-ready', (event, wavPath) => {
    transcribeWav(wavPath);
  });

  // IPC: Manual stop from overlay button
  ipcMain.on('voice-manual-stop', () => {
    isRecording = false;
    if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
    log('[VoiceInput] Manual stop from overlay');
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
    // Apply chat key setting
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
      // Tell overlay current Whisper status
      if (whisperPipeline) {
        win.webContents.send('voice-whisper-ready');
      } else if (whisperLoading) {
        win.webContents.send('voice-whisper-loading');
      }
    });
  }
}

function stopVoiceInput() {
  try { uIOhook.stop(); } catch(e) {}
  log('[VoiceInput] Stopped');
}

module.exports = { startVoiceInput, stopVoiceInput, setVoiceChatWindow };
