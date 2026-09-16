'use strict';

const https = require('https');
const { listFishVoices } = require('./fishaudio');

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

// The Fish library is ~1000 entries and does not change during a session, so
// fetch it once; opening Preferences should not cost two round trips each time.
let fishCache = null;
let fishCacheKey = '';
async function cachedFishVoices(fishKey) {
  if (!fishKey) return [];
  if (fishCache && fishCacheKey === fishKey) return fishCache;
  const list = await listFishVoices(fishKey);
  if (list.length) { fishCache = list; fishCacheKey = fishKey; }
  return list;
}

// Curated ElevenLabs picks first, then the user's own ElevenLabs voices, then
// the Fish Audio library. Every entry carries `provider` so the pickers can
// badge them and so synthesis knows where to route.
async function listVoices(apiKey, fishKey) {
  const [user, fish] = await Promise.all([
    fetchUserVoices(apiKey),
    cachedFishVoices(fishKey).catch(() => []),
  ]);

  const seen = new Set(CURATED.map((v) => v.voice_id));
  const merged = CURATED.map((v) => ({ ...v, provider: 'elevenlabs' }));
  for (const v of user) {
    if (!seen.has(v.voice_id)) {
      merged.push({ ...v, provider: 'elevenlabs' });
      seen.add(v.voice_id);
    }
  }
  for (const v of fish) {
    if (!seen.has(v.voice_id)) {
      merged.push(v); // already tagged provider:'fish'
      seen.add(v.voice_id);
    }
  }
  return merged;
}

module.exports = { listVoices, CURATED };
