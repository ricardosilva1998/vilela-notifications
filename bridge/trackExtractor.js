'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const logPath = path.join(os.homedir(), 'atleta-bridge.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(msg);
  try { fs.appendFileSync(logPath, line); } catch(e) {}
}

const IBT_DIR = path.join(os.homedir(), 'Documents', 'iRacing', 'telemetry');
const TRACK_MAPS_DIR = path.join(os.homedir(), 'Documents', 'Atleta Bridge', 'trackmaps');
const SCANNED_FILE = path.join(TRACK_MAPS_DIR, 'scanned_ibts.json');
const SLOT_COUNT = 500;

function loadScannedList() {
  try {
    if (fs.existsSync(SCANNED_FILE)) return JSON.parse(fs.readFileSync(SCANNED_FILE, 'utf8'));
  } catch(e) {}
  return {};
}

function saveScannedList(list) {
  try {
    if (!fs.existsSync(TRACK_MAPS_DIR)) fs.mkdirSync(TRACK_MAPS_DIR, { recursive: true });
    fs.writeFileSync(SCANNED_FILE, JSON.stringify(list));
  } catch(e) {}
}

// Generate a geo-key from center coordinates (matches tracks within ~100m)
function geoKey(points) {
  const avgX = points.reduce((s, p) => s + p.x, 0) / points.length;
  const avgY = points.reduce((s, p) => s + p.y, 0) / points.length;
  return avgY.toFixed(2) + '_' + avgX.toFixed(2);
}

// Generate a geo-key from TrackLatitude/TrackLongitude strings (e.g., "49.327833 m")
function geoKeyFromSessionInfo(trackLat, trackLon) {
  const lat = parseFloat(trackLat) || 0;
  const lon = parseFloat(trackLon) || 0;
  if (lat === 0 && lon === 0) return null;
  return lat.toFixed(2) + '_' + lon.toFixed(2);
}

/**
 * Extract track layout from a single .ibt file using the SDK's IBT reader.
 * Returns { geoId, points, filled } or null.
 */
async function extractFromFile(filePath) {
  let ibt = null;
  try {
    const sdk = await import('@emiliosp/node-iracing-sdk');
    const IBT = sdk.IBT;
    ibt = new IBT();
    ibt.open(filePath);

    const vars = ibt.varHeadersNamesList;
    if (!vars || !vars.includes('Lat') || !vars.includes('Lon') || !vars.includes('LapDistPct')) {
      ibt.close();
      return null;
    }

    const recordCount = ibt.sessionRecordCount;
    if (recordCount < 100) { ibt.close(); return null; }

    const sampleRate = Math.max(1, Math.floor(recordCount / 2000));
    const slots = new Array(SLOT_COUNT).fill(null);
    let filled = 0;

    for (let i = 0; i < recordCount; i += sampleRate) {
      try {
        const lat = ibt.get(i, 'Lat');
        const lon = ibt.get(i, 'Lon');
        const pctArr = ibt.get(i, 'LapDistPct');

        const latVal = Array.isArray(lat) ? lat[0] : lat;
        const lonVal = Array.isArray(lon) ? lon[0] : lon;
        const pctVal = Array.isArray(pctArr) ? pctArr[0] : pctArr;

        if (latVal && lonVal && pctVal >= 0 && pctVal <= 1 && latVal !== 0 && lonVal !== 0) {
          const slotIdx = Math.floor(pctVal * SLOT_COUNT) % SLOT_COUNT;
          if (!slots[slotIdx]) filled++;
          slots[slotIdx] = { x: lonVal, y: latVal, pct: pctVal };
        }
      } catch(e) { /* skip bad frames */ }
    }

    ibt.close();
    ibt = null;

    if (filled < SLOT_COUNT * 0.5) return null;

    const points = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      if (slots[i]) points.push(slots[i]);
    }

    // Smooth with moving average
    const win = 3;
    const smoothed = [];
    for (let i = 0; i < points.length; i++) {
      let sx = 0, sy = 0, count = 0;
      for (let j = -win; j <= win; j++) {
        const idx = (i + j + points.length) % points.length;
        sx += points[idx].x; sy += points[idx].y; count++;
      }
      smoothed.push({ x: sx / count, y: sy / count, pct: points[i].pct });
    }

    return { geoId: geoKey(smoothed), points: smoothed, filled };
  } catch(e) {
    log('[TrackExtract] File error (' + path.basename(filePath) + '): ' + e.message);
    if (ibt) try { ibt.close(); } catch(e2) {}
    return null;
  }
}

