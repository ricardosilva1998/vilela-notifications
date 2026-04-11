'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { buildScenario, OVERLAY_CHANNELS } = require('./mock-data');

const HTTP_PORT = parseInt(process.env.TEST_HTTP_PORT) || 9222;
const WS_PORT = parseInt(process.env.TEST_WS_PORT) || 9111;
const OVERLAYS_DIR = path.join(__dirname, '..', 'overlays');

// ── Mock script injected into every overlay ────────────────────────
function buildMockScript(overlayId, query) {
  const scale = query.get('scale') || '';
  const showHeader = query.get('showHeader');
  const fontSize = query.get('fontSize') || '';
  const rowHeight = query.get('rowHeight') || '';
  return `<script>
// ── Test harness: mock Node.js APIs for browser ──
(function() {
  var _overlayId = ${JSON.stringify(overlayId)};
  var _settings = { overlayCustom: {} };
  var _custom = {};
  ${scale ? `_custom.scale = ${parseInt(scale)};` : ''}
  ${showHeader === 'false' ? '_custom.showHeader = false;' : ''}
  ${fontSize ? `_custom.fontSize = ${parseInt(fontSize)};` : ''}
  ${rowHeight ? `_custom.rowHeight = ${parseInt(rowHeight)};` : ''}
  ${query.get('maxMyClass') ? `_custom.maxMyClass = '${parseInt(query.get('maxMyClass'))}';` : ''}
  ${query.get('maxOtherClasses') ? `_custom.maxOtherClasses = '${parseInt(query.get('maxOtherClasses'))}';` : ''}
  if (_overlayId) _settings.overlayCustom[_overlayId] = _custom;

  window.require = function(mod) {
    if (mod === 'electron') return {
      ipcRenderer: {
        send: function(ch) {
          if (ch === 'resize-overlay-wh') {
            // Simulate Electron window resize — grow the page to fit content
            var w = arguments[1], h = arguments[2];
            window.__lastResize = { w: w, h: h };
            document.documentElement.style.minWidth = w + 'px';
            document.documentElement.style.minHeight = h + 'px';
            document.body.style.minWidth = w + 'px';
            document.body.style.minHeight = h + 'px';
            try { window.parent.postMessage({ type: 'overlay-resize', id: _overlayId, w: w, h: h }, '*'); } catch(e) {}
          }
        },
        on: function() {},
        invoke: function() { return Promise.resolve(); },
        removeAllListeners: function() {}
      }
    };
    if (mod === 'fs') return {
      existsSync: function() { return true; },
      readFileSync: function() { return JSON.stringify(_settings); },
      appendFileSync: function() {},
      writeFileSync: function() {}
    };
    if (mod === 'path') return { join: function() { return Array.prototype.slice.call(arguments).join('/'); } };
    if (mod === 'os') return { homedir: function() { return '/mock'; } };
    return {};
  };
  window.module = { exports: {} };
  window.process = window.process || { env: {}, platform: 'win32' };
})();
</script>`;
}

// ── MIME types ──────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webm': 'video/webm', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.ttf': 'font/ttf',
};

// ── HTTP Server ────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${HTTP_PORT}`);

  // Control API: POST /api/scenario/:name
  if (req.method === 'POST' && url.pathname.startsWith('/api/scenario/')) {
    const name = url.pathname.split('/').pop();
    const scenario = buildScenario(name);
    currentScenario = scenario;
    broadcastScenario(scenario);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, scenario: name }));
    return;
  }

  // Control API: POST /api/push/:channel — push raw JSON body
  if (req.method === 'POST' && url.pathname.startsWith('/api/push/')) {
    const channel = url.pathname.split('/').pop();
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        broadcastChannel(channel, data);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400); res.end('Bad JSON');
      }
    });
    return;
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }

  // Serve overlay HTML with mocks injected
  // URL pattern matches overlay-utils.js regex: /overlays\/(\w+)\.html/
  const overlayMatch = url.pathname.match(/^\/overlays\/(\w+)\.html$/);
  if (overlayMatch) {
    const name = overlayMatch[1];
    const filePath = path.join(OVERLAYS_DIR, name + '.html');
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }

    let html = fs.readFileSync(filePath, 'utf8');
    // Inject mock script right after <head>
    html = html.replace(/<head>/, '<head>' + buildMockScript(name, url.searchParams));
    // Replace WS URL
    html = html.replace(/ws:\/\/localhost:9100/g, `ws://localhost:${WS_PORT}`);
    res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
    res.end(html);
    return;
  }

  // Serve playground
  if (url.pathname === '/' || url.pathname === '/playground') {
    const pg = path.join(__dirname, 'playground.html');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(pg, 'utf8'));
    return;
  }

  // Static files from overlays directory (CSS, images, JS, fonts)
  const staticPath = path.join(OVERLAYS_DIR, url.pathname.replace(/^\/overlays\//, ''));
  if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
    const ext = path.extname(staticPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    res.end(fs.readFileSync(staticPath));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── WebSocket Server ───────────────────────────────────────────────
const wss = new WebSocketServer({ port: WS_PORT });
const clients = new Set();
let currentScenario = buildScenario('normal');

wss.on('connection', (ws) => {
  const client = { ws, channels: new Set() };
  clients.add(client);

  // Send initial bridge-connected + status
  ws.send(JSON.stringify({ type: 'bridge-connected' }));
  ws.send(JSON.stringify({ type: 'status', iracing: true }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'subscribe' && Array.isArray(msg.channels)) {
        msg.channels.forEach(ch => client.channels.add(ch));
        // Push current scenario data for subscribed channels
        setTimeout(() => pushToClient(client, currentScenario), 100);
      }
    } catch(e) {}
  });

  ws.on('close', () => clients.delete(client));
});

function pushToClient(client, scenario) {
  client.channels.forEach(ch => {
    if (scenario[ch] !== undefined) {
      try {
        client.ws.send(JSON.stringify({ type: 'data', channel: ch, data: scenario[ch] }));
      } catch(e) {}
    }
  });
}

function broadcastChannel(channel, data) {
  currentScenario[channel] = data;
  const msg = JSON.stringify({ type: 'data', channel, data });
  clients.forEach(c => {
    if (c.channels.has(channel)) {
      try { c.ws.send(msg); } catch(e) {}
    }
  });
}

function broadcastScenario(scenario) {
  clients.forEach(client => pushToClient(client, scenario));
}

// ── Start ──────────────────────────────────────────────────────────
server.listen(HTTP_PORT, () => {
  console.log(`\n  Bridge Test Server`);
  console.log(`  ─────────────────`);
  console.log(`  Playground:  http://localhost:${HTTP_PORT}/`);
  console.log(`  Overlay URL: http://localhost:${HTTP_PORT}/overlays/{name}.html?scale=100&showHeader=true`);
  console.log(`  WebSocket:   ws://localhost:${WS_PORT}`);
  console.log(`  Push data:   POST http://localhost:${HTTP_PORT}/api/scenario/normal`);
  console.log(`               POST http://localhost:${HTTP_PORT}/api/scenario/extreme`);
  console.log(`               POST http://localhost:${HTTP_PORT}/api/scenario/minimal`);
  console.log(`               POST http://localhost:${HTTP_PORT}/api/scenario/empty\n`);
});

module.exports = { server, wss, HTTP_PORT, WS_PORT };
