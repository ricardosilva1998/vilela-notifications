// Clear log file on startup (fresh logs each session)
try {
  const _fs = require('fs');
  const _logPath = require('path').join(require('os').homedir(), 'atleta-bridge.log');
  _fs.writeFileSync(_logPath, '--- App started ' + new Date().toISOString() + ' ---\n');
} catch(e) {}

// Catch uncaught exceptions to prevent crash dialogs (e.g., EBUSY from ibt files)
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err.message);
  try {
    const fs = require('fs');
    const logPath = require('path').join(require('os').homedir(), 'atleta-bridge.log');
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] [UNCAUGHT] ${err.message}\n`);
  } catch(e) {}
});

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, session, Notification } = require('electron');
const path = require('path');
const { startServer, stopServer } = require('./websocket');
const { startTelemetry, stopTelemetry } = require('./telemetry');
const { load: loadSettings, save: saveSettings } = require('./settings');
const { startVoiceInput, stopVoiceInput, setVoiceChatWindow } = require('./voiceInput');
const { connectToChannel: connectTwitchChat, disconnect: disconnectTwitchChat } = require('./twitchChat');

// Auto-updater
let autoUpdater;
try {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
} catch(e) { console.log('[Updater] Not available:', e.message); }

let tray = null;
let controlWindow = null;
const overlayWindows = {};
let overlaysLocked = false;
let autoHideOverlays = true;

// Persisted settings
let settings = {};


const OVERLAYS = [
  { id: 'standings', name: 'Standings', width: 480, height: 600 },
  { id: 'relative', name: 'Relative', width: 380, height: 450 },
  { id: 'fuel', name: 'Fuel Calculator', width: 300, height: 240 },
  { id: 'wind', name: 'Wind Direction', width: 150, height: 150 },
  { id: 'proximity', name: 'Car Proximity', width: 160, height: 280 },
  { id: 'chat', name: 'Streaming Chat', width: 340, height: 500 },
  { id: 'trackmap', name: 'Track Map', width: 500, height: 500 },
  { id: 'voicechat', name: 'Voice Chat', width: 340, height: 400 },
  { id: 'inputs', name: 'Driver Inputs', width: 520, height: 140 },
  // { id: 'discord', name: 'Discord Voice', width: 200, height: 300 }, // DISABLED — Railway doesn't support UDP for voice speaking detection
];

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Another instance is already running — quit this one
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (controlWindow) {
    if (controlWindow.isMinimized()) controlWindow.restore();
    controlWindow.show();
    controlWindow.focus();
  }
});

app.on('ready', () => {
  // Grant microphone permission for Web Speech API in overlays
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'microphone') {
      callback(true);
    } else {
      callback(true); // allow all permissions for local files
    }
  });
  session.defaultSession.setPermissionCheckHandler(() => true);

  // Load persisted settings
  settings = loadSettings();
  if (settings.autoHideOverlays !== undefined) autoHideOverlays = settings.autoHideOverlays;
  if (settings.overlaysLocked !== undefined) overlaysLocked = settings.overlaysLocked;

  try {
    // Try multiple icon paths (asar, extraResources, build dir)
    const iconPaths = [
      path.join(__dirname, 'build', 'icon.png'),
      path.join(process.resourcesPath || __dirname, 'icon.png'),
      path.join(__dirname, '..', 'icon.png'),
    ];
    let trayIcon = nativeImage.createEmpty();
    for (const p of iconPaths) {
      try {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) { trayIcon = img.resize({ width: 16, height: 16 }); break; }
      } catch(e) {}
    }
    tray = new Tray(trayIcon);
  } catch (e) {
    tray = new Tray(nativeImage.createEmpty());
  }
  tray.setToolTip('Atleta Bridge');
  tray.on('click', () => showControlWindow());

  const logPath = require('path').join(require('os').homedir(), 'atleta-bridge.log');
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Control Panel', click: () => showControlWindow() },
    { label: 'View Log File', click: () => { require('electron').shell.openPath(logPath); } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(contextMenu);

  startServer(9100);
  startTelemetry((status) => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('iracing-status', status);
    }
    // Auto-hide/show overlays based on iRacing connection
    if (autoHideOverlays) {
      if (status.iracing) {
        Object.values(overlayWindows).forEach(w => { if (w && !w.isDestroyed()) w.show(); });
      } else {
        Object.values(overlayWindows).forEach(w => { if (w && !w.isDestroyed()) w.hide(); });
      }
    }
  });

  // Start voice input system
  try {
    const { getStatus } = require('./telemetry');
    startVoiceInput({ settings, getStatus });
  } catch(e) {
    console.log('[Bridge] Voice input failed to start:', e.message);
  }

  // Connect Twitch chat if channel is configured
  const chatSettings = settings.overlayCustom?.chat;
  if (chatSettings?.twitchChannel) {
    connectTwitchChat(chatSettings.twitchChannel);
  }

  showControlWindow();

  // Restore enabled overlays from settings
  if (settings.enabledOverlays && Array.isArray(settings.enabledOverlays)) {
    settings.enabledOverlays.forEach(id => createOverlayWindow(id));
  }

  // Auto-updater setup
  if (autoUpdater) {
    autoUpdater.on('update-available', (info) => {
      console.log('[Updater] Update available:', info.version);
      if (controlWindow && !controlWindow.isDestroyed()) {
        controlWindow.webContents.send('update-available', info.version);
      }
      // System notification so user sees it even without opening control panel
      try {
        const notif = new Notification({
          title: 'Atleta Bridge Update Available',
          body: `Version ${info.version} is ready to download. Click to open settings.`,
        });
        notif.on('click', () => showControlWindow());
        notif.show();
      } catch(e) {}
    });
    autoUpdater.on('update-not-available', () => {
      console.log('[Updater] No updates');
      if (controlWindow && !controlWindow.isDestroyed()) {
        controlWindow.webContents.send('update-not-available');
      }
    });
    autoUpdater.on('download-progress', (progress) => {
      if (controlWindow && !controlWindow.isDestroyed()) {
        controlWindow.webContents.send('update-progress', Math.round(progress.percent));
      }
    });
    autoUpdater.on('update-downloaded', () => {
      console.log('[Updater] Update downloaded, ready to install');
      if (controlWindow && !controlWindow.isDestroyed()) {
        controlWindow.webContents.send('update-downloaded');
      }
      try {
        const notif = new Notification({
          title: 'Atleta Bridge Update Ready',
          body: 'Update downloaded. It will install when you close the app.',
        });
        notif.on('click', () => showControlWindow());
        notif.show();
      } catch(e) {}
    });
    autoUpdater.on('error', (err) => {
      console.log('[Updater] Error:', err.message);
    });
    // Check for updates after 5 seconds
    setTimeout(() => {
      try { autoUpdater.checkForUpdates(); } catch(e) {}
    }, 5000);
  }

  console.log('[Bridge] Started');
});

function persistSettings() {
  settings.autoHideOverlays = autoHideOverlays;
  settings.overlaysLocked = overlaysLocked;
  settings.enabledOverlays = Object.keys(overlayWindows);
  // Persist overlay positions/sizes
  settings.overlayBounds = settings.overlayBounds || {};
  Object.entries(overlayWindows).forEach(([id, win]) => {
    if (win && !win.isDestroyed()) {
      try { settings.overlayBounds[id] = win.getBounds(); } catch(e) {}
    }
  });
  saveSettings(settings);
}

function saveOverlayPosition(overlayId, win) {
  if (!win || win.isDestroyed()) return;
  try {
    if (!settings.overlayBounds) settings.overlayBounds = {};
    settings.overlayBounds[overlayId] = win.getBounds();
    persistSettings();
  } catch(e) {}
}

function showControlWindow() {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.show();
    controlWindow.focus();
    return;
  }

  controlWindow = new BrowserWindow({
    width: 800,
    height: 650,
    resizable: true,
    maximizable: false,
    minWidth: 700,
    minHeight: 550,
    title: 'Atleta Bridge',
    icon: path.join(process.resourcesPath || __dirname, 'icon.png'),
    backgroundColor: '#0c0d14',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  controlWindow.setMenuBarVisibility(false);
  controlWindow.loadFile(path.join(__dirname, 'control-panel.html'));

  controlWindow.on('close', (e) => {
    e.preventDefault();
    controlWindow.hide();
  });
}

function createOverlayWindow(overlayId) {
  const config = OVERLAYS.find(o => o.id === overlayId);
  if (!config || overlayWindows[overlayId]) return;

  const display = screen.getPrimaryDisplay();
  const { width: screenW } = display.workAreaSize;

  // Trackmap uses user-configured width/height from settings
  if (overlayId === 'trackmap' && settings.overlayCustom && settings.overlayCustom.trackmap) {
    const tc = settings.overlayCustom.trackmap;
    if (tc.overlayWidth) config = { ...config, width: parseInt(tc.overlayWidth) || config.width };
    if (tc.overlayHeight) config = { ...config, height: parseInt(tc.overlayHeight) || config.height };
  }
  const savedBounds = settings.overlayBounds && settings.overlayBounds[overlayId];
  const x = savedBounds ? savedBounds.x : screenW - config.width - 20;
  const y = savedBounds ? savedBounds.y : 20 + Object.keys(overlayWindows).length * 40;
  const width = overlayId === 'trackmap' ? config.width : (savedBounds ? savedBounds.width : config.width);
  const height = overlayId === 'trackmap' ? config.height : (savedBounds ? savedBounds.height : config.height);

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    hasShadow: false,
    minWidth: 100,
    minHeight: 80,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  // Lock aspect ratio during resize (skip for trackmap — it handles its own aspect)
  if (overlayId !== 'trackmap') {
    const initialAspect = width / height;
    win.on('will-resize', (event, newBounds) => {
      event.preventDefault();
      const newW = newBounds.width;
      const newH = Math.round(newW / initialAspect);
      win.setBounds({ x: newBounds.x, y: newBounds.y, width: newW, height: newH });
    });
  }

  // Use highest z-level to stay on top of fullscreen games like iRacing
  win.setAlwaysOnTop(true, 'screen-saver');

  // Periodically re-assert always-on-top (games can steal focus)
  const topInterval = setInterval(() => {
    if (win.isDestroyed()) { clearInterval(topInterval); return; }
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch(e) {}
  }, 2000);

  win.loadFile(path.join(__dirname, 'overlays', `${overlayId}.html`));

  // Click-through: always ignore + forward so transparent areas don't block clicks.
  // Overlays use IPC to temporarily capture events when mouse is over visible content.
  win.setIgnoreMouseEvents(true, { forward: true });
  if (overlaysLocked) {
    win.setResizable(false);
  }

  // Save position/size when moved or resized
  win.on('moved', () => saveOverlayPosition(overlayId, win));
  win.on('resized', () => saveOverlayPosition(overlayId, win));

  win.on('closed', () => {
    clearInterval(topInterval);
    delete overlayWindows[overlayId];
    if (overlayId === 'voicechat') {
      setVoiceChatWindow(null);
    }
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('overlay-closed', overlayId);
    }
    persistSettings();
  });

  overlayWindows[overlayId] = win;

  // Wire up voice chat overlay to voice input module
  if (overlayId === 'voicechat') {
    setVoiceChatWindow(win);
  }

  persistSettings();
}

function closeOverlayWindow(overlayId) {
  if (overlayWindows[overlayId]) {
    overlayWindows[overlayId].destroy();
    delete overlayWindows[overlayId];
    persistSettings();
  }
}

function setOverlaysLocked(locked) {
  overlaysLocked = locked;
  Object.values(overlayWindows).forEach(win => {
    if (win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(true, { forward: true });
      win.setResizable(!locked);
      win.webContents.send('lock-state', locked);
    }
  });
  persistSettings();
}

ipcMain.on('toggle-overlay', (event, overlayId, enabled) => {
  if (enabled) createOverlayWindow(overlayId);
  else closeOverlayWindow(overlayId);
});

ipcMain.on('toggle-lock', (event, locked) => {
  setOverlaysLocked(locked);
});

// Overlays call this when mouse enters/leaves visible content
ipcMain.on('set-ignore-mouse', (event, ignore) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed() && !overlaysLocked) {
    win.setIgnoreMouseEvents(ignore, { forward: true });
  }
});

ipcMain.on('toggle-autohide', (event, enabled) => {
  autoHideOverlays = enabled;
  persistSettings();
});

ipcMain.on('save-overlay-settings', (event, overlayId, overlaySettings) => {
  if (!settings.overlayCustom) settings.overlayCustom = {};
  settings.overlayCustom[overlayId] = overlaySettings;
  persistSettings();
  // Reload the overlay window to apply new settings
  if (overlayWindows[overlayId] && !overlayWindows[overlayId].isDestroyed()) {
    overlayWindows[overlayId].reload();
  }
  // Reconnect Twitch chat if channel changed
  if (overlayId === 'chat' && overlaySettings.twitchChannel !== undefined) {
    connectTwitchChat(overlaySettings.twitchChannel);
  }
});

ipcMain.on('get-overlay-states', (event) => {
  const states = {};
  OVERLAYS.forEach(o => { states[o.id] = !!overlayWindows[o.id]; });
  event.reply('overlay-states', states);
  event.reply('lock-state', overlaysLocked);
  event.reply('autohide-state', autoHideOverlays);
});

ipcMain.on('get-overlay-settings', (event, overlayId) => {
  const overlaySettings = settings.overlayCustom && settings.overlayCustom[overlayId];
  if (overlaySettings) {
    event.reply('overlay-settings', overlayId, overlaySettings);
  }
});

ipcMain.on('check-for-update', () => {
  if (autoUpdater) try { autoUpdater.checkForUpdates(); } catch(e) {}
});

ipcMain.on('download-update', () => {
  if (autoUpdater) try { autoUpdater.downloadUpdate(); } catch(e) {}
});

ipcMain.on('install-update', () => {
  persistSettings(); // Save overlay state before update
  if (autoUpdater) autoUpdater.quitAndInstall();
});

app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  persistSettings();
  Object.keys(overlayWindows).forEach(closeOverlayWindow);
  stopTelemetry();
  stopVoiceInput();
  stopServer();
});
