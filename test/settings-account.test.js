'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const src = path.join(__dirname, '../src');
const html = fs.readFileSync(path.join(src, 'settings.html'), 'utf8');
const script = fs.readFileSync(path.join(src, 'settings-renderer.js'), 'utf8');
const tick = () => new Promise(setImmediate);

function openPreferences(account, { api = {}, Audio } = {}) {
  const elements = new Map();
  const created = [];
  function element() {
    const el = new EventTarget();
    return Object.assign(el, {
      textContent: '', dataset: {}, classList: { toggle() {}, remove() {} },
      querySelectorAll: () => [], appendChild() {},
    });
  }
  for (const [, id] of html.matchAll(/ id="([^"]+)"/g)) elements.set(id, element());
  const document = new EventTarget();
  Object.assign(document, {
    getElementById: id => elements.get(id),
    querySelectorAll: selector => created.filter(el => '.' + el.className === selector),
    createElement: () => { const el = element(); created.push(el); return el; },
  });
  const window = new EventTarget();
  let signalChange;
  let logouts = 0;
  window.prefs = {
    get: async () => ({ speed: 1 }),
    listVoices: () => new Promise(() => {}),
    account,
    onAccountChanged(callback) { signalChange = callback; return () => {}; },
    logout: async () => { logouts++; return { ok: true }; },
    ...api,
  };
  vm.runInNewContext(script, { window, document, Audio });
  return { get: id => elements.get(id), balanceChanged: () => signalChange(), window, preview: () => document.querySelectorAll('.preview')[0], logouts: () => logouts };
}

test('account controls display an exhausted Basic balance and work while voices load', async () => {
  let dollars = '0.00';
  const prefs = openPreferences(async () => ({
    signedIn: true, email: 'reader@example.test', plan: 'basic', creditsDollars: dollars, minutesLeft: 0,
  }));
  await tick();
  assert.match(prefs.get('acctinfo').textContent, /reader@example\.test/);
  assert.match(prefs.get('acctinfo').textContent, /Basic/);
  assert.match(prefs.get('acctinfo').textContent, /\$0\.00/);
  assert.match(prefs.get('acctinfo').textContent, /0 min/);
  dollars = '1.25';
  prefs.balanceChanged();
  await tick();
  assert.match(prefs.get('acctinfo').textContent, /\$1\.25/);
  prefs.get('btnlogout').dispatchEvent(new Event('click'));
  await tick();
  assert.equal(prefs.logouts(), 1);
});

test('a late account refresh cannot overwrite a newer backend balance', async () => {
  let finishFirst;
  let calls = 0;
  const zero = { signedIn: true, email: 'reader@example.test', creditsDollars: '0.00', minutesLeft: 0 };
  const prefs = openPreferences(() => ++calls === 1
    ? new Promise(resolve => { finishFirst = resolve; })
    : Promise.resolve(zero));
  await tick();
  prefs.window.dispatchEvent(new Event('focus'));
  await tick();
  assert.match(prefs.get('acctinfo').textContent, /\$0\.00/);
  finishFirst({ ...zero, creditsDollars: '8.00', minutesLeft: 40 });
  await tick();
  assert.match(prefs.get('acctinfo').textContent, /\$0\.00/);
});

test('an exhausted preview directs the user to the account controls', async () => {
  const prefs = openPreferences(async () => ({ signedIn: true, creditsDollars: '0.00' }), {
    api: {
      listVoices: async () => [{ voice_id: 'example', name: 'Example' }],
      preview: async () => ({ error: 'Out of credits. Manage your account to add reading time.' }),
    },
  });
  await tick();
  prefs.preview().dispatchEvent(new Event('click'));
  await tick();
  assert.equal(prefs.get('previewStatus').hidden, false);
  assert.match(prefs.get('previewStatus').textContent, /out of reading credits.*Manage account in browser/i);
});

test('leaving Preferences stops playback and discards late voice previews', async () => {
  let resolvePreview;
  let playCount = 0;
  let pauseCount = 0;
  class TestAudio extends EventTarget {
    async play() { playCount++; }
    pause() { pauseCount++; }
  }
  const prefs = openPreferences(async () => ({ signedIn: true }), {
    Audio: TestAudio,
    api: {
      listVoices: async () => [{ voice_id: 'example', name: 'Example' }],
      preview: () => new Promise(resolve => { resolvePreview = resolve; }),
    },
  });
  await tick();
  const clickPreview = () => prefs.preview().dispatchEvent(new Event('click'));
  clickPreview();
  resolvePreview({ audioBase64: 'fake' });
  await tick();
  assert.equal(playCount, 1);
  prefs.get('btnlogout').dispatchEvent(new Event('click'));
  assert.equal(pauseCount, 1);
  clickPreview();
  prefs.window.dispatchEvent(new Event('pagehide'));
  resolvePreview({ audioBase64: 'late' });
  await tick();
  assert.equal(playCount, 1);
});

test('desktop windows and their preloads expose no provider-key entry point', () => {
  for (const file of ['settings.html', 'settings-preload.js', 'onboarding.html', 'onboarding-preload.js']) {
    const source = fs.readFileSync(path.join(src, file), 'utf8');
    assert.doesNotMatch(source, /setOwnKey|setFishKey|ownkey|fishkey|API key|btnContinueKey/i, file);
  }
});
