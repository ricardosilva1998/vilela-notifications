'use strict';

/**
 * Keyboard simulator for typing into iRacing chat.
 * Uses koffi to call Windows SendInput API.
 * No-ops gracefully on non-Windows platforms.
 */

const isWindows = process.platform === 'win32';

let sendInput = null;
let INPUT_size = 0;

// Windows constants
const INPUT_KEYBOARD = 1;
const KEYEVENTF_UNICODE = 0x0004;
const KEYEVENTF_KEYUP = 0x0002;
const VK_RETURN = 0x0D;
const VK_T = 0x54;

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

    console.log('[KeyboardSim] Loaded Windows SendInput');
  } catch (e) {
    console.log('[KeyboardSim] Failed to load koffi/user32:', e.message);
    sendInput = null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Send a virtual key press (down + up).
 */
async function pressKey(vk) {
  if (!sendInput) return;
  const koffi = require('koffi');
  const KEYBDINPUT = koffi.resolve('KEYBDINPUT');
  const INPUT = koffi.resolve('INPUT');

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
  const koffi = require('koffi');

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
    console.log('[KeyboardSim] Skipping (not Windows or SendInput unavailable)');
    return false;
  }

  try {
    // Press T to open iRacing chat
    await pressKey(VK_T);
    // Wait for chat box to open
    await sleep(150);
    // Type the command using Unicode input
    await typeString(command);
    await sleep(50);
    // Press Enter to send
    await pressKey(VK_RETURN);
    console.log('[KeyboardSim] Sent: ' + command);
    return true;
  } catch (e) {
    console.log('[KeyboardSim] Error: ' + e.message);
    return false;
  }
}

module.exports = { sendChatCommand };
