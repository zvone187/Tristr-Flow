'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { repairAccessibility } = require('../src/accessibility-repair');

function fixture(statuses, accept = true) {
  const calls = [];
  const deps = {
    installed: true,
    check: async () => statuses.shift(),
    confirm: async () => { calls.push('confirm'); return accept; },
    reset: async (...args) => { calls.push(args); },
    requestAgain: async () => { calls.push('request again'); return 'denied'; },
  };
  return { deps, calls };
}

test('repairs only this app and only after the user confirms a still-missing grant', async () => {
  const { deps, calls } = fixture(['denied', 'denied']);
  assert.deepEqual(await repairAccessibility(deps), { ok: true, status: 'denied' });
  assert.deepEqual(calls, ['confirm', ['/usr/bin/tccutil', ['reset', 'Accessibility', 'ai.pazi.tristrflow']], 'request again']);
});

test('never resets an effective grant, an unknown status, a developer identity or on cancel', async () => {
  for (const [installed, statuses, accept] of [[true, ['granted'], true], [true, ['unavailable'], true],
    [false, ['denied'], true], [true, ['denied'], false], [true, ['denied', 'granted'], true]]) {
    const { deps, calls } = fixture(statuses, accept);
    await repairAccessibility({ ...deps, installed });
    assert.ok(calls.every((call) => call === 'confirm'));
  }
});
