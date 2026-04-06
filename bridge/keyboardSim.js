'use strict';

const fs = require('fs');
const path = require('path');
const logPath = path.join(require('os').homedir(), 'atleta-bridge.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(msg);
  try { fs.appendFileSync(logPath, line); } catch(e) {}
}

const isWindows = process.platform === 'win32';

let sendInputFn = null;
let keybdEventFn = null;
let findWindowA = null;
let setForegroundWindow = null;
let INPUT_size = 0;
let _switchCamera = null;

// Windows constants
const INPUT_KEYBOARD = 1;
const KEYEVENTF_UNICODE = 0x0004;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_SCANCODE = 0x0008;
const VK_RETURN = 0x0D;

// Default chat key — configurable
let chatOpenVK = 0x54; // T key
let chatOpenScan = 0x14; // T scan code

if (isWindows) {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');

    const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
      wVk: 'uint16',
      wScan: 'uint16',
      dwFlags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uintptr',
    });

    const INPUT = koffi.struct('INPUT', {
      type: 'uint32',
      ki: KEYBDINPUT,
    });

    INPUT_size = koffi.sizeof(INPUT);

    const _sendInput = user32.func('SendInput', 'uint32', ['uint32', koffi.pointer(INPUT), 'int32']);
    sendInputFn = function(input) { return _sendInput(1, input, INPUT_size); };

    // Also load keybd_event as fallback (some games prefer it over SendInput)
    keybdEventFn = user32.func('keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uintptr']);

    log('[KeyboardSim] Loaded SendInput + keybd_event');

    try {
      findWindowA = user32.func('FindWindowA', 'void*', ['void*', 'str']);
      setForegroundWindow = user32.func('SetForegroundWindow', 'int32', ['void*']);
      log('[KeyboardSim] Loaded FindWindow + SetForegroundWindow');
    } catch(e2) {
      log('[KeyboardSim] FindWindow not available: ' + (e2.message || e2));
    }

    // iRacing broadcast messages for camera control
    try {
      const registerWindowMessageA = user32.func('RegisterWindowMessageA', 'uint32', ['str']);
      const sendMessageA = user32.func('SendNotifyMessageA', 'int32', ['intptr', 'uint32', 'uintptr', 'uintptr']);
      const iracingMsgId = registerWindowMessageA('CYCLESEATCHANGEMSG');
      if (iracingMsgId) {
        log('[KeyboardSim] iRacing broadcast msg ID: ' + iracingMsgId);
        _switchCamera = function(carNumber, cameraGroup) {
          const HWND_BROADCAST = 0xFFFF;
          const wParam = 1; // irsdk_CSCamSwitchNum (switch by car number)
          const lParam = ((cameraGroup & 0xFFFF) << 16) | (carNumber & 0xFFFF);
          try {
            sendMessageA(HWND_BROADCAST, iracingMsgId, wParam, lParam);
            log('[KeyboardSim] Camera switch: car#' + carNumber + ' group=' + cameraGroup);
          } catch(e) {
            log('[KeyboardSim] Camera switch failed: ' + e.message);
          }
        };
      }
    } catch(e3) {
      log('[KeyboardSim] iRacing broadcast not available: ' + (e3.message || e3));
    }
  } catch (e) {
    log('[KeyboardSim] Failed to load: ' + (e.message || e));
  }
}

function focusIRacing() {
  if (!findWindowA || !setForegroundWindow) return false;
  const titles = ['iRacing.com Simulator', 'iRacing'];
  for (const title of titles) {
    try {
      const hwnd = findWindowA(null, title);
      if (hwnd) {
        setForegroundWindow(hwnd);
        log('[KeyboardSim] Focused: "' + title + '"');
        return true;
      }
    } catch(e) {}
  }
  log('[KeyboardSim] iRacing window not found');
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Press a key using keybd_event (better game compatibility than SendInput).
 */
async function pressKeyViaEvent(vk, scan) {
  if (!keybdEventFn) return;
  keybdEventFn(vk, scan, 0, 0); // key down
  await sleep(30);
  keybdEventFn(vk, scan, KEYEVENTF_KEYUP, 0); // key up
  await sleep(30);
}

/**
 * Paste text using clipboard + Ctrl+V (most reliable for game chat boxes).
 */
async function pasteText(str) {
  const { clipboard } = require('electron');
  const oldClip = clipboard.readText();
  clipboard.writeText(str);
  await sleep(50);
  // Ctrl+V via keybd_event
  if (keybdEventFn) {
    keybdEventFn(0x11, 0x1D, 0, 0); // Ctrl down (VK=0x11, scan=0x1D)
    await sleep(30);
    keybdEventFn(0x56, 0x2F, 0, 0); // V down (VK=0x56, scan=0x2F)
    await sleep(30);
    keybdEventFn(0x56, 0x2F, KEYEVENTF_KEYUP, 0); // V up
    await sleep(30);
    keybdEventFn(0x11, 0x1D, KEYEVENTF_KEYUP, 0); // Ctrl up
    await sleep(50);
  }
  // Restore clipboard after a delay
  setTimeout(() => { require('electron').clipboard.writeText(oldClip); }, 500);
}

/**
 * Set which key opens iRacing chat (configurable from settings).
 */
function setChatKey(vk, scan) {
  chatOpenVK = vk;
  chatOpenScan = scan || 0;
  log('[KeyboardSim] Chat key set: VK=0x' + vk.toString(16) + ' scan=0x' + (scan || 0).toString(16));
}

/**
 * Send a chat command to iRacing.
 * Focuses iRacing, opens chat, types command, presses Enter.
 */
async function sendChatCommand(command) {
  if (!isWindows || (!sendInputFn && !keybdEventFn)) {
    log('[KeyboardSim] Skipping (not Windows or no input method)');
    return false;
  }

  try {
    // Focus iRacing
    focusIRacing();
    await sleep(500);

    // Open chat using keybd_event
    log('[KeyboardSim] Opening chat (VK=0x' + chatOpenVK.toString(16) + ')...');
    await pressKeyViaEvent(chatOpenVK, chatOpenScan);
    await sleep(400);

    // Paste the command via clipboard + Ctrl+V (Unicode SendInput doesn't work in iRacing)
    log('[KeyboardSim] Pasting: ' + command);
    await pasteText(command);
    await sleep(100);

    // Send with Enter via keybd_event
    await pressKeyViaEvent(VK_RETURN, 0x1C);

    log('[KeyboardSim] Sent: ' + command);
    return true;
  } catch (e) {
    log('[KeyboardSim] Error: ' + (e.message || e));
    return false;
  }
}

function switchCamera(carNumber, cameraGroup) {
  if (_switchCamera) _switchCamera(carNumber, cameraGroup || 0);
}

module.exports = { sendChatCommand, setChatKey, switchCamera };
