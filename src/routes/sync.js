const { Router } = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const db = require('../db');

const router = Router();
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const BACKUP_FILE = 'bot.db.backup';

function requireSyncSecret(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!config.app.syncSecret || token !== config.app.syncSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// GET /sync/backup — stream tar.gz of /app/data (prod side)
router.get('/backup', requireSyncSecret, async (req, res) => {
  const backupPath = path.join(DATA_DIR, BACKUP_FILE);

  try {
    // Create consistent SQLite snapshot
    await db.backup(backupPath);
    console.log('[Sync] Database backup created');

    // Build list of items to include in tar
    const items = [BACKUP_FILE];
    for (const dir of ['sounds', 'sponsors', 'vtuber-models']) {
      if (fs.existsSync(path.join(DATA_DIR, dir))) items.push(dir);
    }

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Transfer-Encoding', 'chunked');

    const tar = spawn('tar', ['czf', '-', ...items], { cwd: DATA_DIR });

    tar.stdout.pipe(res);

    tar.stderr.on('data', (chunk) => {
      console.error(`[Sync] tar stderr: ${chunk}`);
    });

    tar.on('close', (code) => {
      // Clean up backup file
      try { fs.unlinkSync(backupPath); } catch {}
      if (code !== 0) console.error(`[Sync] tar exited with code ${code}`);
    });

    // If client disconnects, kill tar
    req.on('close', () => {
      tar.kill();
      try { fs.unlinkSync(backupPath); } catch {}
    });
  } catch (err) {
    console.error(`[Sync] Backup error: ${err.message}`);
    try { fs.unlinkSync(backupPath); } catch {}
    if (!res.headersSent) res.status(500).json({ error: 'Backup failed' });
  }
});

// POST /sync/trigger — manually trigger a sync (dev side)
router.post('/trigger', requireSyncSecret, (req, res) => {
  if (!config.app.syncSourceUrl) {
    return res.status(400).json({ error: 'SYNC_SOURCE_URL not configured' });
  }

  const { performSync } = require('../services/sync');
  performSync();
  res.json({ status: 'started' });
});

// GET /sync/status — last sync info
router.get('/status', requireSyncSecret, (req, res) => {
  try {
    const { lastSync } = require('../services/sync');
    res.json(lastSync);
  } catch {
    res.json({ time: null, status: 'never' });
  }
});

module.exports = router;
