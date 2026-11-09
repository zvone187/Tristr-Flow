'use strict';

// Curated ElevenLabs voices also appear when the service catalogue is unavailable.
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
].map(voice => ({ ...voice, provider: 'elevenlabs' }));

function isFishVoice(voiceId) {
  return typeof voiceId === 'string' && voiceId.startsWith('fish:');
}

function mergeVoices(localVoices, serviceVoices) {
  const merged = [];
  const seen = new Set();
  for (const voice of [...(localVoices || []), ...(serviceVoices || [])]) {
    if (!voice || !voice.voice_id || seen.has(voice.voice_id)) continue;
    seen.add(voice.voice_id);
    merged.push(voice);
  }
  return merged;
}

function restoreVoice(saved, config) {
  const id = saved.voiceId || config.voiceId;
  // A provider's private voices belonged to the old personal key. Its public
  // catalogue is available again in the picker after account sign-in.
  const hadPersonalProvider = isFishVoice(id) ? saved.fishKey : saved.ownKey;
  if (hadPersonalProvider && !CURATED.some(voice => voice.voice_id === id)) {
    return { voiceId: CURATED[0].voice_id, voiceName: CURATED[0].name };
  }
  return { voiceId: id, voiceName: saved.voiceName || config.voiceName };
}

module.exports = { restoreVoice, CURATED, mergeVoices, isFishVoice };
