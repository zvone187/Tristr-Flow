'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('saves settings privately and keeps the previous session on replacement failure', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tristr-account-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Electron only exposes app.getPath inside the desktop process.
  const electronModule = require.resolve('electron');
  const original = require.cache[electronModule];
  require.cache[electronModule] = { exports: { app: { getPath: () => dir } } };
  const settings = require('../src/settings');
  t.after(() => {
    delete require.cache[require.resolve('../src/settings')];
    if (original) require.cache[electronModule] = original;
    else delete require.cache[electronModule];
  });

  const file = settings.settingsPath();
  fs.writeFileSync(file, '{}');
  fs.chmodSync(file, 0o644);
  const previous = { serviceToken: 'test-session', voiceId: 'test-voice' };
  assert.equal(settings.save(previous), true);
  assert.deepEqual(settings.load(), previous);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  let replacement;
  t.mock.method(console, 'error', () => {});
  t.mock.method(fs, 'renameSync', (source, destination) => {
    replacement = { source, destination, mode: fs.statSync(source).mode & 0o777 };
    throw new Error('Simulated rename failure');
  });
  assert.equal(settings.save({ serviceToken: '', voiceId: 'updated' }), false);
  assert.equal(path.dirname(replacement.source), dir);
  assert.equal(replacement.destination, file);
  assert.notEqual(replacement.source, file);
  assert.equal(replacement.mode, 0o600);
  assert.deepEqual(settings.load(), previous);
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
});
