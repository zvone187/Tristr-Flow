'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('node:crypto');
const { app } = require('electron');

// User-chosen settings (voice, speed) persisted across restarts in the app's
// userData dir. Defaults come from config.js; this only stores overrides.
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function save(obj) {
  let pendingFile;
  try {
    const file = settingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporaryPath = `${file}.${randomUUID()}.tmp`;
    const descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    pendingFile = temporaryPath;
    try {
      fs.writeFileSync(descriptor, JSON.stringify(obj, null, 2), 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(pendingFile, file);
    return true;
  } catch (e) {
    if (pendingFile) {
      try { fs.unlinkSync(pendingFile); }
      catch (cleanupError) { console.error('[settings] temporary file cleanup failed:', cleanupError); }
    }
    console.error('[settings] save failed:', e);
    return false;
  }
}

module.exports = { load, save, settingsPath };
