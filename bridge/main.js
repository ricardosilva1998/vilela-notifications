const { app, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { startTelemetry, stopTelemetry, getStatus } = require('./telemetry');
const { startServer, stopServer } = require('./websocket');

let tray = null;

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); return; }

app.on('ready', () => {
  // Create system tray icon
  const iconPath = path.join(__dirname, 'icons', 'icon-yellow.png');
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('Atleta Bridge — Waiting for iRacing');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Atleta Bridge', type: 'normal', enabled: false },
    { type: 'separator' },
    { label: 'Status: Waiting', id: 'status', type: 'normal', enabled: false },
    { type: 'separator' },
    { label: 'Open Dashboard', click: () => { require('electron').shell.openExternal('https://atletanotifications.com/dashboard?tab=iracing'); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);

  // Start WebSocket server
  startServer(9100);

  // Start telemetry reader
  startTelemetry((status) => {
    // Update tray icon based on status
    const iconName = status.iracing ? 'icon-green.png' : 'icon-yellow.png';
    try {
      tray.setImage(nativeImage.createFromPath(path.join(__dirname, 'icons', iconName)));
      tray.setToolTip(status.iracing ? `Atleta Bridge — ${status.track || 'Connected'}` : 'Atleta Bridge — Waiting for iRacing');
      const menu = tray.getContextMenu ? contextMenu : null;
    } catch (e) {}
  });

  console.log('[Bridge] Started — WebSocket on ws://localhost:9100');
});

app.on('window-all-closed', (e) => { e.preventDefault(); }); // Keep running in tray
app.on('before-quit', () => { stopTelemetry(); stopServer(); });
