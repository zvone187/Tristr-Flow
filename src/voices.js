'use strict';

const https = require('https');

// Curated picks shown at the top of the picker. Includes the two "Hope" voices
// (the Clear/Relatable/Charismatic one is the default; it's a library voice that
// does NOT appear in /v1/voices but is usable directly by id), plus a few
// great-sounding premades. The rest of the user's library is appended live.
const CURATED = [
  {
    voice_id: 'zGjIP4SZlMnY9m93k97r',
    name: 'Hope — Clear, Relatable & Charismatic',
    description: 'The podcaster. Warm, conversational, easy to listen to.',
    tag: 'default',
  },
  {
    voice_id: 'uYXf8XasLslADfZ2MB4u',
    name: 'Hope — Your Conversational Bestie',
    description: 'Bubbly, gossipy, genuine best-friend energy.',
    tag: 'hope',
  },
  {
    voice_id: 'EXAVITQu4vr4xnSDxMaL',
    name: 'Sarah — Mature & Reassuring',
    description: 'Confident, calm, trustworthy.',
  },
  {
    voice_id: 'cgSgspJ2msm6clMCkdW9',
    name: 'Jessica — Playful, Bright, Warm',
    description: 'Friendly and upbeat.',
  },
  {
    voice_id: 'FGY2WhTYpPnrIDTdsKH5',
    name: 'Laura — Enthusiast, Quirky',
    description: 'Lively with attitude.',
  },
  {
    voice_id: '21m00Tcm4TlvDq8ikWAM',
    name: 'Rachel — Calm Narration',
    description: 'Classic ElevenLabs voice.',
  },
  {
    voice_id: 'pFZP5JQG7iQjIQuC4Bku',
    name: 'Lily — Velvety',
    description: 'Smooth, expressive.',
  },
];

function fetchUserVoices(apiKey) {
  return new Promise((resolve) => {
    if (!apiKey) return resolve([]);
    const req = https.request(
      {
        method: 'GET',
        hostname: 'api.elevenlabs.io',
        path: '/v1/voices',
        headers: { 'xi-api-key': apiKey, Accept: 'application/json' },
      },
      (res) => {
        let d = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            resolve(
              (j.voices || []).map((v) => ({
                voice_id: v.voice_id,
                name: v.name,
                description:
                  (v.labels && Object.values(v.labels).filter(Boolean).join(', ')) ||
                  v.category ||
                  '',
              }))
            );
          } catch {
            resolve([]);
          }
        });
      }
    );
    req.on('error', () => resolve([]));
    req.setTimeout(15000, () => req.destroy());
    req.end();
  });
}

// Curated picks first, then any of the user's own voices not already listed.
async function listVoices(apiKey) {
  const user = await fetchUserVoices(apiKey);
  const seen = new Set(CURATED.map((v) => v.voice_id));
  const merged = CURATED.map((v) => ({ ...v }));
  for (const v of user) {
    if (!seen.has(v.voice_id)) {
      merged.push(v);
      seen.add(v.voice_id);
    }
  }
  return merged;
}

module.exports = { listVoices, CURATED };
