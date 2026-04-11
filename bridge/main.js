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
const { startServer, stopServer, getClientInfo: getWsClients, getClientLog, clearClientLog, clearAllClientLogs } = require('./websocket');
const { startTelemetry, stopTelemetry } = require('./telemetry');
const { load: loadSettings, save: saveSettings } = require('./settings');
const { startVoiceInput, stopVoiceInput, setVoiceChatWindow } = require('./voiceInput');
const { connectToChannel: connectTwitchChat, disconnect: disconnectTwitchChat } = require('./twitchChat');
const sessionRecorder = require('./sessionRecorder');
const pitwallUplink = require('./pitwallUplink');

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
// Lock feature removed — overlays are always unlocked and draggable
let autoHideOverlays = true;
let quitting = false;

// Persisted settings
let settings = {};


const OVERLAYS = [
  { id: 'standings', name: 'Standings', width: 900, height: 800 },
  { id: 'relative', name: 'Relative', width: 520, height: 500 },
  { id: 'fuel', name: 'Fuel Calculator', width: 300, height: 370 },
  { id: 'wind', name: 'Wind Direction', width: 170, height: 210 },
  { id: 'proximity', name: 'Car Proximity', width: 180, height: 280 },
  { id: 'chat', name: 'Streaming Chat', width: 340, height: 500 },
  { id: 'trackmap', name: 'Track Map', width: 500, height: 500 },
  { id: 'voicechat', name: 'Voice Chat', width: 340, height: 400 },
  { id: 'inputs', name: 'Driver Inputs', width: 540, height: 150 },
  { id: 'raceduration', name: 'Race Duration', width: 280, height: 80 },
  { id: 'drivercard', name: 'Driver Card', width: 300, height: 180 },
  { id: 'stintlaps', name: 'Stint Laps', width: 320, height: 300 },
  { id: 'weather', name: 'Weather', width: 320, height: 195 },
  { id: 'pitstrategy', name: 'Pit Strategy', width: 260, height: 400 },
  { id: 'lapcompare', name: 'Lap Compare', width: 360, height: 220 },
  { id: 'livestats', name: 'Live Stats', width: 420, height: 250 },
  { id: 'pittimer', name: 'Pit Duration', width: 200, height: 120 },
  { id: 'spotify', name: 'Now Playing', width: 360, height: 100 },
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

// Set app ID for Windows taskbar icon grouping
app.setAppUserModelId('com.atleta.bridge');

app.on('ready', () => {
  // Only grant permissions that are actually needed
  const ALLOWED_PERMISSIONS = ['media', 'microphone', 'clipboard-read', 'clipboard-sanitized-write'];
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return ALLOWED_PERMISSIONS.includes(permission);
  });

  // Load persisted settings
  settings = loadSettings();
  if (settings.autoHideOverlays !== undefined) autoHideOverlays = settings.autoHideOverlays;

  // Check if user is logged in — show login screen if not
  if (!settings.racingUsername) {
    showLoginWindow();
    return;
  }

  // User is authenticated — start normally
  startBridge();
});

// Handle login success from login window
ipcMain.on('login-success', (event, data) => {
  settings.racingUsername = data.username;
  settings.racingUserId = data.userId;
  if (data.bridgeId) settings.bridgeId = data.bridgeId;
  if (data.pitwallToken) settings.pitwallToken = data.pitwallToken;
  saveSettings(settings);

  // Close login window and start the app
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.close();
    loginWindow = null;
  }
  startBridge();
});

// Handle logout from control panel
ipcMain.on('logout', () => {
  delete settings.racingUsername;
  delete settings.racingUserId;
  delete settings.pitwallToken;
  delete settings.pitwallBroadcastTeamIds;
  saveSettings(settings);
  app.relaunch();
  app.quit();
});

let loginWindow = null;

function showLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 440,
    height: 520,
    resizable: false,
    maximizable: false,
    title: 'Atleta Bridge — Login',
    icon: path.join(process.resourcesPath || __dirname, 'atleta.ico'),
    backgroundColor: '#0c0d14',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  loginWindow.setMenuBarVisibility(false);
  loginWindow.loadFile(path.join(__dirname, 'login.html'));
  loginWindow.webContents.on('did-finish-load', () => {
    loginWindow.webContents.send('init-login', {
      bridgeId: settings.bridgeId || '',
      iracingName: settings.iracingName || '',
    });
  });
  loginWindow.on('closed', () => {
    loginWindow = null;
    // If user closed login without logging in, quit
    if (!settings.racingUsername) app.quit();
  });
}

function startBridge() {
  // Load app icon
  try {
    const iconPaths = [
      path.join(process.resourcesPath || __dirname, 'atleta.ico'),
      path.join(process.resourcesPath || __dirname, 'atleta.png'),
      path.join(__dirname, 'build', 'atleta.ico'),
      path.join(__dirname, 'build', 'atleta.png'),
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
  pitwallUplink.start();
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

  // Start voice input system only if voice chat overlay is enabled
  if (settings.enabledOverlays && settings.enabledOverlays.includes('voicechat')) {
    try {
      const { getStatus } = require('./telemetry');
      startVoiceInput({ settings, getStatus });
    } catch(e) {
      console.log('[Bridge] Voice input failed to start:', e.message);
    }
  }

  // Connect Twitch chat if channel is configured
  const chatSettings = settings.overlayCustom?.chat;
  if (chatSettings?.twitchChannel) {
    connectTwitchChat(chatSettings.twitchChannel);
  }

  showControlWindow();

  // Restore enabled overlays from settings (hidden if autoHide is on — shown when iRacing connects)
  if (settings.enabledOverlays && Array.isArray(settings.enabledOverlays)) {
    settings.enabledOverlays.forEach(id => createOverlayWindow(id));
    // Hide all overlays initially when autoHide is on (iRacing isn't connected yet)
    if (autoHideOverlays) {
      setTimeout(() => {
        Object.values(overlayWindows).forEach(w => { if (w && !w.isDestroyed()) w.hide(); });
      }, 200);
    }
  }

  // Restore session backup after update (if exists)
  try {
    const backupFile = path.join(require('os').homedir(), 'Documents', 'Atleta Bridge', 'session-backup.json');
    const fs = require('fs');
    if (fs.existsSync(backupFile)) {
      const backupData = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
      const overlayIds = Object.keys(backupData);
      if (overlayIds.length > 0) {
        console.log('[Backup] Restoring session state for ' + overlayIds.length + ' overlays');
        // Wait for overlays to load, then inject state
        setTimeout(() => {
          overlayIds.forEach(id => {
            const win = overlayWindows[id];
            if (win && !win.isDestroyed() && backupData[id]) {
              try {
                win.webContents.executeJavaScript(
                  'typeof window.__restoreState === "function" && window.__restoreState(' + backupData[id] + ')'
                );
              } catch(e) {}
            }
          });
        }, 3000); // 3s delay for overlays to fully load
      }
      fs.unlinkSync(backupFile); // clear backup after restore
    }
  } catch(e) { console.log('[Backup] Restore error:', e.message); }

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
    // Check for updates after 5 seconds, then every 60 seconds
    setTimeout(() => {
      try { autoUpdater.checkForUpdates(); } catch(e) {}
    }, 5000);
    setInterval(() => {
      try { autoUpdater.checkForUpdates(); } catch(e) {}
    }, 60000);
  }

  console.log('[Bridge] Started');

  // --- Remote Log Upload (every 60s) ---
  const LOG_UPLOAD_URL = 'https://atletanotifications.com/api/bridge-logs';
  let lastLogOffset = 0;

  function uploadLogs() {
    try {
      const fs = require('fs');
      const https = require('https');
      const logPath = require('path').join(require('os').homedir(), 'atleta-bridge.log');
      if (!fs.existsSync(logPath)) return;

      const stat = fs.statSync(logPath);
      // Log file was recreated (smaller than offset) — reset
      if (stat.size < lastLogOffset) lastLogOffset = 0;
      if (stat.size <= lastLogOffset) return; // no new data

      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(stat.size - lastLogOffset);
      fs.readSync(fd, buf, 0, buf.length, lastLogOffset);
      fs.closeSync(fd);

      const newLines = buf.toString('utf8');
      if (!newLines.trim()) return;

      let iracingName = '';
      try { iracingName = require('./telemetry').getPlayerName() || ''; } catch(e) {}
      const postData = JSON.stringify({ bridgeId: settings.bridgeId, lines: newLines, iracingName });

      // Cap at 1MB per upload
      if (postData.length > 1024 * 1024) {
        lastLogOffset = stat.size;
        return;
      }

      const url = new URL(LOG_UPLOAD_URL);
      const req = https.request({
        hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        timeout: 10000,
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) lastLogOffset = stat.size;
        });
      });
      req.on('error', () => {}); // silent fail
      req.on('timeout', () => req.destroy());
      req.write(postData);
      req.end();
    } catch(e) {} // never crash the app
  }

  setInterval(uploadLogs, 60000);
  // Upload initial logs after 10s
  setTimeout(uploadLogs, 10000);
}

