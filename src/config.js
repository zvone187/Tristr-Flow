'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// PostHog project tokens are intentionally public ingestion identifiers (the
// same kind embedded in websites and desktop clients), not private API keys.
// Keep the host overrideable so an EU project can use eu.i.posthog.com.
const DEFAULT_POSTHOG_PROJECT_TOKEN = 'phc_wgzcLfm2CQrYydZJmRmPzHFSR6WykLhKAqrpF3GUdxCB';

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
// The Fish Audio key ships as a bare-token file rather than a .env entry, so
// look for it next to the app and in the project checkout (dev machines).
function readKeyFile(p) {
  try {
    const v = fs.readFileSync(p, 'utf8').trim();
    return /^[\w.-]{16,}$/.test(v) ? v : '';
  } catch {
    return '';
  }
}

function loadConfig() {
  const home = os.homedir();
  const paziEnv = readEnvFile(path.join(home, 'Development', 'pazi', 'api', '.env'));
  const appEnv = readEnvFile(path.join(__dirname, '..', '.env'));
  const merged = { ...paziEnv, ...appEnv, ...process.env };

  const fishKey =
    merged.FISH_API_KEY ||
    merged.FISH_AUDIO_API_KEY ||
    readKeyFile(path.join(__dirname, '..', 'fish.audio.key')) ||
    readKeyFile(path.join(home, 'Development', 'Tristr Flow', 'fish.audio.key')) ||
    readKeyFile(path.join(home, 'Development', 'Trister Flow', 'fish.audio.key')) ||
    '';

  return {
    apiKey: merged.ELEVENLABS_API_KEY || merged.ELEVEN_API_KEY || '',
    // Fish Audio: a second TTS provider. Voices from it are namespaced
    // "fish:<id>" so a saved voice always says which provider owns it.
    fishApiKey: fishKey,
    // Fish backbone model: 's1', 's2-pro' or 's2.1-pro'.
    fishModelId: merged.FISH_MODEL_ID || 's1',
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
    // 'floating' = a free pop-up window; 'menubar' = a dropdown anchored under
    // the menu-bar icon that the icon toggles show/hide (audio keeps playing).
    overlayMode: merged.SPEAK_OVERLAY_MODE === 'menubar' ? 'menubar' : 'floating',
    pauseMusic: (merged.SPEAK_PAUSE_MUSIC || 'true') !== 'false',
    hotkey: merged.SPEAK_HOTKEY || 'Control+Shift+Space',
    // Second trigger. Bare "W+D" is intentionally NOT used (it would misfire
    // constantly while typing/gaming); a modifier-anchored "D" combo is safe.
    hotkey2: merged.SPEAK_HOTKEY2 || 'Control+Alt+D',
    posthogToken:
      merged.POSTHOG_DISABLED === 'true'
        ? ''
        : (merged.POSTHOG_PROJECT_TOKEN || DEFAULT_POSTHOG_PROJECT_TOKEN),
    posthogHost: merged.POSTHOG_HOST || 'https://us.i.posthog.com',
  };
}

module.exports = { loadConfig };
