'use strict';

const { app, globalShortcut } = require('electron');

app.whenReady().then(() => {
  const accelerators = process.argv.slice(2);
  const result = {};
  for (const accelerator of accelerators) {
    try {
      result[accelerator] = globalShortcut.register(accelerator, () => {});
    } catch {
      result[accelerator] = false;
    }
  }
  console.log(JSON.stringify(result));
  const holdMs = Math.max(0, Number(process.env.SHORTCUT_PROBE_HOLD_MS) || 0);
  setTimeout(() => {
    globalShortcut.unregisterAll();
    app.quit();
  }, holdMs);
});
