'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Minimal .env parser (handles quotes; ignores comments / blank lines).
function parseEnv(content) {
  const out = {};
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function readEnvFile(p) {
  try {
    return parseEnv(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

// Resolves config from (lowest -> highest priority):
//   1. ~/Development/pazi/api/.env   (where the key already lives)
//   2. <app>/.env                    (local override you can drop next to the app)
//   3. real environment variables
function loadConfig() {
  const home = os.homedir();
  const paziEnv = readEnvFile(path.join(home, 'Development', 'pazi', 'api', '.env'));
  const appEnv = readEnvFile(path.join(__dirname, '..', '.env'));
  const merged = { ...paziEnv, ...appEnv, ...process.env };

  return {
    apiKey: merged.ELEVENLABS_API_KEY || merged.ELEVEN_API_KEY || '',
    // Hosted Tristr Flow service. Used in "service mode" (no own ElevenLabs key):
    // the app logs in and routes TTS through the credit-metered proxy.
    serviceBaseUrl: merged.SPEAK_SERVICE_URL || 'https://tristr-flow.onrender.com',
    // Force routing through the hosted service even when a local key exists
    // (for testing the service path on a dev machine that has its own key).
    forceService: (merged.SPEAK_FORCE_SERVICE || 'false') === 'true',
    // Default: ElevenLabs "Hope — Clear, Relatable & Charismatic".
    voiceId: merged.SPEAK_VOICE_ID || 'zGjIP4SZlMnY9m93k97r',
    voiceName: merged.SPEAK_VOICE_NAME || 'Hope — Clear, Relatable & Charismatic',
    // Newest / highest-quality model. Verified to support the with-timestamps
    // endpoint (required for karaoke highlighting).
    modelId: merged.SPEAK_MODEL_ID || 'eleven_v3',
    speed: parseFloat(merged.SPEAK_SPEED || '1.0'),
    // v3's only effective knob: 0.0 Creative / 0.5 Natural / 1.0 Robust.
    // Higher = steadier (fixes "sounds weird"); lower = more expressive.
    stability: parseFloat(merged.SPEAK_STABILITY || '0.5'),
    maxChars: parseInt(merged.SPEAK_MAX_CHARS || '5000', 10),
    fontSize: parseInt(merged.SPEAK_FONT_SIZE || '20', 10),
    theme: merged.SPEAK_THEME || 'system', // system | light | dark
    pauseMusic: (merged.SPEAK_PAUSE_MUSIC || 'true') !== 'false',
    hotkey: merged.SPEAK_HOTKEY || 'Control+Shift+Space',
    // Second trigger. Bare "W+D" is intentionally NOT used (it would misfire
    // constantly while typing/gaming); a modifier-anchored "D" combo is safe.
    hotkey2: merged.SPEAK_HOTKEY2 || 'Control+Alt+D',
  };
}

module.exports = { loadConfig };
