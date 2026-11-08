'use strict';

const $ = (id) => document.getElementById(id);

const step1 = $('step1');
const step2 = $('step2');
const dots = document.querySelectorAll('.dot');

const emailEl = $('email');
const passEl = $('pass');
const acctMsgEl = $('acctMsg');
const ownKeyEl = $('ownKey');
const btnSignup = $('btnSignup');
const btnLogin = $('btnLogin');
const btnOwnKey = $('btnOwnKey');
const btnAuthSubmit = $('btnAuthSubmit');
const btnContinueKey = $('btnContinueKey');

const voiceEl = $('voice');
const whoEl = $('who');
const comboEl = $('combo');
const btnRec = $('btnRec');
const scHintEl = $('scHint');
const DEFAULT_SC_HINT = scHintEl.textContent;
const btnDone = $('btnDone');
const openAtLoginEl = $('openAtLogin');

let recording = false;
let useExistingLoginPreference = true;

// ---- shortcut encoding (mirrors settings-renderer) ----------------------
function accelToSymbols(accel) {
  if (!accel) return '—';
  return accel
    .replace('CommandOrControl', '⌘').replace('Command', '⌘')
    .replace('Control', '⌃').replace('Alt', '⌥').replace('Option', '⌥')
    .replace('Shift', '⇧').replace(/\+/g, ' ');
}
function eventToAccel(e) {
  const mods = [];
  if (e.metaKey) mods.push('Command');
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  const code = e.code;
  let key = null;
  if (code === 'Space') key = 'Space';
  else if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else {
    const m = { Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';',
      Quote: "'", Minus: '-', Equal: '=', Backquote: '`', BracketLeft: '[', BracketRight: ']',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Enter: 'Return', Tab: 'Tab', Delete: 'Delete', Backspace: 'Backspace',
      Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert' };
    key = m[code] || null;
  }
  return { mods, key };
}

// ---- account -------------------------------------------------------------
function acctMsg(text, isErr) {
  acctMsgEl.textContent = text || '';
  acctMsgEl.classList.toggle('err', !!isErr);
}

function goStep2(email = '') {
  if (!step2.hidden) return;
  openAtLoginEl.disabled = useExistingLoginPreference;
  whoEl.textContent = email.split('@')[0];
  step1.hidden = true;
  step2.hidden = false;
  dots.forEach((d) => d.classList.toggle('active', d.dataset.step === '2'));
  window.onb.track('onboarding_step_viewed', { surface: 'onboarding', step: 2 });
  loadStep2Data();
}

let accountAction = 'login';

function selectAccountAction(action) {
  accountAction = action;
  const login = action === 'login';
  btnLogin.setAttribute('aria-pressed', String(login));
  btnSignup.setAttribute('aria-pressed', String(!login));
  passEl.autocomplete = login ? 'current-password' : 'new-password';
  passEl.minLength = login ? 0 : 8;
  passEl.placeholder = login ? 'Password' : 'Password (8 or more characters)';
  btnAuthSubmit.textContent = login ? 'Sign in' : 'Create account';
  acctMsg('');
}

function setAccountBusy(busy) {
  for (const button of [btnAuthSubmit, btnSignup, btnLogin, btnOwnKey, btnContinueKey]) {
    button.disabled = busy;
  }
}

btnLogin.addEventListener('click', () => selectAccountAction('login'));
btnSignup.addEventListener('click', () => selectAccountAction('signup'));
$('accountForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (btnAuthSubmit.disabled) return;
  const email = emailEl.value.trim();
  const password = passEl.value;
  acctMsg(accountAction === 'login' ? 'Signing in…' : 'Creating your account…');
  setAccountBusy(true);
  try {
    const result = await window.onb[accountAction](email, password);
    if (result && result.ok) {
      passEl.value = '';
      goStep2(result.email || email);
    } else {
      acctMsg((result && result.error) || 'Could not reach your account. Try again.', true);
    }
  } catch {
    acctMsg('Could not connect. Check your connection and try again.', true);
  } finally {
    setAccountBusy(false);
  }
});

