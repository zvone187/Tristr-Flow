'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../src/config');

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('allows analytics to be disabled without removing the shipped project token', () => {
  withEnv({ POSTHOG_DISABLED: 'true' }, () => {
    assert.equal(loadConfig().posthogToken, '');
  });
});

test('allows the PostHog project and regional ingestion host to be overridden', () => {
  withEnv({
    POSTHOG_DISABLED: undefined,
    POSTHOG_PROJECT_TOKEN: 'replacement-public-token',
    POSTHOG_HOST: 'https://eu.i.posthog.com',
  }, () => {
    const config = loadConfig();
    assert.equal(config.posthogToken, 'replacement-public-token');
    assert.equal(config.posthogHost, 'https://eu.i.posthog.com');
  });
});
