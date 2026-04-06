'use strict';

/**
 * Lightweight iRacing .ibt telemetry file parser.
 * Extracts GPS track data (Lat, Lon, LapDistPct) without needing the iRacing SDK.
 * Works on any platform (Linux/macOS/Windows).
 */

const fs = require('fs');

const DATA_TYPES = [
  { name: 'char',     size: 1, read: (buf, off) => buf.readInt8(off) },
  { name: 'bool',     size: 1, read: (buf, off) => buf.readInt8(off) !== 0 },
  { name: 'int',      size: 4, read: (buf, off) => buf.readInt32LE(off) },
  { name: 'bitfield', size: 4, read: (buf, off) => buf.readUInt32LE(off) },
  { name: 'float',    size: 4, read: (buf, off) => buf.readFloatLE(off) },
  { name: 'double',   size: 8, read: (buf, off) => buf.readDoubleLE(off) },
];

/**
 * Parse an .ibt file and extract track GPS data.
 * @param {string|Buffer} input - File path or Buffer
 * @returns {{ trackName: string, trackData: Array<{x: number, y: number, pct: number}> }}
 */
function extractTrackFromIBT(input) {
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);

  if (buf.length < 112) throw new Error('File too small to be a valid .ibt');

  // File header
  const header = {
    numVars:           buf.readInt32LE(24),
    varHeaderOffset:   buf.readInt32LE(28),
    bufLen:            buf.readInt32LE(36),
    sessionInfoLen:    buf.readInt32LE(16),
    sessionInfoOffset: buf.readInt32LE(20),
    bufOffset:         buf.readInt32LE(48),
    bufCount:          buf.readInt32LE(52),
  };

  // If bufCount is 0, calculate from file size
  if (header.bufCount === 0 && header.bufLen > 0) {
    header.bufCount = Math.floor((buf.length - header.bufOffset) / header.bufLen);
  }

  if (header.bufCount < 100) throw new Error('Not enough telemetry samples (' + header.bufCount + ')');

  // Parse session info YAML to get track name
  let trackName = 'Unknown Track';
  try {
    const yaml = buf.toString('utf8', header.sessionInfoOffset, header.sessionInfoOffset + header.sessionInfoLen).replace(/\0+$/, '');
    const trackMatch = yaml.match(/TrackDisplayName:\s*(.+)/);
    if (trackMatch) trackName = trackMatch[1].trim();
  } catch(e) {}

  // Parse variable headers (144 bytes each)
  const varMap = {};
  for (let i = 0; i < header.numVars; i++) {
    const base = header.varHeaderOffset + i * 144;
    if (base + 144 > buf.length) break;
    const name = buf.toString('utf8', base + 32, base + 64).replace(/\0+$/, '');
    varMap[name] = {
      type:   buf.readInt32LE(base + 0),
      offset: buf.readInt32LE(base + 4),
      count:  buf.readInt32LE(base + 8),
    };
  }

  const latVar = varMap['Lat'];
  const lonVar = varMap['Lon'];
  const pctVar = varMap['LapDistPct'];

  if (!latVar || !lonVar || !pctVar) {
    throw new Error('Required variables not found: ' +
      [!latVar && 'Lat', !lonVar && 'Lon', !pctVar && 'LapDistPct'].filter(Boolean).join(', '));
  }

  // Extract GPS points into 500 slots (like bridge trackExtractor)
  const SLOT_COUNT = 500;
  const slots = new Array(SLOT_COUNT).fill(null);
  let filled = 0;
  const RAD_TO_DEG = 180 / Math.PI;

  // Sample every Nth record to stay under 2000 reads
  const sampleRate = Math.max(1, Math.floor(header.bufCount / 2000));

  for (let i = 0; i < header.bufCount; i += sampleRate) {
    const base = header.bufOffset + i * header.bufLen;
    if (base + header.bufLen > buf.length) break;

    const latRad = buf.readFloatLE(base + latVar.offset);
    const lonRad = buf.readFloatLE(base + lonVar.offset);
    const pct    = buf.readFloatLE(base + pctVar.offset);

    // Skip invalid data (car in garage, etc.)
    if (latRad === 0 && lonRad === 0) continue;
    if (pct < 0 || pct > 1) continue;

    const slotIdx = Math.floor(pct * SLOT_COUNT) % SLOT_COUNT;
    if (!slots[slotIdx]) filled++;
    slots[slotIdx] = { x: lonRad * RAD_TO_DEG, y: latRad * RAD_TO_DEG, pct };
  }

  if (filled < SLOT_COUNT * 0.4) {
    throw new Error('Not enough valid GPS data (' + filled + '/' + SLOT_COUNT + ' slots filled)');
  }

  // Build points array, smooth with moving average
  const raw = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (slots[i]) raw.push(slots[i]);
  }

  const win = 3;
  const points = [];
  for (let i = 0; i < raw.length; i++) {
    let sx = 0, sy = 0, count = 0;
    for (let j = -win; j <= win; j++) {
      const idx = (i + j + raw.length) % raw.length;
      sx += raw[idx].x;
      sy += raw[idx].y;
      count++;
    }
    points.push({ x: sx / count, y: sy / count, pct: raw[i].pct });
  }

  return { trackName, trackData: points };
}

module.exports = { extractTrackFromIBT };
