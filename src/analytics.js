'use strict';

// Analytics is allowlisted, not merely redacted. A future call site cannot
// accidentally send selected content or credentials under a novel property key.
const ALLOWED_PROPERTIES = new Set([
  'accessibility_granted',
  'all_registered',
  'app_version',
  'arch',
  'character_count',
  'error_name',
  'has_formatting',
  'outcome',
  'overlay_mode',
  'platform',
  'primary_registered',
  'provider',
  'reason',
  'recovered_count',
  'secondary_configured',
  'secondary_registered',
  'segment_count',
  'source',
  'trigger',
]);

function safeProperties(properties) {
  const safe = {};
  for (const [key, value] of Object.entries(properties || {})) {
    if (!ALLOWED_PROPERTIES.has(key)) continue;
    if (
      value !== null &&
      value !== undefined &&
      (typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean')
    ) {
      safe[key] = value;
    }
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
      capture() {},
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
      capture() {},
      async shutdown() {},
    };
  }

  const defaults = safeProperties({
    app_version: appVersion,
    platform,
    arch,
  });

  function capture(event, properties) {
    if (!event || typeof event !== 'string') return;
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
    } catch (error) {
      console.error('[analytics] capture failed:', error && error.message ? error.message : error);
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

module.exports = { createAnalytics, safeProperties };
