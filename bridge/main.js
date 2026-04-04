const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, session } = require('electron');
const path = require('path');
const { startServer, stopServer } = require('./websocket');
const { startTelemetry, stopTelemetry } = require('./telemetry');
const { load: loadSettings, save: saveSettings } = require('./settings');
const { startVoiceInput, stopVoiceInput, setVoiceChatWindow } = require('./voiceInput');

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
  { id: 'trackmap', name: 'Track Map', width: 300, height: 300 },
  { id: 'voicechat', name: 'Voice Chat', width: 340, height: 400 },
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
  const { getStatus } = require('./telemetry');
  startVoiceInput({ settings, getStatus });

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
    width: 420,
    height: 640,
    resizable: false,
    maximizable: false,
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

  // Restore saved bounds if available
  const savedBounds = settings.overlayBounds && settings.overlayBounds[overlayId];
  const x = savedBounds ? savedBounds.x : screenW - config.width - 20;
  const y = savedBounds ? savedBounds.y : 20 + Object.keys(overlayWindows).length * 40;
  const width = savedBounds ? savedBounds.width : config.width;
  const height = savedBounds ? savedBounds.height : config.height;

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

  // Use highest z-level to stay on top of fullscreen games like iRacing
  win.setAlwaysOnTop(true, 'screen-saver');

  // Periodically re-assert always-on-top (games can steal focus)
  const topInterval = setInterval(() => {
    if (win.isDestroyed()) { clearInterval(topInterval); return; }
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch(e) {}
  }, 2000);

  win.loadFile(path.join(__dirname, 'overlays', `${overlayId}.html`));

  if (overlaysLocked) {
    win.setIgnoreMouseEvents(true, { forward: true });
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
      win.setIgnoreMouseEvents(locked, { forward: locked });
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
});

ipcMain.on('get-overlay-states', (event) => {
  const states = {};
  OVERLAYS.forEach(o => { states[o.id] = !!overlayWindows[o.id]; });
  event.reply('overlay-states', states);
  event.reply('lock-state', overlaysLocked);
  event.reply('autohide-state', autoHideOverlays);
});

ipcMain.on('check-for-update', () => {
  if (autoUpdater) try { autoUpdater.checkForUpdates(); } catch(e) {}
});

ipcMain.on('download-update', () => {
  if (autoUpdater) try { autoUpdater.downloadUpdate(); } catch(e) {}
});

ipcMain.on('install-update', () => {
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
