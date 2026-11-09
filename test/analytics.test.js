'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ALLOWED_EVENTS, createAnalytics, safeProperties } = require('../src/analytics');

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

test('authenticated events reach the backend under the session captured at emission', async () => {
  const http = require('node:http');
  const { once } = require('node:events');
  const received = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { events, installationId } = JSON.parse(body);
    for (const event of events) received.push({ path: req.url, authorization: req.headers.authorization, installationId, ...event });
    res.writeHead(204);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const installationId = require('node:crypto').randomUUID();
  let token = '';
  const analytics = createAnalytics({
    enabled: true, installationId, appVersion: '0.1.7', platform: 'darwin', arch: 'arm64',
    getSession: () => ({ baseUrl, token }),
  });
  try {
    analytics.capture('app_launched');
    token = 'account-A-session';
    analytics.capture('read_requested', { trigger: 'shortcut', email: 'private@example.test', text: 'private words' });
    analytics.capture('account_action_completed', { action: 'logout', outcome: 'success' });
    token = 'account-B-session';
    analytics.capture('reading_started', { character_count: 100 });
    await analytics.shutdown();
    const anonymous = received.filter(event => event.authorization === undefined);
    assert.deepEqual(anonymous.map(event => event.event), ['app_launched']);
    assert.equal(anonymous[0].installationId, installationId);
    assert.ok(received.filter(event => event.authorization).every(event => event.installationId === undefined));
    assert.deepEqual(received.filter(event => event.authorization === 'Bearer account-A-session').map(event => event.event),
      ['read_requested', 'account_action_completed']);
    assert.deepEqual(received.filter(event => event.authorization === 'Bearer account-B-session').map(event => event.event),
      ['reading_started']);
    for (const event of received) {
      assert.equal(event.path, '/api/desktop/events');
      assert.equal(event.properties.app_version, '0.1.7');
      assert.match(event.uuid, /^[a-f\d-]{36}$/i);
      assert.doesNotMatch(JSON.stringify(event.properties), /email|private|session|distinct_id/);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});


test('analytics rejects unknown events and does not collect any events when disabled', async () => {
  function getSession() { throw new Error('unauthorized transport'); }
  const disabled = createAnalytics({ enabled: false, getSession });
  assert.equal(disabled.capture('app_launched'), false);
  await disabled.shutdown();
  const enabled = createAnalytics({ enabled: true, getSession });
  assert.equal(enabled.capture('unexpected_event'), false);
  await enabled.shutdown();
});

test('event properties accept only known enums, booleans and bounded values', () => {
  assert.deepEqual(safeProperties(JSON.parse('{"__proto__":"x","constructor":"x","toString":"x"}')), {});
  assert.deepEqual(safeProperties({
    surface: 'preferences', setting_name: 'theme', setting_value: 'dark',
    character_count: 99, duration_ms: 500, position_percent: 101,
    selected_text: 'private selection', email: 'user@example.test', html: '<b>text</b>',
    error_name: 'free-form error with secret', trigger: 'free-form trigger',
    serviceToken: 'secret', id: 'someone-else', '$set': { email: 'user@example.test' },
  }), {
    surface: 'preferences', setting_name: 'theme', setting_value: 'dark',
    character_count: 99, duration_ms: 500,
  });
});

test('a transient backend failure retries a stable event UUID under the original token', async () => {
  const requests = [];
  let token = 'first-session';
  const analytics = createAnalytics({
    getSession: () => ({ baseUrl: 'https://service.test', token }),
    fetchImpl: async (_url, options) => {
      requests.push({ token: options.headers.Authorization, payload: JSON.parse(options.body) });
      return { ok: requests.length > 1, status: requests.length > 1 ? 204 : 503 };
    },
  });
  analytics.capture('read_requested');
  token = 'another-session';
  await analytics.flushSession('first-session');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[1].token, 'Bearer first-session');
  await analytics.shutdown();
});

test('keeps account events and their original timestamp through backend cold-start retries', async () => {
  const requests = [];
  let acknowledge;
  const acknowledged = new Promise(resolve => { acknowledge = resolve; });
  const analytics = createAnalytics({
    getSession: () => ({ baseUrl: 'https://account.example', token: 'active-session' }),
    batchDelayMs: 0, retryDelaysMs: [2, 2, 4, 8],
    fetchImpl: async (_url, options) => {
      requests.push({ token: options.headers.Authorization, batch: JSON.parse(options.body).events });
      if (requests.length === 4) {
        acknowledge();
        return { ok: true, status: 204 };
      }
      return { ok: false, status: 503 };
    },
  });
  const started = Date.now();
  analytics.capture('reading_started', { character_count: 5 });
  let timeout;
  try {
    await Promise.race([acknowledged, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('No cold-start recovery')), 1000);
    })]);
    assert.equal(requests.length, 4);
    assert.ok(Date.parse(requests[0].batch[0].timestamp) >= started);
    for (const request of requests) assert.deepEqual(request, requests[0]);
    assert.equal(requests[0].token, 'Bearer active-session');
  } finally {
    clearTimeout(timeout);
    await analytics.shutdown();
  }
});

test('revoked credentials never convert an account event into anonymous telemetry', async () => {
  const requests = [];
  const analytics = createAnalytics({
    installationId: require('node:crypto').randomUUID(),
    getSession: () => ({ baseUrl: 'https://account.example', token: 'revoked-session' }),
    fetchImpl: async (_url, options) => { requests.push(options); return { ok: false, status: 401 }; },
  });
  analytics.capture('app_launched');
  await analytics.shutdown();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.Authorization, 'Bearer revoked-session');
  assert.equal(JSON.parse(requests[0].body).installationId, undefined);
});
