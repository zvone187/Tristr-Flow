'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { routeVoice } = require('../src/provider-routing');

test('routes signed-in Fish voices through the service when no local Fish key exists', () => {
  assert.equal(routeVoice({ voiceId: 'fish:voice-1', serviceToken: 'account-token' }), 'service');
});

test('preserves explicit bring-your-own-key provider routes', () => {
  assert.equal(routeVoice({ voiceId: 'fish:voice-1', fishKey: 'fish-key', serviceToken: 'account-token' }), 'fish-direct');
  assert.equal(routeVoice({ voiceId: 'eleven-voice', elevenKey: 'eleven-key', serviceToken: 'account-token' }), 'elevenlabs-direct');
});

test('routes account-backed ElevenLabs and reports unavailable providers', () => {
  assert.equal(routeVoice({ voiceId: 'eleven-voice', serviceToken: 'account-token' }), 'service');
  assert.equal(routeVoice({ voiceId: 'fish:voice-1' }), 'unavailable');
  assert.equal(routeVoice({ voiceId: 'eleven-voice' }), 'unavailable');
});

test('force-service mode applies to ElevenLabs without overriding a local Fish key', () => {
  assert.equal(routeVoice({ voiceId: 'eleven-voice', elevenKey: 'eleven-key', serviceToken: 'account-token', forceService: true }), 'service');
  assert.equal(routeVoice({ voiceId: 'fish:voice-1', fishKey: 'fish-key', serviceToken: 'account-token', forceService: true }), 'fish-direct');
});
