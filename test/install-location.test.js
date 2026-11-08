'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { needsInstallation, offerInstallation } = require('../src/install-location');

test('only packaged macOS apps outside Applications need installation', () => {
  for (const [platform, isPackaged, inApplications, expected] of [
    ['darwin', true, false, true],
    ['darwin', true, true, false],
    ['darwin', false, false, false],
    ['linux', true, false, false],
  ]) {
    const app = { isPackaged };
    if (platform === 'darwin' && isPackaged) app.isInApplicationsFolder = () => inApplications;
    assert.equal(needsInstallation(app, platform), expected);
  }
});

function installer(t, { response = 0, move } = {}) {
  const messages = [];
  let moves = 0;
  let quits = 0;
  const applications = fs.mkdtempSync(path.join(os.tmpdir(), 'tristr-installer-'));
  t.after(() => fs.rmSync(applications, { recursive: true, force: true }));
  const app = {
    getPath: () => '/Volumes/Tristr Flow/Tristr Flow.app/Contents/MacOS/Tristr Flow',
    moveToApplicationsFolder(options) {
      moves++;
      return move(options);
    },
    quit() { quits++; },
  };
  const dialog = { async showMessageBox(message) {
    messages.push(message);
    return { response };
  } };
  return { run: () => offerInstallation(app, dialog, applications), applications, messages, moves: () => moves, quits: () => quits };
}

test('accepting installation moves a new copy and lets Electron relaunch it', async (t) => {
  const ui = installer(t, { move: () => true });
  await ui.run();
  assert.equal(ui.messages.length, 1);
  assert.match(ui.messages[0].buttons[0], /Applications/);
  assert.equal(ui.moves(), 1);
  assert.equal(ui.quits(), 0);
});

test('declining the move quits without touching installed apps', async (t) => {
  const ui = installer(t, { response: 1 });
  await ui.run();
  assert.equal(ui.moves(), 0);
  assert.equal(ui.quits(), 1);
});

for (const conflict of ['exists', 'existsAndRunning']) {
  test(`an existing copy (${conflict}) requires manual replacement in Finder`, async (t) => {
    let resolvedAutomatically;
    const ui = installer(t, { move: ({ conflictHandler }) => {
      resolvedAutomatically = conflictHandler(conflict);
      return false;
    } });
    await ui.run();
    assert.equal(resolvedAutomatically, false);
    assert.equal(ui.messages.length, 2);
    assert.match(ui.messages[1].detail, /quit/i);
    assert.match(ui.messages[1].detail, /Applications/);
    assert.equal(ui.quits(), 1);
  });
}

test('an existing destination or missing Applications folder never invokes the native mover', async (t) => {
  for (const prepare of [
    (dest) => fs.mkdirSync(path.join(dest, 'Tristr Flow.app')),
    (dest) => fs.symlinkSync('missing-target', path.join(dest, 'Tristr Flow.app')),
    (dest) => fs.rmdirSync(dest),
  ]) {
    const ui = installer(t);
    prepare(ui.applications);
    await ui.run();
    assert.equal(ui.moves(), 0);
    assert.match(ui.messages.at(-1).detail, /Applications/);
    assert.equal(ui.quits(), 1);
  }
});

test('a failed move explains how to install manually and exits', async (t) => {
  const ui = installer(t, { move: () => { throw new Error('read-only destination'); } });
  await ui.run();
  assert.equal(ui.messages.length, 2);
  assert.match(ui.messages[1].detail, /Applications/);
  assert.equal(ui.quits(), 1);
});
