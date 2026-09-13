'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createShortcutManager,
  selectedTextMenuPresentation,
} = require('../src/shortcut-manager');

function fakeGlobalShortcut({ rejected = [] } = {}) {
  const registered = new Map();
  const registerCalls = [];
  const rejectedSet = new Set(rejected);
  return {
    registered,
    registerCalls,
    register(accelerator, callback) {
      registerCalls.push(accelerator);
      if (rejectedSet.has(accelerator)) return false;
      registered.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) {
      registered.delete(accelerator);
    },
    unregisterAll() {
      registered.clear();
    },
    isRegistered(accelerator) {
      return registered.has(accelerator);
    },
  };
}

test('registers both configured shortcuts and invokes the shared callback', () => {
  const globalShortcut = fakeGlobalShortcut();
  let calls = 0;
  const manager = createShortcutManager({
    globalShortcut,
    onShortcut: () => { calls += 1; },
  });

  const status = manager.registerAll('Control+Shift+Space', 'Control+Alt+D');

  assert.equal(status.allRegistered, true);
  assert.equal(status.anyRegistered, true);
  globalShortcut.registered.get('Control+Shift+Space')();
  assert.equal(calls, 1);
});

test('repairs a shortcut that disappears while the app is running', () => {
  const globalShortcut = fakeGlobalShortcut();
  const manager = createShortcutManager({ globalShortcut, onShortcut() {} });
  manager.registerAll('Control+Shift+Space', 'Control+Alt+D');
  globalShortcut.registered.delete('Control+Shift+Space');

  const result = manager.repair();

  assert.deepEqual(result.recovered, ['Control+Shift+Space']);
  assert.equal(result.status.primary.registered, true);
  assert.equal(result.status.allRegistered, true);
});

test('force-refreshes stale native registrations after a system transition', () => {
  const globalShortcut = fakeGlobalShortcut();
  const manager = createShortcutManager({ globalShortcut, onShortcut() {} });
  manager.registerAll('Control+Shift+Space', 'Control+Alt+D');

  const status = manager.refreshAll();

  assert.equal(status.allRegistered, true);
  assert.deepEqual(globalShortcut.registerCalls, [
    'Control+Shift+Space',
    'Control+Alt+D',
    'Control+Shift+Space',
    'Control+Alt+D',
  ]);
});

test('keeps failed registrations visible in health status', () => {
  const globalShortcut = fakeGlobalShortcut({ rejected: ['Control+Alt+D'] });
  const manager = createShortcutManager({ globalShortcut, onShortcut() {} });

  const status = manager.registerAll('Control+Shift+Space', 'Control+Alt+D');

  assert.equal(status.primary.registered, true);
  assert.equal(status.secondary.registered, false);
  assert.equal(status.allRegistered, false);
  assert.equal(status.anyRegistered, true);
});

test('highlights Read selected text when Accessibility is unavailable', () => {
  const presentation = selectedTextMenuPresentation({
    accessibilityGranted: false,
    status: {
      primary: { configured: true, registered: true },
      secondary: { configured: true, registered: true },
      allRegistered: true,
      anyRegistered: true,
    },
  });

  assert.equal(presentation.needsAttention, true);
  assert.match(presentation.label, /^\u26a0\ufe0f/);
  assert.match(presentation.sublabel, /Accessibility/);
});

test('highlights Read selected text when either shortcut is unavailable', () => {
  const presentation = selectedTextMenuPresentation({
    accessibilityGranted: true,
    status: {
      primary: { configured: true, registered: true },
      secondary: { configured: true, registered: false },
      allRegistered: false,
      anyRegistered: true,
    },
  });

  assert.equal(presentation.needsAttention, true);
  assert.match(presentation.label, /^\u26a0\ufe0f/);
  assert.match(presentation.sublabel, /One shortcut/);
});

test('keeps Read selected text prominent without a warning when healthy', () => {
  const presentation = selectedTextMenuPresentation({
    accessibilityGranted: true,
    status: {
      primary: { configured: true, registered: true },
      secondary: { configured: true, registered: true },
      allRegistered: true,
      anyRegistered: true,
    },
  });

  assert.equal(presentation.needsAttention, false);
  assert.equal(presentation.label, '\u25b6 Read selected text');
  assert.equal(presentation.sublabel, 'Uses the current selection, just like the shortcut');
});
