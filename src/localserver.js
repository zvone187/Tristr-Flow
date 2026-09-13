'use strict';

// Tiny localhost bridge so the Chrome extension can get streaming TTS without
// ever seeing the ElevenLabs API key (the key stays in this process). Bound to
// 127.0.0.1 and gated by a shared token that only our extension's (isolated-
// world) content script knows — so random web pages can't reach it.

const http = require('http');
const { synthesizeStream } = require('./elevenlabs');

const PORT = 8757;
const TOKEN = 'tristr-flow-local-7c4e9a1b2f8d'; // shared with the extension

const SEGMENT_CHARS = 4500; // keep each request under v3's 5000-char limit
function segmentText(text) {
  if (text.length <= SEGMENT_CHARS) return [text];
  const segs = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + SEGMENT_CHARS, text.length);
    if (end < text.length) {
      const slice = text.slice(i, end);
      let cut = Math.max(
        slice.lastIndexOf('. '), slice.lastIndexOf('! '),
        slice.lastIndexOf('? '), slice.lastIndexOf('\n')
      );
      if (cut < SEGMENT_CHARS * 0.5) cut = slice.lastIndexOf(' ');
      if (cut > 0) end = i + cut + 1;
    }
    segs.push(text.slice(i, end));
    i = end;
  }
  return segs;
}

function start({
  getConfig,
  getState,
  captureAnalytics = () => {},
  synthesize = synthesizeStream,
  port = PORT,
}) {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-speak-token');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true'); // Private Network Access preflight

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'tristr-flow' }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/tts') { res.writeHead(404); res.end(); return; }
    if (req.headers['x-speak-token'] !== TOKEN) { res.writeHead(403); res.end('forbidden'); return; }

    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 5_000_000) req.destroy(); });
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        captureAnalytics('extension_read_failed', {
          surface: 'extension',
          reason: 'invalid-request',
        });
        res.writeHead(400);
        res.end();
        return;
      }
      const text = (parsed.text || '').trim();
      if (!text) {
        captureAnalytics('extension_read_failed', {
          surface: 'extension',
          reason: 'invalid-request',
        });
        res.writeHead(400);
        res.end();
        return;
      }

      const config = getConfig();
      const state = getState();
      const segments = segmentText(text);
      const startedAt = Date.now();
      captureAnalytics('extension_read_requested', {
        surface: 'extension',
        provider: config.apiKey ? 'elevenlabs' : 'none',
        character_count: text.length,
        segment_count: segments.length,
      });
      if (!config.apiKey) {
        captureAnalytics('extension_read_failed', {
          surface: 'extension',
          provider: 'none',
          reason: 'missing-provider',
          duration_ms: Date.now() - startedAt,
        });
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ type: 'error', message: 'No ElevenLabs API key in the app.' }) + '\n');
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
      try {
        for (let i = 0; i < segments.length; i++) {
          res.write(JSON.stringify({ type: 'segment', index: i }) + '\n');
          await new Promise((resolve, reject) => {
            synthesize({
              apiKey: config.apiKey,
              voiceId: state.voiceId,
              modelId: config.modelId,
              stability: state.stability,
              text: segments[i],
              onLine: (line) => {
                res.write(JSON.stringify({ audio: line.audio_base64 || null, alignment: line.alignment || null }) + '\n');
              },
              onEnd: resolve,
              onError: reject,
            });
          });
        }
        res.write(JSON.stringify({ type: 'done' }) + '\n');
        captureAnalytics('extension_read_completed', {
          surface: 'extension',
          provider: 'elevenlabs',
          character_count: text.length,
          segment_count: segments.length,
          duration_ms: Date.now() - startedAt,
        });
      } catch (e) {
        captureAnalytics('extension_read_failed', {
          surface: 'extension',
          provider: 'elevenlabs',
          reason: 'network-error',
          duration_ms: Date.now() - startedAt,
          error_name: e && e.name ? e.name : 'Error',
        });
        res.write(JSON.stringify({ type: 'error', message: String(e.message || e) }) + '\n');
      }
      res.end();
    });
  });

  server.on('error', (e) => console.error('[localserver]', e.message));
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    console.log('[localserver] listening on 127.0.0.1:' + (address && address.port));
  });
  return server;
}

module.exports = { start, PORT, TOKEN };