function persistSettings() {
  if (quitting) return;
  settings.autoHideOverlays = autoHideOverlays;
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
    width: 1000,
    height: 750,
    resizable: true,
    maximizable: true,
    minWidth: 800,
    minHeight: 600,
    title: 'Atleta Bridge',
    icon: path.join(process.resourcesPath || __dirname, 'atleta.ico'),
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
  const baseConfig = OVERLAYS.find(o => o.id === overlayId);
  if (!baseConfig || overlayWindows[overlayId]) return;
  let config = { ...baseConfig };

  const display = screen.getPrimaryDisplay();
  const { width: screenW } = display.workAreaSize;

  // Apply custom width/height from settings
  if (settings.overlayCustom && settings.overlayCustom[overlayId]) {
    const cw = parseInt(settings.overlayCustom[overlayId].width);
    const ch = parseInt(settings.overlayCustom[overlayId].height);
    if (cw > 0) config.width = cw;
    if (ch > 0) config.height = ch;
  }

  // Trackmap: always square, size from settings, ignore saved bounds
  if (overlayId === 'trackmap') {
    if (settings.overlayCustom && settings.overlayCustom.trackmap) {
      const sizeMap = { small: 300, medium: 500, large: 700 };
      const sizeVal = settings.overlayCustom.trackmap.overlaySize;
      const size = sizeMap[sizeVal] || parseInt(sizeVal) || config.width;
      config.width = size;
      config.height = size;
    }
    // Clear saved bounds — trackmap size always comes from settings
    if (settings.overlayBounds) delete settings.overlayBounds.trackmap;
  }
  // Use saved position but always use config size (no free resize)
  // Position: use saved settings posX/posY > saved bounds > default (0,0)
  const overlaySettings = settings.overlayCustom && settings.overlayCustom[overlayId];
  const savedBounds = settings.overlayBounds && settings.overlayBounds[overlayId];
  const posX = overlaySettings && overlaySettings.posX !== undefined ? parseInt(overlaySettings.posX) : NaN;
  const posY = overlaySettings && overlaySettings.posY !== undefined ? parseInt(overlaySettings.posY) : NaN;
  const x = !isNaN(posX) ? posX : (savedBounds ? savedBounds.x : 0);
  const y = !isNaN(posY) ? posY : (savedBounds ? savedBounds.y : 0);
  const width = config.width;
  const height = config.height;

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

ipcMain.on('toggle-overlay', (event, overlayId, enabled) => {
  if (enabled) createOverlayWindow(overlayId);
  else closeOverlayWindow(overlayId);
  // Persist enabled overlays
  if (!settings.enabledOverlays) settings.enabledOverlays = [];
  if (enabled && !settings.enabledOverlays.includes(overlayId)) settings.enabledOverlays.push(overlayId);
  if (!enabled) settings.enabledOverlays = settings.enabledOverlays.filter(id => id !== overlayId);
  saveSettings(settings);
  // Start/stop voice input with voicechat overlay
  if (overlayId === 'voicechat') {
    if (enabled) {
      try {
        const { getStatus } = require('./telemetry');
        startVoiceInput({ settings, getStatus });
      } catch(e) {}
    } else {
      try { stopVoiceInput(); } catch(e) {}
    }
  }
});

// Overlays call this when mouse enters/leaves visible content
ipcMain.on('set-ignore-mouse', (event, ignore) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(ignore, { forward: true });
  }
});

