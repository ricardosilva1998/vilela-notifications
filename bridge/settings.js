'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_DIR = path.join(os.homedir(), 'Documents', 'Atleta Bridge');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

function load() {
  try {
    if (!fs.existsSync(SETTINGS_DIR)) fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch(e) {}
  return {};
}

function save(settings) {
  try {
    if (!fs.existsSync(SETTINGS_DIR)) fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch(e) { console.error('[Settings] Save error:', e.message); }
}

module.exports = { load, save };
