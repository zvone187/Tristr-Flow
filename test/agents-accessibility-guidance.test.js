const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('AGENTS.md documents Accessibility signature recovery and release safety', () => {
  const guidance = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8');

  assert.match(guidance, /ad-hoc/i);
  assert.match(guidance, /code-signing requirement/i);
  assert.match(guidance, /tccutil reset Accessibility ai\.pazi\.tristrflow/);
  assert.match(guidance, /physical shortcut/i);
});
