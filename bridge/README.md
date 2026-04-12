# Atleta Racing

Desktop app that reads iRacing telemetry and serves it to web overlays via WebSocket.

## Requirements
- Windows 10/11
- iRacing installed
- Node.js 20+ (for development)

## Development
```bash
npm install
npm start
```

## Building
```bash
npm run build
```
Creates a Windows installer in `dist/`.

## Architecture
- `main.js` — Electron main process, system tray
- `telemetry.js` — iRacing SDK reader via node-irsdk
- `websocket.js` — WebSocket server (ws://localhost:9100)
- `fuel-calculator.js` — Fuel tracking and calculations
- `relative.js` — Relative gap calculations

## WebSocket Protocol
Clients connect and subscribe to channels:
```json
{ "type": "subscribe", "channels": ["standings", "fuel", "wind"] }
```

Server broadcasts data per channel:
```json
{ "type": "data", "channel": "fuel", "data": { ... } }
{ "type": "status", "iracing": true }
```
