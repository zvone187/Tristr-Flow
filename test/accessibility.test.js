'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccessibilityController } = require('../src/accessibility');

function install() {
  const os = { app: false, capture: false, prompted: false };
  const calls = { prompt: 0, settings: 0, probes: 0, grants: 0 };
  function launch() {
    return createAccessibilityController({
      isTrusted: () => os.app,
      probeCapture: async () => {
        calls.probes++;
        if (os.capture instanceof Error) throw os.capture;
        return os.capture;
      },
      hasPrompted: () => os.prompted,
      markPrompted: () => { os.prompted = true; },
      prompt: () => { calls.prompt++; },
      openSettings: async () => { calls.settings++; },
      onChange: (status) => { if (status === 'granted') calls.grants++; },
    });
  }
  return { os, calls, launch };
}

test('first install asks once even across simultaneous requests and relaunch; retry opens Settings', async () => {
  const { calls, launch } = install();
  const first = launch();
  assert.equal(await first.check(), 'denied');
  assert.equal(calls.prompt, 0);
  await Promise.all([first.request(), first.request()]);
  first.stopWatching();
  const second = launch();
  assert.equal(await second.request(), 'denied');
  assert.deepEqual([calls.prompt, calls.settings], [1, 0]);
  assert.equal(await second.request({ userInitiated: true }), 'denied');
  assert.deepEqual([calls.prompt, calls.settings], [1, 1]);
  second.stopWatching();
});

test('grant while Settings has focus is detected, announced once, and stops polling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { os, calls, launch } = install();
  const flow = launch();
  assert.equal(await flow.request(), 'denied');
  os.app = os.capture = true;
  t.mock.timers.tick(2000);
  await new Promise(setImmediate);
  assert.equal(flow.status(), 'granted');
  assert.equal(calls.grants, 1);
  const probesAfterGrant = calls.probes;
  t.mock.timers.tick(10000);
  await new Promise(setImmediate);
  assert.equal(calls.probes, probesAfterGrant);
  assert.equal(await flow.request({ userInitiated: true }), 'granted');
  assert.deepEqual([calls.grants, calls.prompt, calls.settings], [1, 1, 0]);
});

test('checks the real selection helper, distinguishes its failure from a denial, and handles revocation', async () => {
  const { os, calls, launch } = install();
  os.app = true;
  const flow = launch();
  assert.equal(await flow.check(), 'capture-denied');
  os.capture = new Error('helper timed out');
  assert.equal(await flow.request(), 'unavailable');
  assert.equal(calls.prompt, 0);
  os.capture = true;
  assert.deepEqual(await Promise.all([flow.check(), flow.check()]), ['granted', 'granted']);
  assert.equal(calls.probes, 3);
  os.app = false;
  assert.equal(await flow.check(), 'denied');
  assert.equal(calls.prompt, 0);
  flow.stopWatching();
});
