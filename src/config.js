'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SERVICE_BASE_URL = 'https://tristr-flow-5iy7.onrender.com';

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

function clampSpeed(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(3, Math.max(0.5, number));
}

function clampStability(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.min(1, Math.max(0, number));
}

function loadConfig({ packaged = false } = {}) {
  const appEnv = packaged ? {} : readEnvFile(path.join(__dirname, '..', '.env'));
  const merged = { ...appEnv, ...process.env };

  return {
    serviceBaseUrl: merged.SPEAK_SERVICE_URL || DEFAULT_SERVICE_BASE_URL,
    voiceId: merged.SPEAK_VOICE_ID || 'zGjIP4SZlMnY9m93k97r',
    voiceName: merged.SPEAK_VOICE_NAME || 'Hope — Clear, Relatable & Charismatic',
    speed: parseFloat(merged.SPEAK_SPEED || '1.0'),
    // v3's only effective knob: 0.0 Creative / 0.5 Natural / 1.0 Robust.
    // Higher = steadier (fixes "sounds weird"); lower = more expressive.
    stability: parseFloat(merged.SPEAK_STABILITY || '0.5'),
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
    analyticsDisabled: merged.POSTHOG_DISABLED === 'true',
  };
}

module.exports = { DEFAULT_SERVICE_BASE_URL, loadConfig, clampSpeed, clampStability };