ipcMain.on('drag-overlay', (event, dx, dy) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    const bounds = win.getBounds();
    win.setBounds({ x: bounds.x + dx, y: bounds.y + dy, width: bounds.width, height: bounds.height });
  }
});

ipcMain.on('get-overlay-position', (event, overlayId) => {
  if (overlayWindows[overlayId] && !overlayWindows[overlayId].isDestroyed()) {
    const bounds = overlayWindows[overlayId].getBounds();
    event.reply('overlay-position', overlayId, bounds.x, bounds.y);
  }
});

ipcMain.on('resize-overlay-height', (event, overlayId, height) => {
  if (overlayWindows[overlayId] && !overlayWindows[overlayId].isDestroyed()) {
    const bounds = overlayWindows[overlayId].getBounds();
    overlayWindows[overlayId].setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: Math.round(height) });
  }
});

ipcMain.on('auto-resize-height', (event, h) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    const [w] = win.getSize();
    win.setSize(w, Math.round(h));
  }
});

ipcMain.on('move-overlay', (event, overlayId, x, y) => {
  if (overlayWindows[overlayId] && !overlayWindows[overlayId].isDestroyed()) {
    const bounds = overlayWindows[overlayId].getBounds();
    overlayWindows[overlayId].setBounds({ x: Math.round(x), y: Math.round(y), width: bounds.width, height: bounds.height });
  }
});

ipcMain.on('resize-overlay', (event, overlayId, width, height) => {
  if (overlayWindows[overlayId] && !overlayWindows[overlayId].isDestroyed()) {
    const bounds = overlayWindows[overlayId].getBounds();
    overlayWindows[overlayId].setBounds({ x: bounds.x, y: bounds.y, width: Math.round(width), height: Math.round(height) });
  }
});

// Resize from overlay grip (aspect-ratio locked)
ipcMain.on('resize-overlay-wh', (event, w, h) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.setSize(Math.round(w), Math.round(h));
});

// Get current window size (sync)
ipcMain.on('get-window-size', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    const s = win.getSize();
    event.returnValue = s;
  } else {
    event.returnValue = null;
  }
});

ipcMain.on('toggle-autohide', (event, enabled) => {
  autoHideOverlays = enabled;
  persistSettings();
});

ipcMain.on('save-overlay-settings', (event, overlayId, overlaySettings) => {
  if (!settings.overlayCustom) settings.overlayCustom = {};
  settings.overlayCustom[overlayId] = overlaySettings;

  // Sync position FIRST: capture current window position before reload
  if (overlayWindows[overlayId] && !overlayWindows[overlayId].isDestroyed()) {
    const bounds = overlayWindows[overlayId].getBounds();
    overlaySettings.posX = String(bounds.x);
    overlaySettings.posY = String(bounds.y);
    // Apply width/height if user set them
    const setW = parseInt(overlaySettings.width);
    const setH = parseInt(overlaySettings.height);
    if (setW > 0 || setH > 0) {
      overlayWindows[overlayId].setSize(setW > 0 ? setW : bounds.width, setH > 0 ? setH : bounds.height);
    }
    settings.overlayCustom[overlayId] = overlaySettings;
  }

  // For trackmap: destroy and recreate with new size instead of just reloading
  if (overlayId === 'trackmap' && overlayWindows[overlayId] && !overlayWindows[overlayId].isDestroyed()) {
    const oldWin = overlayWindows[overlayId];
    delete overlayWindows[overlayId];
    oldWin.removeAllListeners('closed'); // prevent overlay-closed event from unchecking toggle
    oldWin.destroy();
    if (settings.overlayBounds) delete settings.overlayBounds.trackmap;
    persistSettings();
    createOverlayWindow('trackmap');
    // Re-sync toggle state since we suppressed the closed event
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('overlay-states', { trackmap: true });
    }
  } else {
    persistSettings();
    // Reload overlay to apply new settings — overlay saves/restores state via sessionStorage
    if (overlayWindows[overlayId] && !overlayWindows[overlayId].isDestroyed()) {
      overlayWindows[overlayId].webContents.send('will-reload');
      setTimeout(() => {
        if (overlayWindows[overlayId] && !overlayWindows[overlayId].isDestroyed()) {
          overlayWindows[overlayId].reload();
        }
      }, 100); // give overlay 100ms to save state
    }
  }
  // Reconnect Twitch chat if channel changed
  if (overlayId === 'chat' && overlaySettings.twitchChannel !== undefined) {
    connectTwitchChat(overlaySettings.twitchChannel);
  }
});