btnContinueKey.addEventListener('click', () => goStep2());
btnOwnKey.addEventListener('click', async () => {
  const key = ownKeyEl.value.trim();
  if (!key) {
    window.onb.track('account_action_completed', {
      surface: 'onboarding',
      action: 'set_elevenlabs_key',
      outcome: 'rejected',
      reason: 'invalid-request',
    });
    acctMsg('Paste your ElevenLabs key (starts with sk_).', true);
    return;
  }
  setAccountBusy(true);
  try {
    const result = await window.onb.setOwnKey(key);
    if (result && result.ok && result.hasOwnKey) {
      ownKeyEl.value = '';
      goStep2();
    } else {
      acctMsg('Check your key and try again.', true);
    }
  } catch {
    acctMsg('Could not save your key. Try again.', true);
  } finally {
    setAccountBusy(false);
  }
});

// Show the saved shortcut and voice immediately, even if the catalogue is slow.
async function loadStep2Data() {
  const cfg = await window.onb.get().catch(() => ({}));
  if (useExistingLoginPreference && typeof cfg.openAtLogin === 'boolean') {
    openAtLoginEl.checked = cfg.openAtLogin;
    openAtLoginEl.disabled = false;
  }
  if (cfg.hotkey) comboEl.textContent = accelToSymbols(cfg.hotkey);
  const addVoice = (id, name) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = option.dataset.name = name;
    option.selected = id === cfg.voiceId;
    voiceEl.appendChild(option);
  };
  if (cfg.voiceId) {
    voiceEl.innerHTML = '';
    addVoice(cfg.voiceId, cfg.voiceName || cfg.voiceId);
  }
  const voices = await window.onb.curatedVoices().catch(() => []);
  if (!voices.length) return;
  voiceEl.innerHTML = '';
  if (cfg.voiceId && !voices.some(v => v.voice_id === cfg.voiceId)) {
    addVoice(cfg.voiceId, cfg.voiceName || cfg.voiceId);
  }
  for (const voice of voices) addVoice(voice.voice_id, voice.name);
  voiceEl.disabled = false;
}

voiceEl.addEventListener('change', () => {
  const opt = voiceEl.options[voiceEl.selectedIndex];
  if (opt) window.onb.setVoice(opt.value, opt.dataset.name || '');
});

btnRec.addEventListener('click', () => {
  recording = true;
  comboEl.classList.add('recording');
  comboEl.textContent = 'Press keys…';
  scHintEl.textContent = 'Hold a modifier (⌃ ⌥ ⌘ ⇧) and press a key — or a function key.';
});

document.addEventListener('keydown', async (e) => {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') {
    recording = false;
    comboEl.classList.remove('recording');
    const cfg = await window.onb.get();
    comboEl.textContent = accelToSymbols(cfg.hotkey);
    scHintEl.textContent = DEFAULT_SC_HINT;
    return;
  }
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
  const { mods, key } = eventToAccel(e);
  if (!key) { scHintEl.textContent = 'That key isn’t supported — try another.'; return; }
  const isFn = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
  if (mods.length === 0 && !isFn) {
    scHintEl.textContent = 'Add a modifier (⌃ ⌥ ⌘ ⇧), or use a function key.';
    return;
  }
  recording = false;
  comboEl.classList.remove('recording');
  const res = await window.onb.setHotkey(1, mods.concat(key).join('+'));
  comboEl.textContent = accelToSymbols(res.hotkey);
  scHintEl.textContent = res.ok ? 'Saved ✓ — ' + DEFAULT_SC_HINT : (res.error || 'That combo is unavailable.');
}, true);

if (openAtLoginEl) {
  openAtLoginEl.addEventListener('change', () => window.onb.setOpenAtLogin(openAtLoginEl.checked));
}

btnDone.addEventListener('click', async () => {
  // Returning users already have an OS preference. Only a checkbox change
  // should modify it when they revisit setup to repair a permission.
  if (!useExistingLoginPreference) await window.onb.setOpenAtLogin(openAtLoginEl.checked);
  window.onb.finish();
});

window.onb.account().catch(() => ({})).then((account) => {
  useExistingLoginPreference = !!(account.onboarded || account.email || account.mode === 'service' || account.hasDirectKey);
  if (account.email || account.mode === 'service') {
    goStep2(account.email);
  } else {
    btnContinueKey.hidden = !account.hasDirectKey;
    window.onb.track('onboarding_step_viewed', { surface: 'onboarding', step: 1 });
  }
});
