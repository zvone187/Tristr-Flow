'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { listServiceVoices, serviceStream, serviceSynthesize } = require('../src/service');
const { mergeVoices } = require('../src/voices');

function withServer(handler, run) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', async () => {
      try {
        const { port } = server.address();
        resolve(await run(`http://127.0.0.1:${port}`));
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

test('loads authenticated Fish voices from the Tristr service', async () => {
  await withServer((req, res) => {
    assert.equal(req.url, '/api/voices');
    assert.equal(req.headers.authorization, 'Bearer account-token');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ voices: [{ voice_id: 'fish:v1', name: 'Fish One', provider: 'fish' }] }));
  }, async (baseUrl) => {
    assert.deepEqual(await listServiceVoices({ baseUrl, token: 'account-token' }), [
      { voice_id: 'fish:v1', name: 'Fish One', provider: 'fish' },
    ]);
  });
});

test('collects streamed backend audio for account-backed previews', async () => {
  await withServer((req, res) => {
    assert.equal(req.url, '/api/tts');
    assert.equal(req.headers.authorization, 'Bearer account-token');
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      assert.equal(JSON.parse(body).voiceId, 'fish:v1');
      res.setHeader('content-type', 'application/x-ndjson');
      res.end('{"audio":"YQ==","alignment":null}\n{"audio":"Yg==","alignment":null}\n{"type":"done"}\n');
    });
  }, async (baseUrl) => {
    const result = await serviceSynthesize({
      baseUrl,
      token: 'account-token',
      voiceId: 'fish:v1',
      text: 'Preview',
    });
    assert.equal(Buffer.from(result.audioBase64, 'base64').toString(), 'ab');
  });
});

test('does not hide backend stream errors during previews', async () => {
  await withServer((_req, res) => {
    res.setHeader('content-type', 'application/x-ndjson');
    res.end('{"type":"error","message":"Fish Audio 402"}\n{"type":"done"}\n');
  }, async (baseUrl) => {
    await assert.rejects(
      serviceSynthesize({ baseUrl, token: 'account-token', voiceId: 'fish:v1', text: 'Preview' }),
      /Fish Audio 402/
    );
  });
});

test('forwards alignment-only Fish records to the reading overlay', async () => {
  await withServer((_req, res) => {
    res.setHeader('content-type', 'application/x-ndjson');
    res.end('{"audio":"YQ==","alignment":null}\n{"audio":null,"alignment":{"characters":["F"]}}\n{"type":"done"}\n');
  }, async (baseUrl) => {
    const lines = await new Promise((resolve, reject) => {
      const received = [];
      serviceStream({
        baseUrl,
        token: 'account-token',
        voiceId: 'fish:v1',
        text: 'Fish',
        onLine: (line) => received.push(line),
        onEnd: () => resolve(received),
        onError: reject,
      });
    });

    assert.equal(lines[0].audio_base64, 'YQ==');
    assert.deepEqual(lines[1], {
      audio_base64: null,
      alignment: { characters: ['F'] },
    });
  });
});

test('merges service voices without duplicating local or curated voices', () => {
  const merged = mergeVoices(
    [{ voice_id: 'eleven-1', name: 'Eleven', provider: 'elevenlabs' }],
    [
      { voice_id: 'fish:v1', name: 'Fish One', provider: 'fish' },
      { voice_id: 'eleven-1', name: 'Duplicate', provider: 'fish' },
    ]
  );
  assert.deepEqual(merged.map((voice) => voice.voice_id), ['eleven-1', 'fish:v1']);
});
