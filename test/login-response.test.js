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
