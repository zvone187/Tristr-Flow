'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function openPanel(onb) {
  const html = fs.readFileSync(path.join(__dirname, '../src/onboarding.html'), 'utf8');
  const elements = new Map();
  for (const [, id] of html.matchAll(/ id="([^"]+)"/g)) {
    const el = new EventTarget();
    el.dataset = {};
    elements.set(id, el);
  }
  const window = new EventTarget();
  let update;
  window.onb = {
    ...onb,
    onAccessibilityChanged: (fn) => { update = fn; return () => {}; },
  };
  const get = (id) => elements.get(id);
  const script = fs.readFileSync(path.join(__dirname, '../src/onboarding-accessibility.js'), 'utf8');
  vm.runInNewContext(script, { document: { getElementById: get }, window });
  return { get, update, window };
}

const settle = () => new Promise(setImmediate);

test('a stale check cannot undo a live permission grant while the user is signing in', async () => {
  let resolveCheck;
  const { get, update } = openPanel({
    accessibility: () => new Promise((resolve) => { resolveCheck = resolve; }),
  });
  get('email').value = 'qa@example.test';
  update('granted');
  resolveCheck('denied');
  await settle();
  assert.equal(get('accessCard').dataset.status, 'granted');
  assert.equal(get('btnAccessSettings').hidden, true);
  assert.equal(get('accessRecovery').hidden, true);
  assert.equal(get('email').value, 'qa@example.test');
});

test('a failed permission check offers retry and only a confirmed denial offers repair', async () => {
  let checks = 0;
  let repairs = 0;
  const { get } = openPanel({
    accessibility: async () => {
      if (++checks === 1) throw Error('unavailable');
      return 'capture-denied';
    },
    repairAccessibility: async () => { repairs++; return { ok: false, error: 'Permission repair failed.' }; },
  });
  await settle();
  assert.equal(get('accessCard').dataset.status, 'unavailable');
  assert.equal(get('accessRecovery').hidden, true);
  get('btnRetryAccess').dispatchEvent(new Event('click'));
  await settle();
  assert.equal(get('accessCard').dataset.status, 'capture-denied');
  assert.equal(get('accessRecovery').hidden, false);
  get('btnRepairAccess').dispatchEvent(new Event('click'));
  get('btnRepairAccess').dispatchEvent(new Event('click'));
  await settle();
  assert.equal(repairs, 1);
  assert.match(get('accessMessage').textContent, /repair failed/i);
  assert.equal(get('btnRepairAccess').disabled, false);
});

test('sign-in rechecks an existing OS grant without a window focus or grant change', async () => {
  let signedIn = false;
  const { get, window } = openPanel({
    accessibility: async () => signedIn ? 'granted' : 'unavailable',
  });
  await settle();
  signedIn = true;
  window.dispatchEvent(new Event('onboarding-setup-opened'));
  await settle();
  assert.equal(get('accessCard').dataset.status, 'granted');
  assert.equal(get('btnRetryAccess').hidden, true);
});
