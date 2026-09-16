'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { start, TOKEN } = require('../src/localserver');

function waitForListening(server) {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('tracks extension reads without page or selected-text data', async () => {
  const events = [];
  let hasKey = true;
  const server = start({
    port: 0,
    getConfig: () => ({ apiKey: hasKey ? 'provider-secret' : '', modelId: 'model' }),
    getState: () => ({ voiceId: 'voice-secret', stability: 0.5 }),
    captureAnalytics: (event, properties) => events.push({ event, properties }),
    synthesize: ({ onLine, onEnd }) => {
      onLine({ audio_base64: 'audio', alignment: null });
      onEnd();
    },
  });

  try {
    await waitForListening(server);
    const address = server.address();
    const endpoint = `http://127.0.0.1:${address.port}/tts`;
    const success = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-speak-token': TOKEN },
      body: JSON.stringify({ text: 'private selected words' }),
    });
    assert.equal(success.status, 200);
    assert.match(await success.text(), /"type":"done"/);

    hasKey = false;
    const missingProvider = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-speak-token': TOKEN },
      body: JSON.stringify({ text: 'another private selection' }),
    });
    assert.equal(missingProvider.status, 200);
    assert.match(await missingProvider.text(), /No ElevenLabs API key/);
  } finally {
    await closeServer(server);
  }

  assert.deepEqual(events.map(({ event }) => event), [
    'extension_read_requested',
    'extension_read_completed',
    'extension_read_requested',
    'extension_read_failed',
  ]);
  assert.deepEqual(events[0].properties, {
    surface: 'extension',
    provider: 'elevenlabs',
    character_count: 22,
    segment_count: 1,
  });
  assert.equal(events[1].properties.character_count, 22);
  assert.equal(events[3].properties.reason, 'missing-provider');
  for (const { properties } of events) {
    assert.equal(properties.text, undefined);
    assert.equal(properties.url, undefined);
    assert.equal(properties.origin, undefined);
    assert.equal(properties.voiceId, undefined);
  }
});
