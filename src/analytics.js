'use strict';

const { randomUUID } = require('node:crypto');

// Analytics is allowlisted, not merely redacted. A renderer or future call site
// cannot invent an event or smuggle user content through a novel property/value.
const ALLOWED_EVENTS = new Set([
  'accessibility_prompt_opened',
  'account_action_completed',
  'app_launched',
  'app_quit',
  'billing_opened',
  'extension_read_completed',
  'extension_read_failed',
  'extension_read_requested',
  'onboarding_completed',
  'onboarding_step_viewed',
  'open_at_login_prompt_responded',
  'open_at_login_prompt_shown',
  'overlay_interaction',
  'read_rejected',
  'read_requested',
  'reading_failed',
  'reading_rejected',
  'reading_playback_completed',
  'reading_playback_started',
  'reading_playback_state_changed',
  'reading_started',
  'reading_stopped',
  'reading_synthesis_completed',
  'selection_capture_finished',
  'setting_changed',
  'shortcut_registration_changed',
  'shortcut_registration_checked',
  'shortcut_registration_recovered',
  'shortcut_registration_refreshed',
  'tray_menu_opened',
  'update_check_completed',
  'update_download_opened',
  'voice_list_completed',
  'voice_preview_completed',
  'voice_search_used',
  'window_closed',
  'window_opened',
]);

const oneOf = (...values) => (value) =>
  typeof value === 'string' && values.includes(value) ? value : undefined;
