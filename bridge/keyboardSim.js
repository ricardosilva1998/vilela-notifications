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

let sendInput = null;
let INPUT_size = 0;

// Windows constants
const INPUT_KEYBOARD = 1;
const KEYEVENTF_UNICODE = 0x0004;
const KEYEVENTF_KEYUP = 0x0002;
const VK_RETURN = 0x0D;
const VK_T = 0x54;

let findWindowA = null;
let setForegroundWindow = null;

if (isWindows) {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');

    // Define INPUT structure for keyboard
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

    sendInput = user32.func('SendInput', 'uint32', ['uint32', koffi.pointer(INPUT), 'int32']);

    // Helper to wrap the call
    const _sendInput = sendInput;
    sendInput = function(input) {
      return _sendInput(1, input, INPUT_size);
    };

    // Window focus functions for bringing iRacing to front
    findWindowA = user32.func('FindWindowA', 'pointer', ['string', 'string']);
    setForegroundWindow = user32.func('SetForegroundWindow', 'int32', ['pointer']);

    log('[KeyboardSim] Loaded Windows SendInput + SetForegroundWindow');
  } catch (e) {
    log('[KeyboardSim] Failed to load koffi/user32:', e.message);
    sendInput = null;
  }
}

/**
 * Try to bring iRacing window to the foreground.
 */
function focusIRacing() {
  if (!findWindowA || !setForegroundWindow) return false;
  // Try common iRacing window titles
  const titles = ['iRacing.com Simulator', 'iRacing'];
  for (const title of titles) {
    try {
      const hwnd = findWindowA(null, title);
      if (hwnd) {
        setForegroundWindow(hwnd);
        log('[KeyboardSim] Focused iRacing window: "' + title + '"');
        return true;
      }
    } catch(e) {}
  }
  log('[KeyboardSim] iRacing window not found, typing into current focus');
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Send a virtual key press (down + up).
 */
async function pressKey(vk) {
  if (!sendInput) return;
  const down = { type: INPUT_KEYBOARD, ki: { wVk: vk, wScan: 0, dwFlags: 0, time: 0, dwExtraInfo: 0 } };
  const up = { type: INPUT_KEYBOARD, ki: { wVk: vk, wScan: 0, dwFlags: KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 } };
  sendInput(down);
  await sleep(15);
  sendInput(up);
  await sleep(15);
}

/**
 * Type a string using Unicode characters (layout-independent).
 */
async function typeString(str) {
  if (!sendInput) return;
  for (let i = 0; i < str.length; i++) {
    const charCode = str.charCodeAt(i);
    const down = { type: INPUT_KEYBOARD, ki: { wVk: 0, wScan: charCode, dwFlags: KEYEVENTF_UNICODE, time: 0, dwExtraInfo: 0 } };
    const up = { type: INPUT_KEYBOARD, ki: { wVk: 0, wScan: charCode, dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 } };
    sendInput(down);
    await sleep(10);
    sendInput(up);
    await sleep(10);
  }
}

/**
 * Send a chat command to iRacing.
 * Opens chat with T, types the command, presses Enter.
 * @param {string} command - The full chat command (e.g., "/p Max Verstappen good race")
 */
async function sendChatCommand(command) {
  if (!isWindows || !sendInput) {
    log('[KeyboardSim] Skipping (not Windows or SendInput unavailable)');
    return false;
  }

  try {
    // Focus iRacing window before typing
    focusIRacing();
    await sleep(200);
    // Press T to open iRacing chat
    await pressKey(VK_T);
    // Wait for chat box to open
    await sleep(200);
    // Type the command using Unicode input
    await typeString(command);
    await sleep(50);
    // Press Enter to send
    await pressKey(VK_RETURN);
    log('[KeyboardSim] Sent: ' + command);
    return true;
  } catch (e) {
    log('[KeyboardSim] Error: ' + e.message);
    return false;
  }
}

module.exports = { sendChatCommand };
