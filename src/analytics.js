'use strict';

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
  account_mode: oneOf('direct', 'service', 'unconfigured'),
  action: oneOf('login', 'signup', 'logout', 'set_elevenlabs_key', 'set_fish_key'),
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
    'missing-provider',
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
    'elevenlabs_key',
    'fish_key',
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
    const normalize = PROPERTY_RULES[key];
    if (!normalize) continue;
    const normalized = normalize(value);
    if (normalized !== undefined) safe[key] = normalized;
  }
  return safe;
}

function defaultClientFactory(token, options) {
  const { PostHog } = require('posthog-node');
  return new PostHog(token, {
    ...options,
    flushAt: 10,
    flushInterval: 10000,
    enableExceptionAutocapture: false,
  });
}

function createAnalytics({
  token,
  host = 'https://us.i.posthog.com',
  distinctId = '',
  appVersion,
  platform,
  arch,
  clientFactory = defaultClientFactory,
} = {}) {
  const enabled = !!(token && distinctId);
  if (!enabled) {
    return {
      enabled: false,
      capture() { return false; },
      async shutdown() {},
    };
  }

  let client;
  try {
    client = clientFactory(token, { host });
  } catch (error) {
    console.error('[analytics] initialization failed:', error && error.message ? error.message : error);
    return {
      enabled: false,
      capture() { return false; },
      async shutdown() {},
    };
  }

  const defaults = safeProperties({
    app_version: appVersion,
    platform,
    arch,
  });

  function capture(event, properties) {
    if (!ALLOWED_EVENTS.has(event)) return false;
    try {
      client.capture({
        distinctId,
        event,
        properties: {
          ...defaults,
          $process_person_profile: false,
          $geoip_disable: true,
          ...safeProperties(properties),
        },
      });
      return true;
    } catch (error) {
      console.error('[analytics] capture failed:', error && error.message ? error.message : error);
      return false;
    }
  }

  async function shutdown() {
    try {
      await client.shutdown();
    } catch (error) {
      console.error('[analytics] shutdown failed:', error && error.message ? error.message : error);
    }
  }

  return { enabled: true, capture, shutdown };
}

module.exports = { ALLOWED_EVENTS, PROPERTY_RULES, createAnalytics, safeProperties };
