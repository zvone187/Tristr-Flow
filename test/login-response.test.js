'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const test = require('node:test');
const { login } = require('../src/service');

test('an interrupted sign-in response settles so the account form can retry', { timeout: 2500 }, async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"apiToken":', () => res.socket.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  await assert.rejects(login({ baseUrl, email: 'qa@example.test', password: 'test' }), /aborted|interrupted|socket/i);
});

test('login requests a device-scoped credential and propagates typed service failures', async (t) => {
  const svc = require('../src/service');
  const headers = [];
  const server = http.createServer((req, res) => {
    headers.push(req.headers['x-tristr-client']);
    if (req.url === '/api/auth/login') return res.end(JSON.stringify({ apiToken: 'tfdesk_test' }));
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'Expired session' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  await login({ baseUrl, email: 'qa@example.test', password: 'test' });
  assert.equal(headers[0], 'desktop');
  await assert.rejects(svc.me({ baseUrl, token: 'tfdesk_test' }), { status: 401 });
});

test('exchange and logout use the authenticated desktop endpoints and reject permanent sign-in tokens', async t => {
  const service = require('../src/service');
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push([req.method, req.url, req.headers.authorization, req.headers['x-tristr-client']]);
    if (req.url === '/api/auth/login' || req.url === '/api/auth/signup') {
      res.end(JSON.stringify({ apiToken: 'permanent-token' }));
    } else if (req.url === '/api/auth/desktop-session') {
      res.end(JSON.stringify({ apiToken: 'tfdesk_rotated' }));
    } else {
      res.writeHead(204);
      res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const credentials = { baseUrl, email: 'qa@example.test', password: 'test' };
  await assert.rejects(service.login(credentials), /desktop session/i);
  await assert.rejects(service.signup(credentials), /desktop session/i);
  const { apiToken } = await service.exchangeSession({ baseUrl, token: 'permanent-token' });
  await service.logout({ baseUrl, token: apiToken });
  assert.deepEqual(requests.slice(-2), [
    ['POST', '/api/auth/desktop-session', 'Bearer permanent-token', 'desktop'],
    ['POST', '/api/auth/logout', 'Bearer tfdesk_rotated', 'desktop'],
  ]);
});

test('retries desktop revocation with the non-login proof alone', async t => {
  const service = require('../src/service');
  let sent;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    sent = { method: req.method, path: req.url, authorization: req.headers.authorization,
      client: req.headers['x-tristr-client'], body: JSON.parse(body) };
    res.writeHead(204).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  await service.revokeProof({ baseUrl, revocationProof: 'revocation-only-test' });
  assert.deepEqual(sent, {
    method: 'POST', path: '/api/auth/logout', authorization: undefined, client: 'desktop',
    body: { revocationProof: 'revocation-only-test' },
  });
});
