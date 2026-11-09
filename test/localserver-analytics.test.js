'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');

const { start, TOKEN } = require('../src/localserver');

async function listening(server) {
  if (!server.listening) await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}

function close(server) {
  server.closeAllConnections();
  return new Promise(resolve => server.close(resolve));
}

async function bridgeFixture(t, handle) {
  const requests = [];
  const backend = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, authorization: req.headers.authorization, data: JSON.parse(body) });
    handle(req, res);
  });
  backend.listen(0, '127.0.0.1');
  t.after(() => close(backend));
  const baseUrl = await listening(backend);
  const state = { serviceToken: 'signed-in', voiceId: 'some-voice', stability: 0.5 };
  const events = [];
  const usage = [];
  const invalidated = [];
  const bridge = start({
    port: 0,
    getConfig: () => ({ serviceBaseUrl: baseUrl }),
    getState: () => state,
    captureAnalytics: (event, properties) => events.push({ event, properties }),
    onUsage: token => usage.push(token),
    onUnauthorized: token => invalidated.push(token),
  });
  t.after(() => close(bridge));
  const endpoint = (await listening(bridge)) + '/tts';
  const read = (text, headers = {}) => fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-speak-token': TOKEN,
      Origin: 'chrome-extension://jllpigimfnadoijjooemcapddkfpafjd',
      ...headers,
    },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(1500),
  });
  return { endpoint, read, requests, state, events, usage, invalidated, bridge };
}

test('unpacked Tristr Flow extension has the ID trusted by the desktop app', () => {
  const { createHash } = require('node:crypto');
  const manifest = require('../extension/manifest.json');
  assert.ok(manifest.key);
  const hash = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex');
  const id = [...hash.slice(0, 32)].map(char => 'abcdefghijklmnop'[parseInt(char, 16)]).join('');
  assert.equal(require('../src/localserver').EXTENSION_ORIGIN, 'chrome-extension://' + id);
});

const stream = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  res.end('{"type":"segment","index":0}\n{"audio":"audio"}\n{"type":"done"}\n');
};

test('extension signs backend requests with the current account and exposes only audio', async t => {
  const { read, requests, state, events, usage } = await bridgeFixture(t, stream);
  const response = await read('private selected words');
  assert.equal(response.status, 200);
  const lines = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(line => line.type || 'audio'), ['segment', 'audio', 'done']);
  assert.deepEqual(requests, [{
    path: '/api/tts', authorization: 'Bearer signed-in',
    data: { text: 'private selected words', voiceId: 'some-voice', stability: 0.5 },
  }]);
  assert.deepEqual(usage, ['signed-in']);
  assert.deepEqual(events.map(({event}) => event), ['extension_read_requested', 'extension_read_completed']);
  assert.equal(events[1].properties.provider, 'service');
  assert.doesNotMatch(JSON.stringify(events), /private selected words|some-voice|signed-in/);
  assert.doesNotMatch(JSON.stringify(lines), /signed-in/);

  state.serviceToken = '';
  const blocked = await read('after logout');
  assert.equal(blocked.status, 401);
  assert.match(await blocked.text(), /sign in/i);
  assert.equal(requests.length, 1);
});

test('arbitrary website origins, opaque origins and simple cross-site requests cannot consume credits', async t => {
  const { read, requests } = await bridgeFixture(t, stream);
  for (const headers of [
    { Origin: 'https://example.test' },
    { Origin: 'chrome-extension://' + 'a'.repeat(32) + '.example.test' },
    { Origin: 'chrome-extension://' + 'a'.repeat(32) },
    { Origin: '' },
    { Origin: 'null' },
    { Origin: '', 'sec-fetch-site': 'cross-site' },
    { Origin: '', 'content-type': 'text/plain' },
  ]) {
    const response = await read('should not route', headers);
    assert.ok([403,415].includes(response.status), 'blocked ' + JSON.stringify(headers));
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(requests.length, 0);
});

test('extension cancels an active backend stream when the desktop session ends', async t => {
  let began, closed;
  const started = new Promise(resolve => { began = resolve; });
  const upstreamClosed = new Promise(resolve => { closed = resolve; });
  const { read, state, bridge } = await bridgeFixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write('{"type":"segment","index":0}\n');
    res.once('close', closed);
    began();
  });
  const result = read('held selection').then(res => res.text()).catch(() => {});
  await Promise.race([started, result]);
  assert.equal(typeof bridge.cancelReads, 'function');
  state.serviceToken = '';
  bridge.cancelReads();
  await Promise.all([result, upstreamClosed]);
});

test('backend auth failures invalidate only the captured session and do not report success', async t => {
  const { read, invalidated, events } = await bridgeFixture(t, (_req, res) => {
    res.writeHead(401);
    res.end('{"error":"not_authenticated"}');
  });
  const response = await read('selection');
  assert.match(await response.text(), /sign in/i);
  assert.deepEqual(invalidated, ['signed-in']);
  assert.equal(events.at(-1).event, 'extension_read_failed');
});


test('an upload started on one account cannot spend a later account’s credits', async t => {
  const { endpoint, requests, state, bridge } = await bridgeFixture(t, stream);
  const arrived = once(bridge, 'request');
  const upload = http.request(endpoint, {
    method: 'POST', headers: {
      Origin: require('../src/localserver').EXTENSION_ORIGIN,
      'Content-Type': 'application/json', 'x-speak-token': TOKEN,
    },
  });
  const response = once(upload, 'response');
  upload.write('{"text":"');
  await arrived;
  bridge.cancelReads();
  state.serviceToken = 'different-account';
  upload.end('selection"}');
  const [result] = await response;
  result.resume();
  assert.equal(result.statusCode, 401);
  assert.equal(requests.length, 0);
});
