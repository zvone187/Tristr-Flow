'use strict';

const fs = require('fs');
const path = require('path');
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
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[settings] save failed:', e);
    return false;
  }
}

module.exports = { load, save, settingsPath };
