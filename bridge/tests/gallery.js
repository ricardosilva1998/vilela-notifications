const http = require('http');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'test-results', 'artifacts');
const PORT = 9401;

// Collect all screenshots with test info from folder names
const shots = [];
fs.readdirSync(DIR).forEach(folder => {
  const png = path.join(DIR, folder, 'test-finished-1.png');
  const pngFail = path.join(DIR, folder, 'test-failed-1.png');
  const file = fs.existsSync(png) ? png : fs.existsSync(pngFail) ? pngFail : null;
  if (!file) return;
  // Parse folder name into test info
  const name = folder.replace(/-chromium$/, '').replace(/^overlays-/, '');
  shots.push({ name, file, folder });
});
shots.sort((a, b) => a.name.localeCompare(b.name));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Serve individual image
  if (url.pathname.startsWith('/img/')) {
    const folder = decodeURIComponent(url.pathname.replace('/img/', ''));
    const png = path.join(DIR, folder, 'test-finished-1.png');
    const pngFail = path.join(DIR, folder, 'test-failed-1.png');
    const file = fs.existsSync(png) ? png : pngFail;
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(fs.readFileSync(file));
    } else {
      res.writeHead(404); res.end();
    }
    return;
  }

  // Filter
  const filter = url.searchParams.get('q') || '';

  const filtered = filter ? shots.filter(s => s.name.toLowerCase().includes(filter.toLowerCase())) : shots;

  let html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Overlay Test Gallery (${filtered.length} screenshots)</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0d0e14; color:#e8e6f0; font-family:'Segoe UI',sans-serif; padding:16px; }
  .toolbar { position:sticky; top:0; z-index:10; background:#13141c; padding:12px 16px; border-radius:8px; margin-bottom:16px; display:flex; gap:12px; align-items:center; border:1px solid rgba(255,255,255,0.06); }
  .toolbar h1 { font-size:16px; font-weight:700; }
  .toolbar input { background:#1a1b25; color:#e8e6f0; border:1px solid rgba(255,255,255,0.1); border-radius:6px; padding:6px 12px; font-size:12px; width:300px; }
  .toolbar .count { font-size:11px; color:rgba(255,255,255,0.4); margin-left:auto; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(350px, 1fr)); gap:12px; }
  .card { background:#13141c; border:1px solid rgba(255,255,255,0.06); border-radius:8px; overflow:hidden; }
  .card-label { padding:6px 10px; font-size:9px; font-weight:600; color:rgba(255,255,255,0.4); letter-spacing:0.5px; text-transform:uppercase; background:rgba(255,255,255,0.03); border-bottom:1px solid rgba(255,255,255,0.04); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .card img { width:100%; display:block; cursor:pointer; }
  .card img:hover { opacity:0.9; }
  .modal { display:none; position:fixed; inset:0; z-index:100; background:rgba(0,0,0,0.9); align-items:center; justify-content:center; cursor:pointer; }
  .modal.open { display:flex; }
  .modal img { max-width:95vw; max-height:95vh; border-radius:8px; }
</style></head><body>
<div class="toolbar">
  <h1>Test Gallery</h1>
  <form method="get"><input name="q" placeholder="Filter... (e.g. standings, extreme, scale=200)" value="${filter}"></form>
  <span class="count">${filtered.length} / ${shots.length} screenshots</span>
</div>
<div class="grid">`;

  filtered.forEach(s => {
    html += `<div class="card"><div class="card-label" title="${s.name}">${s.name}</div><img src="/img/${encodeURIComponent(s.folder)}" loading="lazy" onclick="openModal(this.src)"></div>`;
  });

  html += `</div>
<div class="modal" id="modal" onclick="this.classList.remove('open')"><img id="modal-img"></div>
<script>
function openModal(src) { document.getElementById('modal-img').src = src; document.getElementById('modal').classList.add('open'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('modal').classList.remove('open'); });
</script></body></html>`;

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});

server.listen(PORT, () => {
  console.log(`\n  Screenshot Gallery: http://localhost:${PORT}`);
  console.log(`  Filter examples:   http://localhost:${PORT}?q=standings`);
  console.log(`                     http://localhost:${PORT}?q=extreme`);
  console.log(`                     http://localhost:${PORT}?q=scale=200\n`);
});
