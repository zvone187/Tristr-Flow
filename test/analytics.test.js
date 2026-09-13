'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ALLOWED_EVENTS, createAnalytics } = require('../src/analytics');

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

test('defines a complete product journey event catalog', () => {
  const expected = [
    'account_action_completed',
    'app_launched',
    'app_quit',
    'billing_opened',
    'extension_read_completed',
    'extension_read_failed',
    'extension_read_requested',
    'onboarding_completed',
    'overlay_interaction',
    'reading_playback_completed',
    'reading_playback_started',
    'reading_playback_state_changed',
    'setting_changed',
    'tray_menu_opened',
    'update_check_completed',
    'voice_list_completed',
    'voice_preview_completed',
    'window_opened',
  ];

  assert.ok(ALLOWED_EVENTS instanceof Set);
  for (const event of expected) assert.ok(ALLOWED_EVENTS.has(event), event);
});

test('catalogues every literal event emitted across desktop and extension code', () => {
  const files = [
    'main.js',
    'localserver.js',
    'overlay.js',
    'settings-renderer.js',
    'onboarding-renderer.js',
  ];
  const used = new Set();
  const patterns = [
    /captureAnalytics\(\s*'([^']+)'/g,
    /\.track\(\s*'([^']+)'/g,
  ];

  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(source))) used.add(match[1]);
    }
  }

  const missing = [...used].filter((event) => !ALLOWED_EVENTS.has(event));
  assert.deepEqual(missing, []);
});

test('drops unknown event names before they reach PostHog', () => {
  const calls = [];
  const analytics = createAnalytics({
    token: 'public-project-token',
    distinctId: 'install-123',
    clientFactory() {
      return {
        capture(value) { calls.push(value); },
        shutdown() { return Promise.resolve(); },
      };
    },
  });

  analytics.capture('arbitrary_renderer_event', { outcome: 'success' });

  assert.equal(calls.length, 0);
});

test('allows documented product properties and rejects free-form string values', () => {
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

  analytics.capture('setting_changed', {
    surface: 'preferences',
    setting_name: 'theme',
    setting_value: 'dark',
    trigger: 'selected text that must never become analytics',
    error_name: 'phc_secret',
  });

  assert.deepEqual(payload.properties, {
    $process_person_profile: false,
    $geoip_disable: true,
    surface: 'preferences',
    setting_name: 'theme',
    setting_value: 'dark',
  });
});

test('bounds numeric telemetry to safe operational ranges', () => {
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

  analytics.capture('reading_synthesis_completed', {
    character_count: 420,
    segment_count: 2,
    duration_ms: 1250,
    position_percent: 101,
  });

  assert.deepEqual(payload.properties, {
    $process_person_profile: false,
    $geoip_disable: true,
    character_count: 420,
    segment_count: 2,
    duration_ms: 1250,
  });
});
