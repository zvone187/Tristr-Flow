'use strict';

const https = require('https');

// ElevenLabs allows speed in [0.7, 1.2]; 1.0 is normal.
// Speed is applied client-side via the audio element's playbackRate (works on
// every model, unlike the API's speed param which v3 ignores).
function clampSpeed(s) {
  const n = Number(s);
  if (!Number.isFinite(n)) return 1.0;
  return Math.min(3.0, Math.max(0.5, n));
}

function clampStability(s) {
  const n = Number(s);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1.0, Math.max(0.0, n));
}

// Calls ElevenLabs "with-timestamps" TTS. Returns:
//   { audio_base64, alignment: { characters, character_start_times_seconds,
//     character_end_times_seconds }, normalized_alignment }
// The per-character timings drive the karaoke highlight. Speed scales both the
// audio and the timings, so the highlight stays in sync automatically.
function synthesize({ apiKey, voiceId, modelId, text, speed = 1.0, stability = 0.5 }) {
  return new Promise((resolve, reject) => {
    if (!apiKey) return reject(new Error('No ElevenLabs API key configured.'));
    if (!text || !text.trim()) return reject(new Error('Nothing to speak.'));

    // Stability is the one setting v3 honors. similarity_boost / speed are no-ops
    // on v3 (verified), so only send them for older models that actually use them.
    const voiceSettings = { stability: clampStability(stability) };
    if (modelId !== 'eleven_v3') voiceSettings.similarity_boost = 0.75;
    // Note: speed is NOT sent to the API — playback speed is handled client-side.

    const payload = JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: voiceSettings,
    });

    const req = https.request(
      {
        method: 'POST',
        hostname: 'api.elevenlabs.io',
        path: `/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`,
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Accept: 'application/json',
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(
              new Error(`ElevenLabs ${res.statusCode}: ${data.slice(0, 300)}`)
            );
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error('Could not parse ElevenLabs response.'));
          }
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('ElevenLabs request timed out.')));
    req.write(payload);
    req.end();
  });
}

// Streaming TTS: POSTs to /stream/with-timestamps and parses the NDJSON response
// line-by-line, invoking onLine({ audio_base64?, alignment? }) as each chunk
// arrives (so playback can start before generation finishes). Returns a handle
// with abort(). Keeps the API key in this (main) process only.
function synthesizeStream({ apiKey, voiceId, modelId, text, stability = 0.5, onLine, onEnd, onError }) {
  if (!apiKey) { onError(new Error('No ElevenLabs API key configured.')); return { abort() {} }; }

  const voiceSettings = { stability: clampStability(stability) };
  if (modelId !== 'eleven_v3') voiceSettings.similarity_boost = 0.75;

  const payload = JSON.stringify({ text, model_id: modelId, voice_settings: voiceSettings });

  const req = https.request(
    {
      method: 'POST',
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${voiceId}/stream/with-timestamps?output_format=mp3_44100_128`,
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Accept: 'application/json',
      },
    },
    (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let err = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (err += d));
        res.on('end', () => onError(new Error(`ElevenLabs ${res.statusCode}: ${err.slice(0, 200)}`)));
        return;
      }
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) {
            try { onLine(JSON.parse(line)); } catch { /* skip partial/garbage */ }
          }
        }
      });
      res.on('end', () => {
        if (buf.trim()) { try { onLine(JSON.parse(buf)); } catch { /* ignore */ } }
        onEnd();
      });
      res.on('error', onError);
    }
  );

  req.on('error', onError);
  req.setTimeout(120000, () => req.destroy(new Error('ElevenLabs stream timed out.')));
  req.write(payload);
  req.end();

  return { abort() { try { req.destroy(); } catch { /* ignore */ } } };
}

module.exports = { synthesize, synthesizeStream, clampSpeed, clampStability };