const boolean = (value) => typeof value === 'boolean' ? value : undefined;
const number = (min, max) => (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : undefined;
const matches = (pattern, maxLength) => (value) =>
  typeof value === 'string' && value.length <= maxLength && pattern.test(value)
    ? value
    : undefined;

const PROPERTY_RULES = {
  accessibility_granted: boolean,
  account_mode: oneOf('service', 'unconfigured'),
  action: oneOf('login', 'signup', 'logout'),
  all_registered: boolean,
  app_version: matches(/^[0-9A-Za-z.+-]+$/, 32),
  arch: oneOf('arm64', 'x64', 'ia32', 'universal'),
  available: boolean,
  character_count: number(0, 5_000_000),
  duration_ms: number(0, 86_400_000),
  edge: oneOf('n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'),
  enabled: boolean,
  error_name: oneOf(
    'AbortError',
    'AggregateError',
    'Error',
    'NetworkError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'TimeoutError',
    'TypeError'
  ),
  font_size: number(10, 100),
  has_formatting: boolean,
  interaction: oneOf(
    'close',
    'hide',
    'open_settings',
    'play',
    'pause',
    'resize',
    'seek',
    'show',
    'voice_picker_closed',
    'voice_picker_opened'
  ),
  launch_count: number(1, 1_000_000),
  manual: boolean,
  onboarded: boolean,
  open_at_login_enabled: boolean,
  outcome: oneOf('success', 'failed', 'rejected', 'cancelled'),
  overlay_mode: oneOf('floating', 'menubar'),
  platform: oneOf('darwin', 'win32', 'linux'),
  playback_state: oneOf('playing', 'paused'),
  position_percent: number(0, 100),
  primary_registered: boolean,
  provider: oneOf('fish', 'service', 'elevenlabs', 'none'),
  reason: oneOf(
    'busy',
    'capture-failed',
    'empty',
    'empty-clipboard',
    'empty-or-nocopy',
    'invalid-request',
    'signed-out',
    'unauthorized',
    'insufficient-credits',
    'cancelled',
    'network-error',
    'no-selection',
    'not-trusted',
    'secure-input',
    'unexpected-error',
    'unsupported',
    'unavailable'
  ),
  recovered_count: number(0, 2),
  secondary_configured: boolean,
  secondary_registered: boolean,
  segment_count: number(0, 10_000),
  setting_name: oneOf(
    'font_size',
    'hotkey_primary',
    'hotkey_secondary',
    'open_at_login',
    'overlay_mode',
    'pause_music',
    'speed',
    'stability',
    'theme',
    'voice'
  ),
  setting_value: oneOf(
    'cleared',
    'configured',
    'creative',
    'dark',
    'disabled',
    'enabled',
    'floating',
    'light',
    'menubar',
    'natural',
    'robust',
    'system'
  ),
  shortcut_slot: number(1, 2),
  source: oneOf(
    'accessibility-granted',
    'shortcut',
    'ax-menu',
    'cmd-c',
    'launch-nudge',
    'none',
    'onboarding',
    'overlay',
    'periodic',
    'preferences',
    'resume',
    'second-instance',
    'system',
    'tray',
    'tray-open',
    'unknown',
    'unlock-screen'
  ),
  speed: number(0.5, 3),
  stability: number(0, 1),
  step: number(1, 2),
  surface: oneOf('extension', 'onboarding', 'overlay', 'preferences', 'system', 'tray'),
  trigger: oneOf('clipboard_menu', 'selected_text_menu', 'shortcut'),
  voice_count: number(0, 100_000),
};

function safeProperties(properties) {
  const safe = {};
  for (const [key, value] of Object.entries(properties || {})) {
    if (!Object.hasOwn(PROPERTY_RULES, key)) continue;
    const normalize = PROPERTY_RULES[key];
    const normalized = normalize(value);
    if (normalized !== undefined) safe[key] = normalized;
  }
  return safe;
}

const BEFORE_LOGIN = new Set([
  'accessibility_prompt_opened', 'account_action_completed', 'app_launched', 'app_quit',
  'extension_read_failed', 'onboarding_step_viewed', 'read_rejected', 'read_requested',
  'reading_rejected', 'shortcut_registration_changed', 'shortcut_registration_checked',
  'shortcut_registration_recovered', 'shortcut_registration_refreshed', 'tray_menu_opened',
  'update_check_completed', 'update_download_opened', 'window_closed', 'window_opened',
]);

function createAnalytics({
  enabled = true, installationId, getSession, appVersion, platform, arch, fetchImpl = fetch,
  batchDelayMs = 750, retryDelaysMs = [1000, 3000, 8000, 15000, 30000, 60000, 60000],
} = {}) {
  const queues = new Map();
  const defaults = safeProperties({ app_version: appVersion, platform, arch });
  let closed = false;

  async function deliver(queue, events) {
    const headers = { 'Content-Type': 'application/json' };
    const body = { events };
    if (queue.token) headers.Authorization = 'Bearer ' + queue.token;
    else body.installationId = installationId;
    try {
      const response = await fetchImpl(new URL('/api/desktop/events', queue.baseUrl), {
        method: 'POST', headers, body: JSON.stringify(body),
        signal: AbortSignal.any([queue.lifetime.signal, AbortSignal.timeout(20000)]),
        redirect: 'error', credentials: 'omit',
      });
      // A bad payload or revoked session cannot succeed on retry.
      return response.ok || (response.status < 500 && ![408, 429].includes(response.status));
    } catch {
      return false;
    }
  }

  function retire(queue) {
    clearTimeout(queue.timer);
    queue.lifetime.abort();
    queue.events.length = 0;
    queues.delete(queue.token);
    queue.resolve();
  }

  function schedule(queue, delayMs) {
    queue.timer = setTimeout(() => drain(queue), delayMs);
    queue.timer.unref();
  }

  async function drain(queue) {
    clearTimeout(queue.timer);
    queue.timer = null;
    if (queue.sending || queue.lifetime.signal.aborted) return;
    queue.sending = true;
    try {
      while (queue.events.length) {
        const batch = queue.events.slice(0, 32);
        const delivered = await deliver(queue, batch);
        if (queue.lifetime.signal.aborted) return;
        if (delivered) {
          queue.events.splice(0, batch.length);
          queue.attempt = 0;
          continue;
        }
        if (queue.attempt >= retryDelaysMs.length) break;
        if (queue.token && !queue.closing && getSession().token !== queue.token) break;
        const delay = retryDelaysMs[queue.attempt++];
        schedule(queue, queue.closing ? Math.min(delay, 100) : delay);
        return;
      }
      retire(queue);
    } finally {
      queue.sending = false;
    }
  }

  async function flushSession(token) {
    const queue = queues.get(token);
    if (!queue) return;
    queue.closing = true;
    // Logout can revoke immediately after this returns. Never keep retrying an
    // expired session or make logout and quit wait through a service cold start.
    const deadline = setTimeout(() => retire(queue), 1500);
    drain(queue);
    try { await queue.finished; } finally { clearTimeout(deadline); }
  }

  function capture(event, properties) {
    if (!enabled || closed || !ALLOWED_EVENTS.has(event)) return false;
    const { baseUrl, token = '' } = getSession();
    const safe = safeProperties(properties);
    if (!token) {
      if (!installationId || !BEFORE_LOGIN.has(event)) return false;
      if (event === 'account_action_completed' &&
          !(['login', 'signup'].includes(safe.action) && ['failed', 'rejected'].includes(safe.outcome))) {
        return false;
      }
    }
    let queue = queues.get(token);
    if (!queue) {
      queue = { baseUrl, token, events: [], timer: null, sending: false, closing: false,
        lifetime: new AbortController(), attempt: 0 };
      queue.finished = new Promise(resolve => { queue.resolve = resolve; });
      queues.set(token, queue);
    }
    if (queue.events.length >= 256) return false;
    queue.events.push({ event, properties: { ...defaults, ...safe }, uuid: randomUUID(), timestamp: new Date().toISOString() });
    if (!queue.sending && !queue.attempt && queue.events.length >= 32) drain(queue);
    else if (!queue.sending && !queue.timer) schedule(queue, batchDelayMs);
    return true;
  }

  return {
    enabled, capture,
    flushSession,
    async shutdown() {
      closed = true;
      await Promise.all(Array.from(queues.keys(), flushSession));
    },
  };
}

module.exports = { ALLOWED_EVENTS, PROPERTY_RULES, createAnalytics, safeProperties };
