'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

// Talks to the hosted Tristr Flow service. Used when the app has no local
// ElevenLabs key: the user logs in (per-user apiToken) and TTS is routed through
// the credit-metered /api/tts proxy. Keeps the apiToken in the main process.

function pickLib(u) {
  return u.protocol === 'http:' ? http : https;
}

function readBody(res) {
  return new Promise((resolve) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (d) => (data += d));
    res.on('end', () => resolve(data));
  });
}

function jsonRequest({ baseUrl, path, method = 'POST', token, body }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(path, baseUrl); } catch (e) { return reject(e); }
    const payload = body ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = pickLib(u).request(
      {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        headers,
      },
      async (res) => {
        const text = await readBody(res);
        let json = null;
        try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
        resolve({ status: res.statusCode, json });
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Service request timed out.')));
    if (payload) req.write(payload);
    req.end();
  });
}

// POST /api/auth/login  -> { ok, email, apiToken, creditsMicros }
async function login({ baseUrl, email, password }) {
  const { status, json } = await jsonRequest({
    baseUrl, path: '/api/auth/login', body: { email, password },
  });
  if (status >= 200 && status < 300 && json.apiToken) return json;
  throw new Error(json.error || `Login failed (${status}).`);
}

// POST /api/auth/signup -> { ok, email, apiToken, creditsMicros }
async function signup({ baseUrl, email, password }) {
  const { status, json } = await jsonRequest({
    baseUrl, path: '/api/auth/signup', body: { email, password },
  });
  if (status >= 200 && status < 300 && json.apiToken) return json;
  throw new Error(json.error || `Sign up failed (${status}).`);
}

// GET /api/me -> { email, apiToken, creditsMicros, creditsDollars }
async function me({ baseUrl, token }) {
  const { status, json } = await jsonRequest({
    baseUrl, path: '/api/me', method: 'GET', token,
  });
  if (status >= 200 && status < 300) return json;
  throw new Error(json.error || `Could not load account (${status}).`);
}

function ttsHttpError(status, body) {
  let msg = body;
  try { const j = JSON.parse(body); msg = j.error || j.message || body; } catch { /* keep raw */ }
  if (status === 401) return new Error('Please sign in to Tristr Flow again.');
  if (status === 402) return new Error('Out of credits — add more in your Tristr Flow account.');
  if (status === 400) return new Error('Nothing to read.');
  return new Error(`Service ${status}: ${String(msg).slice(0, 200)}`);
}

// Streams TTS from /api/tts. The service emits NDJSON lines shaped like
// { audio, alignment } plus control lines ({type:'segment'|'done'|'error'}).
// We normalize the audio lines into { audio_base64, alignment } so the overlay
// consumes them identically to the direct-ElevenLabs path. Returns { abort() }.
function serviceStream({ baseUrl, token, voiceId, stability = 0.5, text, onLine, onEnd, onError }) {
  if (!token) { onError(new Error('Not signed in to Tristr Flow.')); return { abort() {} }; }
  let u;
  try { u = new URL('/api/tts', baseUrl); } catch (e) { onError(e); return { abort() {} }; }
  const payload = JSON.stringify({ text, voiceId, stability });

  const req = pickLib(u).request(
    {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Accept: 'application/x-ndjson',
      },
    },
    (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let err = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (err += d));
        res.on('end', () => onError(ttsHttpError(res.statusCode, err)));
        return;
      }
      res.setEncoding('utf8');
      let buf = '';
      const handle = (line) => {
        let o;
        try { o = JSON.parse(line); } catch { return; }
        if (o.type === 'error' || o.error) { onError(new Error(o.message || o.error || 'Service error.')); return; }
        if (o.audio) onLine({ audio_base64: o.audio, alignment: o.alignment || null });
      };
      res.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) handle(line);
        }
      });
      res.on('end', () => { if (buf.trim()) handle(buf); onEnd(); });
      res.on('error', onError);
    }
  );

  req.on('error', onError);
  req.setTimeout(120000, () => req.destroy(new Error('Service stream timed out.')));
  req.write(payload);
  req.end();

  return { abort() { try { req.destroy(); } catch { /* ignore */ } } };
}

module.exports = { login, signup, me, serviceStream };
