'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAnalytics } = require('../src/analytics');

test('is a no-op when no PostHog project token is configured', async () => {
  let factoryCalls = 0;
  const analytics = createAnalytics({
    token: '',
    clientFactory() {
      factoryCalls += 1;
      throw new Error('must not initialize');
    },
  });

  analytics.capture('app_launched');
  await analytics.shutdown();

  assert.equal(factoryCalls, 0);
  assert.equal(analytics.enabled, false);
});

test('captures anonymous install-scoped events with safe default properties', () => {
  const calls = [];
  const analytics = createAnalytics({
    token: 'public-project-token',
    host: 'https://us.i.posthog.com',
    distinctId: 'install-123',
    appVersion: '0.1.0',
    platform: 'darwin',
    arch: 'arm64',
    clientFactory(token, options) {
      calls.push({ type: 'init', token, options });
      return {
        capture(payload) { calls.push({ type: 'capture', payload }); },
        shutdown() { return Promise.resolve(); },
      };
    },
  });

  analytics.capture('read_requested', {
    trigger: 'shortcut',
    character_count: 42,
  });

  assert.equal(analytics.enabled, true);
  assert.equal(calls[0].token, 'public-project-token');
  assert.equal(calls[0].options.host, 'https://us.i.posthog.com');
  assert.deepEqual(calls[1].payload, {
    distinctId: 'install-123',
    event: 'read_requested',
    properties: {
      app_version: '0.1.0',
      platform: 'darwin',
      arch: 'arm64',
      $process_person_profile: false,
      $geoip_disable: true,
      trigger: 'shortcut',
      character_count: 42,
    },
  });
});

test('drops content and identity-like properties before capture', () => {
  let payload;
  const analytics = createAnalytics({
    token: 'public-project-token',
    distinctId: 'install-123',
    clientFactory() {
      return {
        capture(value) { payload = value; },
        shutdown() { return Promise.resolve(); },
      };
    },
  });

  analytics.capture('selection_capture_finished', {
    outcome: 'success',
    selected_text: 'private words',
    clipboard_content: 'private clipboard',
    html: '<b>private</b>',
    email: 'person@example.com',
    service_token: 'private-token',
    serviceToken: 'private-token',
    arbitrary_note: 'private words under an unexpected property',
  });

  assert.deepEqual(payload.properties, {
    $process_person_profile: false,
    $geoip_disable: true,
    outcome: 'success',
  });
});

test('flushes the client during shutdown', async () => {
  let shutDown = false;
  const analytics = createAnalytics({
    token: 'public-project-token',
    distinctId: 'install-123',
    clientFactory() {
      return {
        capture() {},
        async shutdown() { shutDown = true; },
      };
    },
  });

  await analytics.shutdown();

  assert.equal(shutDown, true);
});
