'use strict';

const http = require('http');
const { serviceStream } = require('./service');
const { segmentsForVoice } = require('./speech-segments');

const PORT = 8757;
const TOKEN = 'tristr-flow-local-7c4e9a1b2f8d';
const EXTENSION_ORIGIN = 'chrome-extension://jllpigimfnadoijjooemcapddkfpafjd';
const MAX_BODY_BYTES = 5_000_000;

function start({
  getConfig, getState, getToken, captureAnalytics = () => {}, onUsage = () => {},
  onUnauthorized = () => {}, port = PORT,
}) {
  const reads = new Set();
  let generation = 0;
  const server = http.createServer(async (req, res) => {
    function reject(status, error) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error }));
    }

    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'tristr-flow' }));
      return;
    }
    if (req.url !== '/tts' || !['POST', 'OPTIONS'].includes(req.method)) {
      return reject(404, 'Unknown route.');
    }
    // The service worker uses its pinned extension origin. A web page cannot
    // spend the account's credits by copying the public bridge token.
    if (req.headers.origin !== EXTENSION_ORIGIN) return reject(403, 'Forbidden.');
    res.setHeader('Access-Control-Allow-Origin', EXTENSION_ORIGIN);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Headers', 'content-type, x-speak-token');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.headers['x-speak-token'] !== TOKEN) return reject(403, 'Forbidden.');
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return reject(415, 'Expected JSON.');
    }

    if (!getState().serviceToken) {
      captureAnalytics('extension_read_failed', { surface: 'extension', reason: 'signed-out' });
      return reject(401, 'Please sign in to the Tristr Flow desktop app.');
    }
    const requestGeneration = generation;
    let text;
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > MAX_BODY_BYTES) return reject(413, 'Selection is too long.');
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      text = typeof data?.text === 'string' ? data.text.trim() : '';
    } catch { /* report malformed selections below */ }
    if (generation !== requestGeneration) return reject(401, 'Account changed. Start reading again.');
    if (!text) {
      captureAnalytics('extension_read_failed', { surface: 'extension', reason: 'invalid-request' });
      return reject(400, 'Select text to read.');
    }

    let token;
    try {
      token = getToken ? await getToken() : getState().serviceToken;
    } catch {
      return reject(503, 'Could not connect to your Tristr Flow account. Try again.');
    }
    if (res.destroyed) return;
    if (generation !== requestGeneration) return reject(401, 'Account changed. Start reading again.');
    if (!token || getState().serviceToken !== token) {
      captureAnalytics('extension_read_failed', { surface: 'extension', reason: 'signed-out' });
      return reject(401, 'Please sign in to the Tristr Flow desktop app.');
    }

    const { voiceId, stability } = getState();
    const { serviceBaseUrl: baseUrl } = getConfig();
    const segments = segmentsForVoice(text, voiceId);
    const properties = {
      surface: 'extension', provider: 'service',
      character_count: text.length, segment_count: segments.length,
    };
    const startedAt = Date.now();
    captureAnalytics('extension_read_requested', properties);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    res.flushHeaders();

    const controller = new AbortController();
    const cancel = () => controller.abort();
    reads.add(cancel);
    res.once('close', cancel);
    const send = line => {
      if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(line) + '\n');
    };

    try {
      let index = 0;
      for (const segment of segments) {
        controller.signal.throwIfAborted();
        await new Promise((resolve, rejectStream) => {
          serviceStream({
            baseUrl, token, text: segment, voiceId, stability, signal: controller.signal,
            onSegment: () => send({ type: 'segment', index: index++ }),
            onLine: line => send({ audio: line.audio_base64 || null, alignment: line.alignment || null }),
            onEnd: resolve, onError: rejectStream,
          });
        });
      }
      controller.signal.throwIfAborted();
      send({ type: 'done' });
      captureAnalytics('extension_read_completed', { ...properties, duration_ms: Date.now() - startedAt });
    } catch (error) {
      const reason = controller.signal.aborted ? 'cancelled'
        : error.status === 401 ? 'unauthorized'
        : error.status === 402 ? 'insufficient-credits' : 'network-error';
      const message = {
        cancelled: 'Reading stopped.',
        unauthorized: 'Please sign in to the Tristr Flow desktop app again.',
        'insufficient-credits': 'Add credits to your Tristr Flow account to continue reading.',
        'network-error': 'Could not finish reading. Please try again.',
      }[reason];
      send({ type: 'error', reason, message });
      if (getState().serviceToken === token) {
        captureAnalytics('extension_read_failed', { ...properties, reason, duration_ms: Date.now() - startedAt });
      }
      if (reason === 'unauthorized') onUnauthorized(token);
    } finally {
      reads.delete(cancel);
      res.off('close', cancel);
      if (!res.destroyed) res.end();
      if (getState().serviceToken === token) onUsage(token);
    }
  });
  server.cancelReads = () => {
    generation++;
    for (const cancel of reads) cancel();
  };
  server.on('error', e => console.error('[localserver]', e.message));
  server.listen(port, '127.0.0.1');
  return server;
}

module.exports = { start, PORT, TOKEN, EXTENSION_ORIGIN };