/**
 * Load a cached track by geo-key (TrackLatitude/TrackLongitude from session info).
 */
function loadCachedTrackByGeo(geoId) {
  try {
    if (!geoId) return null;
    const file = path.join(TRACK_MAPS_DIR, 'geo_' + geoId + '.json');
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && data.length > 50) return data;
    }
  } catch(e) {}
  return null;
}

/**
 * Save a track by geo-key.
 */
function saveCachedTrackByGeo(geoId, points) {
  try {
    if (!fs.existsSync(TRACK_MAPS_DIR)) fs.mkdirSync(TRACK_MAPS_DIR, { recursive: true });
    const file = path.join(TRACK_MAPS_DIR, 'geo_' + geoId + '.json');
    fs.writeFileSync(file, JSON.stringify(points));
  } catch(e) {}
}

/**
 * Extract track for current session — try to find a matching .ibt file.
 */
async function extractTrackFromIBT() {
  try {
    if (!fs.existsSync(IBT_DIR)) return null;

    const files = fs.readdirSync(IBT_DIR)
      .filter(f => f.endsWith('.ibt'))
      .map(f => {
        try { return { file: f, mtime: fs.statSync(path.join(IBT_DIR, f)).mtime.getTime() }; }
        catch(e) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return null;

    for (const entry of files.slice(0, 5)) {
      const result = await extractFromFile(path.join(IBT_DIR, entry.file));
      if (result && result.points.length > 50) {
        log('[TrackExtract] Extracted from ' + entry.file + ' (' + result.points.length + ' pts, geo=' + result.geoId + ')');
        return result;
      }
    }
    return null;
  } catch(e) {
    log('[TrackExtract] Error: ' + e.message);
    return null;
  }
}

/**
 * Bulk scan ALL .ibt files on startup. Extracts unique tracks, caches + uploads.
 */
async function bulkScanIBTs(uploadFn) {
  try {
    if (!fs.existsSync(IBT_DIR)) {
      log('[BulkScan] No iRacing telemetry folder found');
      return;
    }

    const files = fs.readdirSync(IBT_DIR).filter(f => f.endsWith('.ibt'));
    if (files.length === 0) { log('[BulkScan] No .ibt files'); return; }

    const scanned = loadScannedList();
    const newFiles = files.filter(f => !scanned[f]);
    if (newFiles.length === 0) {
      log('[BulkScan] All ' + files.length + ' .ibt files already scanned');
      return;
    }

    log('[BulkScan] Scanning ' + newFiles.length + ' new .ibt files...');

    const tracks = {}; // geoId -> { points, filled }
    let processed = 0;

    for (const file of newFiles) {
      processed++;
      try {
        const result = await extractFromFile(path.join(IBT_DIR, file));
        scanned[file] = true;

        if (result && result.points.length > 50) {
          if (!tracks[result.geoId] || result.filled > tracks[result.geoId].filled) {
            tracks[result.geoId] = result;
          }
        }
      } catch(e) {
        scanned[file] = true;
      }

      if (processed % 10 === 0) {
        log('[BulkScan] ' + processed + '/' + newFiles.length + ' files, ' + Object.keys(tracks).length + ' tracks found');
      }
    }

    saveScannedList(scanned);

    const geoIds = Object.keys(tracks);
    log('[BulkScan] Extracted ' + geoIds.length + ' unique tracks');

    if (!fs.existsSync(TRACK_MAPS_DIR)) fs.mkdirSync(TRACK_MAPS_DIR, { recursive: true });

    for (const geoId of geoIds) {
      const track = tracks[geoId];
      saveCachedTrackByGeo(geoId, track.points);
      if (uploadFn) {
        try { uploadFn(geoId, track.points); } catch(e) {}
      }
      log('[BulkScan] Stored track geo=' + geoId + ' (' + track.points.length + ' points)');
    }

    log('[BulkScan] Done! ' + geoIds.length + ' tracks cached + uploaded');
  } catch(e) {
    log('[BulkScan] Error: ' + e.message);
  }
}

module.exports = { extractTrackFromIBT, bulkScanIBTs, geoKeyFromSessionInfo, loadCachedTrackByGeo, saveCachedTrackByGeo };
