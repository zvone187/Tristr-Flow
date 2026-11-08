'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_SERVICE_BASE_URL, loadConfig } = require('../src/config');

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('allows analytics to be disabled without removing the shipped project token', () => {
  withEnv({ POSTHOG_DISABLED: 'true' }, () => {
    assert.equal(loadConfig().posthogToken, '');
  });
});

test('allows the PostHog project and regional ingestion host to be overridden', () => {
  withEnv({
    POSTHOG_DISABLED: undefined,
    POSTHOG_PROJECT_TOKEN: 'replacement-public-token',
    POSTHOG_HOST: 'https://eu.i.posthog.com',
  }, () => {
    const config = loadConfig();
    assert.equal(config.posthogToken, 'replacement-public-token');
    assert.equal(config.posthogHost, 'https://eu.i.posthog.com');
  });
});

test('ships the production Render service used by the public account site', () => {
  assert.equal(DEFAULT_SERVICE_BASE_URL, 'https://tristr-flow-5iy7.onrender.com');
});

test('installed app ignores unrelated development checkout credentials and service settings', (t) => {
  const fs = require('node:fs');
  const reads = [];
  t.mock.method(fs, 'readFileSync', (file) => {
    reads.push(file);
    return String(file).endsWith('.env') ? 'ELEVENLABS_API_KEY=unexpected-dev-key\nSPEAK_SERVICE_URL=http://localhost:8800' : 'unexpected-fish-key';
  });
  withEnv({ ELEVENLABS_API_KEY: undefined, ELEVEN_API_KEY: undefined, SPEAK_SERVICE_URL: undefined, FISH_API_KEY: undefined, FISH_AUDIO_API_KEY: undefined }, () => {
    const cfg = loadConfig({ packaged: true });
    assert.equal(cfg.apiKey, '');
    assert.equal(cfg.fishApiKey, '');
    assert.equal(cfg.serviceBaseUrl, DEFAULT_SERVICE_BASE_URL);
    assert.equal(reads.length, 0);
  });
});
