const { spawn } = require('child_process');
const { Readable } = require('stream');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const db = require('../db');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const RESTORE_DIR = '/tmp/sync-restore';

let lastSync = { time: null, status: 'never', error: null };

async function performSync() {
  if (!config.app.syncSourceUrl || !config.app.syncSecret) {
    console.log('[Sync] Skipping — SYNC_SOURCE_URL or SYNC_SECRET not set');
    return;
  }

  console.log(`[Sync] Starting data sync from ${config.app.syncSourceUrl}...`);
  lastSync = { time: new Date().toISOString(), status: 'in_progress', error: null };

  try {
    // Download backup tarball from prod
    const res = await fetch(`${config.app.syncSourceUrl}/sync/backup`, {
      headers: { Authorization: `Bearer ${config.app.syncSecret}` },
    });

    if (!res.ok) {
      throw new Error(`Backup endpoint returned ${res.status}: ${await res.text()}`);
    }

    // Prepare restore directory
    fs.rmSync(RESTORE_DIR, { recursive: true, force: true });
    fs.mkdirSync(RESTORE_DIR, { recursive: true });

    // Extract tar.gz to temp directory
    await new Promise((resolve, reject) => {
      const tar = spawn('tar', ['xzf', '-', '-C', RESTORE_DIR]);

      // Pipe fetch response body to tar stdin
      const nodeStream = Readable.fromWeb(res.body);
      nodeStream.pipe(tar.stdin);

      let stderr = '';
      tar.stderr.on('data', (chunk) => { stderr += chunk; });

      tar.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar extract failed (code ${code}): ${stderr}`));
      });

      tar.on('error', reject);
      nodeStream.on('error', reject);
    });

    console.log('[Sync] Download complete, restoring data...');

    // Close the database before replacing the file
    db.closeDb();
    console.log('[Sync] Database closed');

    // Replace database file
    const backupDb = path.join(RESTORE_DIR, 'bot.db.backup');
    if (fs.existsSync(backupDb)) {
      const destDb = path.join(DATA_DIR, 'bot.db');
      fs.copyFileSync(backupDb, destDb);
      // Remove WAL/SHM files — SQLite will recreate them
      try { fs.unlinkSync(destDb + '-wal'); } catch {}
      try { fs.unlinkSync(destDb + '-shm'); } catch {}
      console.log('[Sync] Database restored');
    }

    // Replace media directories
    for (const dir of ['sounds', 'sponsors', 'vtuber-models']) {
      const src = path.join(RESTORE_DIR, dir);
      const dest = path.join(DATA_DIR, dir);
      if (fs.existsSync(src)) {
        fs.rmSync(dest, { recursive: true, force: true });
        fs.cpSync(src, dest, { recursive: true });
        console.log(`[Sync] Restored ${dir}/`);
      }
    }

    // Clean up temp directory
    fs.rmSync(RESTORE_DIR, { recursive: true, force: true });

    lastSync = { time: new Date().toISOString(), status: 'success', error: null };
    console.log('[Sync] Data restored, restarting process...');
    process.exit(0); // Railway auto-restarts the container
  } catch (err) {
    lastSync = { time: new Date().toISOString(), status: 'error', error: err.message };
    console.error(`[Sync] Failed: ${err.message}`);
    // Clean up temp directory on error
    try { fs.rmSync(RESTORE_DIR, { recursive: true, force: true }); } catch {}
    // Don't crash — dev keeps running with its existing data
  }
}

module.exports = { performSync, lastSync };