ipcMain.on('reset-overlay', (event, overlayId) => {
  const ov = OVERLAYS.find(o => o.id === overlayId);
  if (!ov) return;
  // Reset saved bounds
  if (settings.overlayBounds) delete settings.overlayBounds[overlayId];
  // Reset custom settings
  if (settings.overlayCustom) delete settings.overlayCustom[overlayId];
  saveSettings(settings);
  // Reset window size to default and center it
  const win = overlayWindows[overlayId];
  if (win && !win.isDestroyed()) {
    win.setSize(ov.width, ov.height);
    win.center();
  }
});

ipcMain.on('get-overlay-states', (event) => {
  const states = {};
  OVERLAYS.forEach(o => { states[o.id] = !!overlayWindows[o.id]; });
  event.reply('overlay-states', states);
  event.reply('autohide-state', autoHideOverlays);
});

ipcMain.on('get-overlay-settings', (event, overlayId) => {
  const overlaySettings = settings.overlayCustom && settings.overlayCustom[overlayId];
  if (overlaySettings) {
    event.reply('overlay-settings', overlayId, overlaySettings);
  }
});

// ─── WebSocket client logs IPC ────────────────────────────────
ipcMain.on('get-ws-clients', (event) => {
  event.reply('ws-clients', getWsClients());
});

ipcMain.on('get-ws-client-log', (event, clientId) => {
  event.reply('ws-client-log', clientId, getClientLog(clientId));
});

ipcMain.on('clear-ws-client-log', (event, clientId) => {
  clearClientLog(clientId);
  event.reply('ws-client-log', clientId, []);
});

ipcMain.on('clear-all-ws-client-logs', (event) => {
  clearAllClientLogs();
  event.reply('ws-clients', getWsClients());
});

ipcMain.on('check-for-update', () => {
  if (autoUpdater) try { autoUpdater.checkForUpdates(); } catch(e) {}
});

ipcMain.on('download-update', () => {
  if (autoUpdater) try { autoUpdater.downloadUpdate(); } catch(e) {}
});

ipcMain.on('install-update', async () => {
  persistSettings();
  // Backup overlay runtime state before update — each overlay saves to sessionStorage-like file
  const backupData = {};
  for (const [id, win] of Object.entries(overlayWindows)) {
    if (!win || win.isDestroyed()) continue;
    try {
      const state = await win.webContents.executeJavaScript(
        'typeof window.__getState === "function" ? JSON.stringify(window.__getState()) : null'
      );
      if (state) backupData[id] = state;
    } catch(e) {}
  }
  // Save backup to file
  try {
    const backupFile = path.join(require('os').homedir(), 'Documents', 'Atleta Bridge', 'session-backup.json');
    require('fs').writeFileSync(backupFile, JSON.stringify(backupData, null, 2));
    console.log('[Backup] Saved session state for ' + Object.keys(backupData).length + ' overlays');
  } catch(e) { console.log('[Backup] Save error:', e.message); }
  quitting = true;
  if (autoUpdater) autoUpdater.quitAndInstall();
});

app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  sessionRecorder.flush(); // Upload any in-progress session
  persistSettings(); // save with current overlays still open
  quitting = true;   // prevent closeOverlayWindow from overwriting with empty list
  Object.keys(overlayWindows).forEach(closeOverlayWindow);
  stopTelemetry();
  pitwallUplink.stop();
  stopVoiceInput();
  stopServer();
  // Force exit after cleanup to kill all child processes
  setTimeout(() => process.exit(0), 1000);
});
