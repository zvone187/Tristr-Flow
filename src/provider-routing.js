'use strict';

const FISH_PREFIX = 'fish:';

function isFishVoiceId(voiceId) {
  return typeof voiceId === 'string' && voiceId.startsWith(FISH_PREFIX);
}

// Keep routing policy separate from Electron and provider transports so every
// call site (reading and previews) makes the same privacy/security decision.
function routeVoice({ voiceId, elevenKey = '', fishKey = '', serviceToken = '', forceService = false }) {
  if (isFishVoiceId(voiceId)) {
    if (fishKey) return 'fish-direct';
    if (serviceToken) return 'service';
    return 'unavailable';
  }

  if (forceService && serviceToken) return 'service';
  if (elevenKey) return 'elevenlabs-direct';
  if (serviceToken) return 'service';
  return 'unavailable';
}

module.exports = { routeVoice };
