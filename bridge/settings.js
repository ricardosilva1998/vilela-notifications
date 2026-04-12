'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SETTINGS_DIR = path.join(os.homedir(), 'Documents', 'Atleta Racing');
const LEGACY_DIR = path.join(os.homedir(), 'Documents', 'Atleta Bridge');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

// One-shot rename of the legacy "Atleta Bridge" directory to "Atleta Racing".
// Runs on every load() but is a no-op after the first successful rename.
function migrateLegacyDir() {
  try {
    if (fs.existsSync(SETTINGS_DIR)) return;
    if (!fs.existsSync(LEGACY_DIR)) return;
    fs.renameSync(LEGACY_DIR, SETTINGS_DIR);
    console.log('[Settings] Migrated ~/Documents/Atleta Bridge -> Atleta Racing');
  } catch(e) {
    console.error('[Settings] Migration failed:', e.message);
  }
}

function load() {
  let settings = {};
  try {
    migrateLegacyDir();
    if (!fs.existsSync(SETTINGS_DIR)) fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    if (fs.existsSync(SETTINGS_FILE)) settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch(e) {}

  // Generate Bridge ID on first launch
  if (!settings.bridgeId) {
    settings.bridgeId = crypto.randomUUID();
    save(settings);
  }

  return settings;
}

function save(settings) {
  try {
    if (!fs.existsSync(SETTINGS_DIR)) fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch(e) { console.error('[Settings] Save error:', e.message); }
}

function getSettingsDir() {
  migrateLegacyDir();
  return SETTINGS_DIR;
}

module.exports = { load, save, getSettingsDir };
