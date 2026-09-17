'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { CharTimeline } = require('../src/fishaudio');

test('maps Fish punctuation-normalized words onto the original selected text', () => {
  const timeline = new CharTimeline("I've read it.");
  const aligned = timeline.commit([
    { text: 'Ive', start: 0, end: 0.3 },
    { text: 'read', start: 0.3, end: 0.6 },
    { text: 'it', start: 0.6, end: 0.8 },
  ]);
  const tail = timeline.flush(0.9);

  assert.equal(
    [...(aligned?.characters || []), ...(tail?.characters || [])].join(''),
    "I've read it."
  );
});
