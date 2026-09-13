'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeTargetPid } = require('../src/selection');

test('accepts only positive integer target process IDs for menu capture', () => {
  assert.equal(normalizeTargetPid(123), 123);
  assert.equal(normalizeTargetPid('456'), 456);
  assert.equal(normalizeTargetPid(0), 0);
  assert.equal(normalizeTargetPid(-1), 0);
  assert.equal(normalizeTargetPid('not-a-pid'), 0);
});
