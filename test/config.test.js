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

test('allows backend product tracking to be disabled', () => {
  withEnv({ POSTHOG_DISABLED: 'true' }, () => {
    assert.equal(loadConfig().analyticsDisabled, true);
  });
});

test('backend tracking ignores local PostHog projects and ingestion hosts', () => {
  withEnv({
    POSTHOG_DISABLED: 'false',
    POSTHOG_PROJECT_TOKEN: 'unused-public-token',
    POSTHOG_HOST: 'https://unused.example.test',
  }, () => {
    const config = loadConfig();
    assert.equal(config.analyticsDisabled, false);
    assert.equal(Object.hasOwn(config, 'posthogToken'), false);
    assert.equal(Object.hasOwn(config, 'posthogHost'), false);
  });
});

test('ships the production Render service used by the public account site', () => {
  assert.equal(DEFAULT_SERVICE_BASE_URL, 'https://tristr-flow-5iy7.onrender.com');
});

test('installed app uses the hosted service without reading development files or exposing provider keys', (t) => {
  const fs = require('node:fs');
  const reads = [];
  t.mock.method(fs, 'readFileSync', (file) => {
    reads.push(file);
    return 'SPEAK_SERVICE_URL=http://localhost:8800';
  });
  withEnv({
    ELEVENLABS_API_KEY: 'local-eleven-credential',
    FISH_API_KEY: 'local-fish-credential',
    SPEAK_FORCE_SERVICE: 'false',
    SPEAK_SERVICE_URL: undefined,
  }, () => {
    const cfg = loadConfig({ packaged: true });
    assert.equal(cfg.serviceBaseUrl, DEFAULT_SERVICE_BASE_URL);
    assert.deepEqual(reads, []);
    assert.equal(Object.hasOwn(cfg, 'apiKey'), false);
    assert.equal(Object.hasOwn(cfg, 'fishApiKey'), false);
    assert.equal(Object.hasOwn(cfg, 'forceService'), false);
  });
});

test('development loads only this checkout’s settings and never looks for provider keys', (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const projectEnv = path.join(__dirname, '..', '.env');
  const reads = [];
  t.mock.method(fs, 'readFileSync', (file) => {
    reads.push(file);
    return file === projectEnv ? 'SPEAK_VOICE_NAME="Local fixture"' : '';
  });
  withEnv({
    SPEAK_VOICE_NAME: undefined, ELEVEN_API_KEY: undefined, ELEVENLABS_API_KEY: undefined,
    FISH_API_KEY: undefined, FISH_AUDIO_API_KEY: undefined,
  }, () => {
    assert.equal(loadConfig().voiceName, 'Local fixture');
    assert.deepEqual(reads, [projectEnv]);
  });
});
