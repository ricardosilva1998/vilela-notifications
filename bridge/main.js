const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen } = require('electron');
const path = require('path');
const { startServer, stopServer } = require('./websocket');
const { startTelemetry, stopTelemetry } = require('./telemetry');

let tray = null;
let controlWindow = null;
const overlayWindows = {};
let overlaysLocked = false;

const OVERLAYS = [
  { id: 'standings', name: 'Standings', width: 360, height: 500 },
  { id: 'relative', name: 'Relative', width: 260, height: 400 },
  { id: 'fuel', name: 'Fuel Calculator', width: 260, height: 200 },
  { id: 'wind', name: 'Wind Direction', width: 150, height: 150 },
  { id: 'proximity', name: 'Car Proximity', width: 160, height: 280 },
  { id: 'chat', name: 'Streaming Chat', width: 340, height: 500 },
];

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

app.on('second-instance', () => {
  if (controlWindow) {
    if (controlWindow.isMinimized()) controlWindow.restore();
    controlWindow.show();
    controlWindow.focus();
  }
});

app.on('ready', () => {
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')));
  } catch (e) {
    tray = new Tray(nativeImage.createEmpty());
  }
  tray.setToolTip('Atleta Bridge');
  tray.on('click', () => showControlWindow());

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Control Panel', click: () => showControlWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(contextMenu);

  startServer(9100);
  startTelemetry((status) => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('iracing-status', status);
    }
  });

  showControlWindow();
  console.log('[Bridge] Started');
});

function showControlWindow() {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.show();
    controlWindow.focus();
    return;
  }

  controlWindow = new BrowserWindow({
    width: 420,
    height: 600,
    resizable: false,
    maximizable: false,
    title: 'Atleta Bridge',
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

  const win = new BrowserWindow({
    width: config.width,
    height: config.height,
    x: screenW - config.width - 20,
    y: 20 + Object.keys(overlayWindows).length * 40,
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

  win.loadFile(path.join(__dirname, 'overlays', `${overlayId}.html`));

  if (overlaysLocked) {
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setResizable(false);
  }

  win.on('closed', () => {
    delete overlayWindows[overlayId];
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('overlay-closed', overlayId);
    }
  });

  overlayWindows[overlayId] = win;
}

function closeOverlayWindow(overlayId) {
  if (overlayWindows[overlayId]) {
    overlayWindows[overlayId].destroy();
    delete overlayWindows[overlayId];
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
}

ipcMain.on('toggle-overlay', (event, overlayId, enabled) => {
  if (enabled) createOverlayWindow(overlayId);
  else closeOverlayWindow(overlayId);
});

ipcMain.on('toggle-lock', (event, locked) => {
  setOverlaysLocked(locked);
});

ipcMain.on('get-overlay-states', (event) => {
  const states = {};
  OVERLAYS.forEach(o => { states[o.id] = !!overlayWindows[o.id]; });
  event.reply('overlay-states', states);
  event.reply('lock-state', overlaysLocked);
});

app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  Object.keys(overlayWindows).forEach(closeOverlayWindow);
  stopTelemetry();
  stopServer();
});
