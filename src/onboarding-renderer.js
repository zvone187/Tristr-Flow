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

const voiceEl = $('voice');
const whoEl = $('who');
const comboEl = $('combo');
const btnRec = $('btnRec');
const scHintEl = $('scHint');
const DEFAULT_SC_HINT = scHintEl.textContent;
const btnDone = $('btnDone');
const openAtLoginEl = $('openAtLogin');

let recording = false;

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

async function goStep2() {
  const a = await window.onb.account().catch(() => ({}));
  whoEl.textContent = a && a.email ? a.email.split('@')[0] : '';
  step1.hidden = true;
  step2.hidden = false;
  dots.forEach((d) => d.classList.toggle('active', d.dataset.step === '2'));
}

async function doAuth(fn) {
  const email = (emailEl.value || '').trim();
  const pass = passEl.value || '';
  if (!email || !pass) { acctMsg('Enter your email and a password.', true); return; }
  acctMsg('Working…');
  btnSignup.disabled = btnLogin.disabled = true;
  const r = await fn(email, pass);
  btnSignup.disabled = btnLogin.disabled = false;
  if (r && r.ok) { acctMsg(''); await goStep2(); }
  else { acctMsg((r && r.error) || 'Something went wrong.', true); }
}

btnSignup.addEventListener('click', () => doAuth(window.onb.signup));
btnLogin.addEventListener('click', () => doAuth(window.onb.login));
btnOwnKey.addEventListener('click', async () => {
  const key = (ownKeyEl.value || '').trim();
  if (!key) { acctMsg('Paste your ElevenLabs key (starts with sk_).', true); return; }
  const r = await window.onb.setOwnKey(key);
  if (r && r.ok && r.hasOwnKey) { acctMsg(''); await goStep2(); }
  else { acctMsg('That key didn’t take — check it and try again.', true); }
});
passEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAuth(window.onb.signup); } });

// ---- step 2: voice + shortcut + finish -----------------------------------
async function loadStep2Data() {
  const [voices, cfg] = await Promise.all([
    window.onb.curatedVoices().catch(() => []),
    window.onb.get().catch(() => ({})),
  ]);
  voiceEl.innerHTML = '';
  (voices || []).forEach((v) => {
    const o = document.createElement('option');
    o.value = v.voice_id;
    o.textContent = v.name;
    o.dataset.name = v.name;
    if (v.voice_id === cfg.voiceId) o.selected = true;
    voiceEl.appendChild(o);
  });
  if (cfg.hotkey) comboEl.textContent = accelToSymbols(cfg.hotkey);
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
  if (openAtLoginEl) await window.onb.setOpenAtLogin(openAtLoginEl.checked); // apply the (default-on) choice
  window.onb.finish();
});

loadStep2Data();
