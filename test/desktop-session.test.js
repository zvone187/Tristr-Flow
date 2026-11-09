'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDesktopSession } = require('../src/desktop-session');

const device = { apiToken: 'tfdesk_one', email: 'first@example.test', accountId: 'one' };
const offline = Object.assign(new Error('offline'), { status: 503 });
const unauthorized = Object.assign(new Error('expired'), { status: 401 });

function setup(initial, service) {
  const state = { ...initial };
  const changes = [];
  const session = createDesktopSession({
    state, baseUrl: 'http://127.0.0.1', service,
    onChange: reason => changes.push(reason),
  });
  return { state, session, changes };
}

test('a stored account is exchanged exactly once while simultaneous readers wait', async () => {
  let calls = 0;
  const { state, session } = setup({ serviceToken: 'legacy-account', serviceEmail: device.email }, {
    async exchangeSession({ token }) { calls++; assert.equal(token, 'legacy-account'); return device; },
  });
  assert.deepEqual(await Promise.all([session.deviceToken(), session.deviceToken()]), [device.apiToken, device.apiToken]);
  assert.equal(calls, 1);
  assert.equal(state.serviceToken, device.apiToken);
  assert.equal(state.serviceEmail, device.email);
});

test('only an authentication failure clears a saved session', async () => {
  let error = offline;
  const { state, session } = setup({ serviceToken: device.apiToken }, {
    async me() { throw error; },
  });
  await assert.rejects(session.refresh(), /offline/);
  assert.equal(state.serviceToken, device.apiToken);
  error = unauthorized;
  await assert.rejects(session.refresh(), /expired/);
  assert.equal(state.serviceToken, '');
});

test('logout clears the local session immediately, before server revocation settles', async () => {
  const { promise, resolve } = Promise.withResolvers();
  const tokens = [];
  const { state, session } = setup({ serviceToken: device.apiToken, serviceEmail: device.email }, {
    async revokeProof({ revocationProof }) { tokens.push(revocationProof); await promise; },
  });
  const pending = session.logout();
  assert.equal(state.serviceToken, '');
  assert.equal(state.serviceEmail, '');
  resolve();
  await pending;
  assert.equal(tokens.length, 1);
  assert.match(tokens[0], /^[0-9a-f]{64}$/);
});

test('a late sign-in response after logout is revoked without restoring the account', async () => {
  const { promise, resolve } = Promise.withResolvers();
  const revoked = [];
  const { state, session } = setup({ serviceToken: '' }, {
    async login() { return promise; },
    async logout({ token }) { revoked.push(token); },
  });
  const pending = session.authenticate('login', 'first@example.test', 'test');
  await session.logout();
  resolve(device);
  await assert.rejects(pending);
  assert.equal(state.serviceToken, '');
  assert.deepEqual(revoked, [device.apiToken]);
});


test('offline sign-out stores only a revocation proof and retries it at the next launch', async () => {
  const { state, session } = setup({ serviceToken: device.apiToken, serviceEmail: device.email }, {
    async revokeProof() { throw offline; },
  });
  assert.deepEqual(await session.logout(), { remoteRevoked: false });
  const saved = JSON.stringify(state);
  assert.equal(saved.includes(device.apiToken), false);
  const [proof] = state.pendingRevocations;
  assert.match(proof, /^[0-9a-f]{64}$/);
  const restored = setup(JSON.parse(saved), {
    async revokeProof(args) { assert.equal(args.revocationProof, proof); },
  });
  await restored.session.retryRevocations();
  assert.deepEqual(restored.state.pendingRevocations, []);
  assert.equal(restored.state.serviceToken, '');
});

test('a failed account save revokes the new credential and reports the storage error', async () => {
  const revoked = [];
  const state = { serviceToken: '', serviceEmail: '' };
  const session = createDesktopSession({
    state, persist: () => false, onChange() {},
    service: { async login() { return device; }, async logout({ token }) { revoked.push(token); } },
  });
  await assert.rejects(session.authenticate('login', device.email, 'test'), { code: 'SESSION_PERSISTENCE' });
  assert.equal(state.serviceToken, '');
  assert.deepEqual(revoked, [device.apiToken]);
});

test('failed telemetry cannot prevent remote revocation; a storage failure is visible', async () => {
  const state = { serviceToken: device.apiToken, serviceEmail: device.email };
  let revoked = false;
  const session = createDesktopSession({
    state, persist: () => false, onChange() {}, async beforeRevoke() { throw offline; },
    service: { async revokeProof() { revoked = true; } },
  });
  await assert.rejects(session.logout(), { code: 'SESSION_PERSISTENCE' });
  assert.equal(state.serviceToken, '');
  assert.equal(revoked, true);
});
