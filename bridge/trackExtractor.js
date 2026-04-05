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
const SCANNED_FILE = path.join(os.homedir(), 'Documents', 'Atleta Bridge', 'scanned_ibts.json');
const SLOT_COUNT = 500;

// Track which files we've already scanned so we don't re-process
function loadScannedList() {
  try {
    if (fs.existsSync(SCANNED_FILE)) return JSON.parse(fs.readFileSync(SCANNED_FILE, 'utf8'));
  } catch(e) {}
  return {};
}

function saveScannedList(list) {
  try {
    const dir = path.dirname(SCANNED_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SCANNED_FILE, JSON.stringify(list));
  } catch(e) {}
}

/**
 * Extract track layout from a single .ibt file.
 * Returns { trackName, points } or null.
 */
function extractFromFile(filePath) {
  let ibt = null;
  try {
    const { IBT } = require('@emiliosp/node-iracing-sdk');
    ibt = new IBT();
    ibt.open(filePath);

    const vars = ibt.varHeadersNamesList;
    if (!vars || !vars.includes('Lat') || !vars.includes('Lon') || !vars.includes('LapDistPct')) {
      ibt.close();
      return null;
    }

    const recordCount = ibt.sessionRecordCount;
    if (recordCount < 100) { ibt.close(); return null; }

    // Get track name from filename (format: "YYYY-MM-DD HH-MM-SS TrackName CarName.ibt")
    // We'll use the filename as a fallback identifier
    const basename = path.basename(filePath, '.ibt');

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

    // Build path from filled slots
    const points = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      if (slots[i]) points.push(slots[i]);
    }

    // Smooth
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

    return { trackName: basename, points: smoothed, filled };
  } catch(e) {
    if (ibt) try { ibt.close(); } catch(e2) {}
    return null;
  }
}

/**
 * Extract track layout for a specific track from .ibt files.
 */
async function extractTrackFromIBT(trackDisplayName) {
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
    log('[TrackExtract] Scanning for ' + trackDisplayName + ' in ' + files.length + ' .ibt files');

    for (const entry of files.slice(0, 10)) {
      const result = extractFromFile(path.join(IBT_DIR, entry.file));
      if (result && result.points.length > 50) {
        log('[TrackExtract] Found track in ' + entry.file + ' (' + result.points.length + ' points)');
        return result.points;
      }
    }
    return null;
  } catch(e) {
    log('[TrackExtract] Error: ' + e.message);
    return null;
  }
}

/**
 * Bulk scan: process ALL .ibt files, extract unique tracks, cache locally + upload to server.
 * Runs in background on app startup. Skips already-scanned files.
 */
async function bulkScanIBTs(uploadFn) {
  try {
    if (!fs.existsSync(IBT_DIR)) {
      log('[BulkScan] Telemetry dir not found: ' + IBT_DIR);
      return;
    }

    const files = fs.readdirSync(IBT_DIR).filter(f => f.endsWith('.ibt'));
    if (files.length === 0) { log('[BulkScan] No .ibt files found'); return; }

    const scanned = loadScannedList();
    const newFiles = files.filter(f => !scanned[f]);
    if (newFiles.length === 0) { log('[BulkScan] All ' + files.length + ' .ibt files already scanned'); return; }

    log('[BulkScan] Scanning ' + newFiles.length + ' new .ibt files (of ' + files.length + ' total)');

    // Track unique tracks we've extracted (keyed by approximate lat/lon center to deduplicate)
    const extracted = {};
    let processedCount = 0;
    let extractedCount = 0;

    for (const file of newFiles) {
      processedCount++;
      const filePath = path.join(IBT_DIR, file);

      try {
        const result = extractFromFile(filePath);
        scanned[file] = true; // Mark as scanned regardless of result

        if (result && result.points.length > 50) {
          // Generate a track key from the center coordinates (deduplicate same track, different sessions)
          const avgX = result.points.reduce((s, p) => s + p.x, 0) / result.points.length;
          const avgY = result.points.reduce((s, p) => s + p.y, 0) / result.points.length;
          const trackKey = avgX.toFixed(3) + '_' + avgY.toFixed(3);

          if (!extracted[trackKey] || result.filled > extracted[trackKey].filled) {
            extracted[trackKey] = { file, points: result.points, filled: result.filled, trackName: result.trackName };
          }
          extractedCount++;
        }
      } catch(e) {
        scanned[file] = true; // Don't retry broken files
      }

      // Log progress every 20 files
      if (processedCount % 20 === 0) {
        log('[BulkScan] Progress: ' + processedCount + '/' + newFiles.length + ' files, ' + extractedCount + ' tracks extracted');
      }
    }

    // Save scanned list so we don't re-process next time
    saveScannedList(scanned);

    // Cache and upload unique tracks
    const trackKeys = Object.keys(extracted);
    log('[BulkScan] Found ' + trackKeys.length + ' unique tracks from ' + newFiles.length + ' files');

    if (!fs.existsSync(TRACK_MAPS_DIR)) fs.mkdirSync(TRACK_MAPS_DIR, { recursive: true });

    for (const key of trackKeys) {
      const track = extracted[key];
      // Use the .ibt filename as the track name (best we have without session info parsing)
      const trackName = track.trackName;
      const cacheFile = path.join(TRACK_MAPS_DIR, trackName.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');

      // Save locally
      try { fs.writeFileSync(cacheFile, JSON.stringify(track.points)); } catch(e) {}

      // Upload to server
      if (uploadFn) {
        try { uploadFn(trackName, track.points); } catch(e) {}
      }

      log('[BulkScan] Stored: ' + trackName + ' (' + track.points.length + ' points)');
    }

    log('[BulkScan] Complete! ' + trackKeys.length + ' tracks stored and uploaded');
  } catch(e) {
    log('[BulkScan] Error: ' + e.message);
  }
}

module.exports = { extractTrackFromIBT, bulkScanIBTs };
