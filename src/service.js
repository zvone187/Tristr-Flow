'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

// The hosted account service can take about a minute to wake from idle.
const AUTH_TIMEOUT_MS = 90000;
const DESKTOP_HEADER = { 'X-Tristr-Client': 'desktop' };

function pickLib(url) {
  return url.protocol === 'http:' ? http : https;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function jsonRequest({ baseUrl, path, method = 'POST', token, body, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body ? JSON.stringify(body) : null;
    const headers = { ...DESKTOP_HEADER, Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = pickLib(url).request(url, {
      method, headers, signal: AbortSignal.timeout(timeoutMs),
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text) || {}; } catch { json = {}; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(httpError(res.statusCode, json.error || `Service request failed (${res.statusCode}).`));
        } else {
          resolve(json);
        }
      });
    });
    req.on('error', error => reject(error.code === 'ABORT_ERR'
      ? new Error('The service took too long to respond. Try again.')
      : error));
    req.end(payload);
  });
}

async function deviceSession(request) {
  const json = await jsonRequest({ ...request, timeoutMs: AUTH_TIMEOUT_MS });
  if (typeof json.apiToken !== 'string' || !json.apiToken.startsWith('tfdesk_') || json.apiToken.length <= 7) {
    throw new Error('The service did not return a desktop session. Try again.');
  }
  return json;
}

function login({ baseUrl, email, password }) {
  return deviceSession({ baseUrl, path: '/api/auth/login', body: { email, password } });
}

function signup({ baseUrl, email, password }) {
  return deviceSession({ baseUrl, path: '/api/auth/signup', body: { email, password } });
}

function exchangeSession({ baseUrl, token }) {
  return deviceSession({ baseUrl, path: '/api/auth/desktop-session', token });
}

function logout({ baseUrl, token }) {
  return jsonRequest({ baseUrl, path: '/api/auth/logout', token, timeoutMs: 5000 });
}

function revokeProof({ baseUrl, revocationProof }) {
  return jsonRequest({ baseUrl, path: '/api/auth/logout', body: { revocationProof }, timeoutMs: 5000 });
}

function me({ baseUrl, token }) {
  return jsonRequest({ baseUrl, path: '/api/me', method: 'GET', token });
}

async function listServiceVoices({ baseUrl, token }) {
  if (!token) throw httpError(401, 'Not signed in to Tristr Flow.');
  const json = await jsonRequest({ baseUrl, path: '/api/voices', method: 'GET', token });
  if (!Array.isArray(json.voices)) throw new Error('Could not load service voices.');
  return json.voices;
}

function ttsHttpError(status, body) {
  if (status === 401) return httpError(status, 'Please sign in to Tristr Flow again.');
  if (status === 402) return httpError(status, 'Out of credits. Add more in your Tristr Flow account.');
  let message;
  try { message = JSON.parse(body).error; } catch { /* non-JSON response */ }
  if (message === 'no_text') return httpError(status, 'Nothing to read.');
  return httpError(status, `Service ${status}: ${String(message || body).slice(0, 200)}`);
}

// The backend owns speech synthesis, segmentation and billing. Each read ends
// with exactly one success or failure, including when the account signs out.
function serviceStream({ baseUrl, token, voiceId, stability = 0.5, text, onSegment, onLine, onEnd, onError, signal }) {
  let settled = false;
  let req;
  function fail(error) {
    if (settled) return;
    settled = true;
    req?.destroy();
    onError(error);
  }

  const handle = {
    abort() { fail(new DOMException('Speech request cancelled.', 'AbortError')); },
  };

  try {
    if (!token) throw httpError(401, 'Not signed in to Tristr Flow.');
    signal?.throwIfAborted();
    const url = new URL('/api/tts', baseUrl);
    const payload = JSON.stringify({ text, voiceId, stability });
    req = pickLib(url).request(url, {
      method: 'POST',
      signal,
      headers: {
        ...DESKTOP_HEADER,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Accept: 'application/x-ndjson',
      },
    }, (res) => {
      res.setEncoding('utf8');
      res.on('error', fail);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => fail(ttsHttpError(res.statusCode, body)));
        return;
      }

      let buffer = '';
      let done = false;
      function readRecord(line) {
        if (settled || !line.trim()) return;
        try {
          signal?.throwIfAborted();
          const record = JSON.parse(line);
          if (record.type === 'error' || record.error) {
            const message = record.message || record.error || 'Service error.';
            throw message === 'insufficient_credits' ? ttsHttpError(402, '') : new Error(message);
          }
          if (record.type === 'done') done = true;
          else if (record.type === 'segment') onSegment?.(record.index);
          else if (record.audio || record.alignment) {
            onLine({ audio_base64: record.audio || null, alignment: record.alignment || null });
          }
        } catch (error) { fail(error); }
      }
      res.on('data', chunk => {
        const lines = (buffer + chunk).split('\n');
        buffer = lines.pop();
        for (const line of lines) readRecord(line);
      });
      res.on('end', () => {
        readRecord(buffer);
        if (settled) return;
        if (!done) return fail(new Error('Speech stream ended before it finished.'));
        settled = true;
        onEnd();
      });
    });
    req.on('error', fail);
    req.setTimeout(120000, () => fail(new Error('Service stream timed out.')));
    req.end(payload);
  } catch (error) { fail(error); }
  return handle;
}

function serviceSynthesize(options) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    serviceStream({
      ...options,
      onLine(line) {
        if (line.audio_base64) chunks.push(Buffer.from(line.audio_base64, 'base64'));
      },
      onEnd() {
        if (!chunks.length) return reject(new Error('Service returned no preview audio.'));
        resolve({ audioBase64: Buffer.concat(chunks).toString('base64') });
      },
      onError: reject,
    });
  });
}

module.exports = { login, signup, exchangeSession, logout, revokeProof, me, listServiceVoices, serviceStream, serviceSynthesize };
