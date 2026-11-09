'use strict';

const { createHash } = require('node:crypto');

function revocationProof(token) {
  return createHash('sha256').update('TristrFlowDesktopLogout/v1:' + token).digest('hex');
}

function persistenceError() {
  return Object.assign(new Error('Could not save your account on this Mac. Check available disk space and access to your app settings.'), { code: 'SESSION_PERSISTENCE' });
}

// Older releases saved the account's shared bearer. Exchange it once for a
// separately revocable device session before using it for speech or events.
function createDesktopSession({ state, baseUrl, service, onChange, beforeRevoke, persist = () => true }) {
  let generation = 0;
  let exchange = null;
  const revoking = new Map();
  state.pendingRevocations ||= [];

  function clear(reason) {
    generation++;
    state.serviceToken = '';
    state.serviceEmail = '';
    const saved = persist();
    onChange(reason);
    return saved;
  }

  function invalidate(token) {
    if (token && state.serviceToken === token) clear('expired');
  }

  function revokeQueued(proof, token) {
    if (revoking.has(proof)) return revoking.get(proof);
    const request = (async () => {
      if (token) {
        // Tracking delivery is best effort and must never prevent revocation.
        try { await beforeRevoke?.(token); } catch { /* continue */ }
      }
      await service.revokeProof({ baseUrl, revocationProof: proof });
      state.pendingRevocations = state.pendingRevocations.filter(item => item !== proof);
      persist(); // Repeating a previously successful revocation is harmless.
    })().finally(() => revoking.delete(proof));
    revoking.set(proof, request);
    return request;
  }

  function retryRevocations() {
    return Promise.allSettled(state.pendingRevocations.slice(0, 4).map(proof => revokeQueued(proof)));
  }

  async function discard(token) {
    try { await service.logout({ baseUrl, token }); } catch {
      const proof = revocationProof(token);
      if (!state.pendingRevocations.includes(proof)) state.pendingRevocations.push(proof);
      persist();
    }
  }

  async function accept(account, requestGeneration, reason) {
    if (requestGeneration !== generation) {
      await discard(account.apiToken);
      throw new Error('The account changed. Sign in again.');
    }
    const oldToken = state.serviceToken;
    const oldEmail = state.serviceEmail;
    state.serviceToken = account.apiToken;
    state.serviceEmail = account.email || '';
    if (!persist()) {
      state.serviceToken = oldToken;
      state.serviceEmail = oldEmail;
      await discard(account.apiToken);
      throw persistenceError();
    }
    onChange(reason);
    return account;
  }

  async function authenticate(action, email, password) {
    if (state.serviceToken) throw new Error('Sign out before changing accounts.');
    const requestGeneration = ++generation;
    const account = await service[action]({ baseUrl, email, password });
    return accept(account, requestGeneration, action);
  }

  async function deviceToken() {
    const token = state.serviceToken;
    if (!token || token.startsWith('tfdesk_')) return token || '';
    if (exchange?.token === token) return exchange.promise;
    const requestGeneration = generation;
    const promise = service.exchangeSession({ baseUrl, token })
      .then(account => accept(account, requestGeneration, 'migration'))
      .then(account => account.apiToken)
      .catch(error => {
        if (error.status === 401) invalidate(token);
        throw error;
      })
      .finally(() => {
        if (exchange?.promise === promise) exchange = null;
      });
    exchange = { token, promise };
    return promise;
  }

  async function refresh() {
    const token = await deviceToken();
    if (!token) return null;
    try {
      const account = await service.me({ baseUrl, token });
      return state.serviceToken === token ? account : null;
    } catch (error) {
      if (error.status === 401) invalidate(token);
      throw error;
    }
  }

  async function logout() {
    const token = state.serviceToken;
    const proof = token?.startsWith('tfdesk_') ? revocationProof(token) : null;
    if (proof && !state.pendingRevocations.includes(proof)) state.pendingRevocations.push(proof);
    const saved = clear('logout');
    let remoteRevoked = true;
    if (proof) {
      try { await revokeQueued(proof, token); } catch { remoteRevoked = false; }
    }
    if (!saved) throw persistenceError();
    return { remoteRevoked };
  }

  return { authenticate, deviceToken, refresh, logout, invalidate, retryRevocations };
}

module.exports = { createDesktopSession };
