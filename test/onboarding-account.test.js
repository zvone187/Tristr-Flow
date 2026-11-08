'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../src/onboarding-renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../src/onboarding.html'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(overrides = {}) {
  const elements = new Map();
  function element() {
    const handlers = {};
    return {
      hidden: false, disabled: false, textContent: '', value: '', dataset: {},
      classList: { toggle() {} },
      setAttribute() {},
      addEventListener(event, handler) { handlers[event] = handler; },
      emit(event, data = {}) { return handlers[event]?.({ preventDefault() {}, ...data }); },
      appendChild() {},
    };
  }
  for (const [tag, id] of html.matchAll(/<[a-z]+\b[^>]*? id="([^"]+)"[^>]*>/g)) {
    const node = element();
    node.hidden = /\shidden\b/.test(tag);
    node.disabled = /\sdisabled\b/.test(tag);
    node.checked = /\schecked\b/.test(tag);
    elements.set(id, node);
  }
  const get = (id) => elements.get(id);
  const document = { ...element(), getElementById: get, querySelectorAll: () => [], createElement: element };
  const onb = {
    account: async () => ({ mode: 'unconfigured' }),
    get: async () => ({}),
    curatedVoices: async () => [],
    track() {},
    ...overrides,
  };
  vm.runInNewContext(script, { document, window: { onb } });
  get('email').value = ' user@example.test ';
  get('pass').value = 'mock-password';
  async function submit() {
    await get('accountForm').emit('submit');
    await tick();
  }
  return { get, submit };
}

test('the default account form signs in and shows setup while voice loading is pending', async () => {
  const requests = [];
  const { get, submit } = setup({
    login: async (email, password) => { requests.push(['login', email, password]); return { ok: true, email }; },
    signup: async () => { requests.push(['signup']); return { ok: false }; },
    curatedVoices: () => new Promise(() => {}),
  });
  await tick();
  await submit();
  assert.deepEqual(requests, [['login', 'user@example.test', 'mock-password']]);
  assert.equal(get('step2').hidden, false);
});

test('selecting Create account makes a form submission sign up and allows retry after an error', async () => {
  let attempts = 0;
  const { get, submit } = setup({
    signup: async () => {
      attempts++;
      if (attempts === 1) throw new Error('Connection interrupted');
      return { ok: true, email: 'user@example.test' };
    },
  });
  await tick();
  await get('btnSignup').emit('click');
  assert.equal(attempts, 0);
  await submit();
  assert.ok(get('acctMsg').textContent);
  assert.equal(get('step2').hidden, true);
  assert.equal(get('btnAuthSubmit').disabled, false);
  await submit();
  assert.equal(attempts, 2);
  assert.equal(get('step2').hidden, false);
});

test('reopening setup restores the signed-in account without reentering a password', async () => {
  const { get } = setup({
    account: async () => ({ mode: 'service', email: 'saved@example.test' }),
    curatedVoices: () => new Promise(() => {}),
  });
  await tick();
  assert.equal(get('step2').hidden, false);
  assert.equal(get('step1').hidden, true);
  assert.equal(get('who').textContent, 'saved');
});

test('an existing provider key leaves account sign-in available and can continue without reentry', async () => {
  const { get } = setup({
    account: async () => ({ mode: 'unconfigured', hasDirectKey: true }),
  });
  await tick();
  assert.equal(get('step1').hidden, false);
  assert.equal(get('btnContinueKey').hidden, false);
  await get('btnContinueKey').emit('click');
  assert.equal(get('step2').hidden, false);
});

test('finishing repeat setup preserves the existing Open at Login choice', async () => {
  const writes = [];
  let finished = false;
  let resolveSettings;
  const { get } = setup({
    account: async () => ({ mode: 'service', email: 'saved@example.test', onboarded: true }),
    get: () => new Promise(resolve => { resolveSettings = resolve; }),
    setOpenAtLogin: async value => { writes.push(value); },
    finish: () => { finished = true; },
  });
  await tick();
  resolveSettings({ openAtLogin: false });
  await tick();
  assert.equal(get('openAtLogin').checked, false);
  await get('btnDone').emit('click');
  assert.deepEqual(writes, []);
  assert.equal(finished, true);
});
