'use strict';

const listEl = document.getElementById('list');
const searchEl = document.getElementById('search');
const speedEl = document.getElementById('speed');
const speedValEl = document.getElementById('speedval');
const keyStateEl = document.getElementById('keystate');
const stabilityEl = document.getElementById('stability');
const themeEl = document.getElementById('theme');
const overlayModeEl = document.getElementById('overlaymode');
const pauseMusicEl = document.getElementById('pausemusic');
const openAtLoginEl = document.getElementById('openatlogin');
const fontSizeEl = document.getElementById('fontsize');
const fontSizeValEl = document.getElementById('fontsizeval');
const combo1El = document.getElementById('combo1');
const combo2El = document.getElementById('combo2');
const scHintEl = document.getElementById('schint');
const DEFAULT_SC_HINT = scHintEl ? scHintEl.textContent : '';
let recordingWhich = 0;

let voices = [];
let selectedId = null;
let previewAudio = null;
let previewGen = 0; // invalidates in-flight previews when a newer one starts / stops

function speedLabel(v) {
  const n = Number(v);
  const tag = Math.abs(n - 1) < 0.001 ? ' · normal' : n < 1 ? ' · slower' : ' · faster';
  return n.toFixed(2) + '×' + tag;
}

function setActiveStability(val) {
  stabilityEl.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', Math.abs(Number(b.dataset.val) - Number(val)) < 0.001);
  });
}

function setActiveTheme(val) {
  themeEl.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.val === val);
  });
}

function setActiveMode(val) {
  if (!overlayModeEl) return;
  overlayModeEl.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.val === val);
  });
}

function stopPreview() {
  previewGen++; // any in-flight preview await is now stale
  if (previewAudio) {
    previewAudio.pause();
    previewAudio = null;
  }
  document.querySelectorAll('.preview').forEach((b) => {
    b.disabled = false;
    b.textContent = '▶ Preview';
    delete b.dataset.playing;
  });
}

function selectVoice(v) {
  selectedId = v.voice_id;
  document.querySelectorAll('.voice').forEach((el) => {
    el.classList.toggle('selected', el.dataset.id === selectedId);
  });
  window.prefs.setVoice(v.voice_id, v.name);
}

async function doPreview(v, btn) {
  stopPreview();
  const myGen = ++previewGen; // claim this preview; a newer one/stop invalidates it
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const res = await window.prefs.preview(v.voice_id, Number(speedEl.value));
    if (myGen !== previewGen) return; // superseded by a newer preview or a stop
    if (res && res.audioBase64) {
      previewAudio = new Audio('data:audio/mpeg;base64,' + res.audioBase64);
      previewAudio.preservesPitch = true;
      previewAudio.playbackRate = Number(speedEl.value);
      previewAudio.addEventListener('ended', stopPreview);
      btn.disabled = false;
      btn.textContent = '■ Stop';
      btn.dataset.playing = '1';
      await previewAudio.play();
    } else {
      btn.disabled = false;
      btn.textContent = '⚠︎';
      setTimeout(() => (btn.textContent = '▶ Preview'), 1500);
    }
  } catch {
    if (myGen !== previewGen) return;
    btn.disabled = false;
    btn.textContent = '⚠︎';
    setTimeout(() => (btn.textContent = '▶ Preview'), 1500);
  }
}

function render(filter) {
  const f = (filter || '').toLowerCase().trim();
  const shown = voices.filter((v) => {
    if (!f) return true;
    const provText = v.provider === 'fish' ? 'fish audio fish' : 'elevenlabs eleven 11l';
    return (
      v.name.toLowerCase().includes(f) ||
      (v.description || '').toLowerCase().includes(f) ||
      provText.includes(f) // typing "fish" narrows to that provider
    );
  });
  listEl.innerHTML = '';
  if (!shown.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'No voices match.';
    listEl.appendChild(d);
    return;
  }
  for (const v of shown) {
    const row = document.createElement('div');
    row.className = 'voice' + (v.voice_id === selectedId ? ' selected' : '');
    row.dataset.id = v.voice_id;

    const radio = document.createElement('div');
    radio.className = 'radio';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'vname';
    name.textContent = v.name;
    if (v.tag === 'default') {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = 'Default';
      name.appendChild(chip);
    } else if (v.tag === 'hope') {
      const chip = document.createElement('span');
      chip.className = 'chip hope';
      chip.textContent = 'Hope';
      name.appendChild(chip);
    } else if (v.tag === 'custom') {
      const chip = document.createElement('span');
      chip.className = 'chip mine';
      chip.textContent = 'Yours';
      chip.title = 'Your own voice on Fish Audio';
      name.appendChild(chip);
    }
    // Which engine speaks this voice — ElevenLabs and Fish Audio side by side.
    const prov = document.createElement('span');
    const isFish = v.provider === 'fish';
    prov.className = 'chip prov ' + (isFish ? 'fish' : 'el');
    prov.textContent = isFish ? 'Fish' : '11L';
    prov.title = isFish ? 'Fish Audio' : 'ElevenLabs';
    name.appendChild(prov);

    const desc = document.createElement('div');
    desc.className = 'vdesc';
    desc.textContent = v.description || '';
    meta.appendChild(name);
    if (v.description) meta.appendChild(desc);

    const btn = document.createElement('button');
    btn.className = 'preview';
    btn.textContent = '▶ Preview';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.dataset.playing === '1') {
        stopPreview();
      } else {
        doPreview(v, btn);
      }
    });

    row.appendChild(radio);
    row.appendChild(meta);
    row.appendChild(btn);
    row.addEventListener('click', () => selectVoice(v));
    listEl.appendChild(row);
  }
}

async function init() {
  const cfg = await window.prefs.get();
  selectedId = cfg.voiceId;
  renderCombos(cfg.hotkey, cfg.hotkey2);
  setActiveTheme(cfg.theme || 'system');
  setActiveMode(cfg.overlayMode === 'menubar' ? 'menubar' : 'floating');
  if (pauseMusicEl) pauseMusicEl.checked = cfg.pauseMusic !== false;
  if (openAtLoginEl) openAtLoginEl.checked = !!cfg.openAtLogin;
  if (fontSizeEl && cfg.fontSize) {
    fontSizeEl.value = cfg.fontSize;
    fontSizeValEl.textContent = cfg.fontSize + ' px';
  }
  setActiveStability(cfg.stability);
  speedEl.value = cfg.speed;
  speedValEl.textContent = speedLabel(cfg.speed);
  setFishState(cfg.fishKeyPresent, cfg.fishServiceAvailable);
  setProviderState(cfg);

  voices = await window.prefs.listVoices();
  // Make sure the currently-selected voice is visible even if not curated.
  if (selectedId && !voices.some((v) => v.voice_id === selectedId)) {
    voices.unshift({
      voice_id: selectedId,
      name: cfg.voiceName || 'Current voice',
      description: '',
      provider: selectedId.startsWith('fish:') ? 'fish' : 'elevenlabs',
    });
  }
  render('');
  loadAccount();
}

speedEl.addEventListener('input', () => {
  speedValEl.textContent = speedLabel(speedEl.value);
});
speedEl.addEventListener('change', () => {
  window.prefs.setSpeed(Number(speedEl.value));
});
stabilityEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-val]');
  if (!btn) return;
  const val = Number(btn.dataset.val);
  setActiveStability(val);
  window.prefs.setStability(val);
});

themeEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-val]');
  if (!btn) return;
  setActiveTheme(btn.dataset.val);
  window.prefs.setTheme(btn.dataset.val);
});

if (overlayModeEl) {
  overlayModeEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-val]');
    if (!btn) return;
    setActiveMode(btn.dataset.val);
    window.prefs.setOverlayMode(btn.dataset.val);
  });
}

let voiceSearchTracked = false;
searchEl.addEventListener('input', () => {
  render(searchEl.value);
  if (!voiceSearchTracked && searchEl.value.trim()) {
    voiceSearchTracked = true;
    window.prefs.track('voice_search_used', { surface: 'preferences' });
  }
});

if (pauseMusicEl) {
  pauseMusicEl.addEventListener('change', () => window.prefs.setPauseMusic(pauseMusicEl.checked));
}
if (openAtLoginEl) {
  openAtLoginEl.addEventListener('change', async () => {
    const r = await window.prefs.setOpenAtLogin(openAtLoginEl.checked);
    if (r && typeof r.openAtLogin === 'boolean') openAtLoginEl.checked = r.openAtLogin;
  });
}
if (fontSizeEl) {
  fontSizeEl.addEventListener('input', () => { fontSizeValEl.textContent = fontSizeEl.value + ' px'; });
  fontSizeEl.addEventListener('change', () => window.prefs.setFontSize(Number(fontSizeEl.value)));
}

// ---- shortcuts ----------------------------------------------------------
function accelToSymbols(accel) {
  if (!accel) return '—';
  return accel
    .replace('CommandOrControl', '⌘').replace('Command', '⌘')
    .replace('Control', '⌃').replace('Alt', '⌥').replace('Option', '⌥')
    .replace('Shift', '⇧').replace(/\+/g, ' ');
}
function renderCombos(hotkey, hotkey2) {
  if (combo1El) combo1El.textContent = accelToSymbols(hotkey);
  if (combo2El) combo2El.textContent = accelToSymbols(hotkey2);
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
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Return', Tab: 'Tab',
      Delete: 'Delete', Backspace: 'Backspace', Home: 'Home', End: 'End',
      PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert' };
    key = m[code] || null;
  }
  return { mods, key };
}
function startRecording(which) {
  recordingWhich = which;
  const el = which === 2 ? combo2El : combo1El;
  if (el) { el.classList.add('recording'); el.textContent = 'Press keys…'; }
  scHintEl.textContent = 'Listening… press a ⌃⌥⌘⇧ combo or a function key (F1–F12). Esc to cancel.';
}
function stopRecording() {
  recordingWhich = 0;
  if (combo1El) combo1El.classList.remove('recording');
  if (combo2El) combo2El.classList.remove('recording');
}

document.querySelectorAll('.rec').forEach((b) =>
  b.addEventListener('click', () => { b.blur(); startRecording(Number(b.dataset.which)); })
);
document.querySelectorAll('.clr').forEach((b) =>
  b.addEventListener('click', async () => {
    const res = await window.prefs.setHotkey(2, '');
    renderCombos(res.hotkey, res.hotkey2);
    scHintEl.textContent = 'Removed.';
  })
);

// Capture phase so Esc cancels recording instead of closing the window.
document.addEventListener('keydown', async (e) => {
  if (recordingWhich) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      const c = await window.prefs.get();
      stopRecording();
      renderCombos(c.hotkey, c.hotkey2);
      scHintEl.textContent = DEFAULT_SC_HINT;
      return;
    }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
      scHintEl.textContent = 'Modifiers held — now press a key (a letter, number, or F-key)…';
      return;
    }
    const { mods, key } = eventToAccel(e);
    if (!key) {
      if (e.key === 'Fn' || e.key === 'Globe' || e.code === 'Fn') {
        scHintEl.textContent = 'The Fn/Globe key can’t be a shortcut. Try a function key like F6, or a ⌃⌥⌘⇧ combo.';
      } else if (/^(AudioVolume|Media|Browser|Brightness|Launch|Eject)/.test(e.code || '')) {
        scHintEl.textContent = 'That media key isn’t available. For F-keys, hold Fn (top-row keys are media keys by default).';
      } else {
        scHintEl.textContent = 'That key isn’t supported — try another.';
      }
      return;
    }
    // Function keys are valid as standalone shortcuts; everything else needs a modifier.
    const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
    if (mods.length === 0 && !isFunctionKey) {
      scHintEl.textContent = 'Add a modifier (⌃ ⌥ ⌘ or ⇧), or use a function key (F1–F12).';
      return;
    }
    const which = recordingWhich;
    stopRecording();
    const res = await window.prefs.setHotkey(which, mods.concat(key).join('+'));
    renderCombos(res.hotkey, res.hotkey2);
    scHintEl.textContent = res.ok ? 'Saved ✓' : (res.error || 'Could not set that shortcut.');
    return;
  }
  if (e.key === 'Escape') window.prefs.close();
}, true);

// If the window loses focus mid-recording, cancel cleanly (keys won't arrive).
window.addEventListener('blur', () => {
  if (!recordingWhich) return;
  stopRecording();
  window.prefs.get().then((c) => {
    renderCombos(c.hotkey, c.hotkey2);
    scHintEl.textContent = DEFAULT_SC_HINT;
  });
});

// ---- account / service mode ---------------------------------------------
const acctInfoEl = document.getElementById('acctinfo');
const acctSignedOutEl = document.getElementById('acctsignedout');
const acctSignedInEl = document.getElementById('acctsignedin');
const acctEmailEl = document.getElementById('acctemail');
const acctPassEl = document.getElementById('acctpass');
const acctMsgEl = document.getElementById('acctmsg');
const ownKeyEl = document.getElementById('ownkey');
const btnLogin = document.getElementById('btnlogin');
const btnSignup = document.getElementById('btnsignup');
const btnLogout = document.getElementById('btnlogout');
const btnOwnKey = document.getElementById('btnownkey');
const fishKeyEl = document.getElementById('fishkey');
const btnFishKey = document.getElementById('btnfishkey');
const fishStateEl = document.getElementById('fishstate');
const fishMsgEl = document.getElementById('fishmsg');
const btnClearKey = document.getElementById('btnclearkey');
const btnUpgrade = document.getElementById('btnupgrade');
const btnBilling = document.getElementById('btnbilling');

function acctMsg(text, isErr) {
  if (!acctMsgEl) return;
  acctMsgEl.textContent = text || '';
  acctMsgEl.classList.toggle('err', !!isErr);
}

function renderAccount(a) {
  const signedIn = !!a.signedIn;
  const ownKey = !!a.hasOwnKey;
  acctSignedOutEl.hidden = signedIn || ownKey;
  acctSignedInEl.hidden = !(signedIn || ownKey);
  if (signedIn) {
    const left = a.minutesLeft != null
      ? ` · ~${a.minutesLeft} min left`
      : (a.creditsDollars != null ? ` · $${a.creditsDollars} left` : '');
    const planTag = a.plan === 'pro' ? ' · Pro' : '';
    const directTag = ownKey ? ' · personal ElevenLabs key' : '';
    acctInfoEl.textContent = `Signed in as ${a.email}${planTag}${left}${directTag}`;
    btnLogout.hidden = false;
    btnClearKey.hidden = !ownKey || a.ownKeyFromEnv;
    btnUpgrade.hidden = a.plan === 'pro';  // offer upgrade only on the free plan
    btnBilling.hidden = a.plan !== 'pro';  // manage only when subscribed
  } else if (ownKey) {
    acctInfoEl.textContent = a.ownKeyFromEnv
      ? 'Using your ElevenLabs key (from .env)'
      : 'Using your own ElevenLabs key';
    btnLogout.hidden = true;
    btnClearKey.hidden = a.ownKeyFromEnv; // an env-provided key can't be cleared in-app
    btnUpgrade.hidden = true;
    btnBilling.hidden = true;
  } else {
    acctInfoEl.textContent = 'Sign in for $2 of free reading — or use your own key.';
  }
  if (a.error) acctMsg(a.error, true);
}

async function loadAccount() {
  try {
    renderAccount(await window.prefs.account());
  } catch {
    if (acctInfoEl) acctInfoEl.textContent = 'Account unavailable.';
  }
}

async function doAuth(fn, action) {
  const email = (acctEmailEl.value || '').trim();
  const pass = acctPassEl.value || '';
  if (!email || !pass) {
    window.prefs.track('account_action_completed', {
      surface: 'preferences',
      action,
      outcome: 'rejected',
      reason: 'invalid-request',
    });
    acctMsg('Enter your email and password.', true);
    return;
  }
  acctMsg('Working…');
  btnLogin.disabled = btnSignup.disabled = true;
  const r = await fn(email, pass);
  btnLogin.disabled = btnSignup.disabled = false;
  if (r && r.ok) {
    acctPassEl.value = '';
    acctMsg('');
    await loadAccount();
    await refreshVoiceAccess();
  }
  else { acctMsg((r && r.error) || 'Could not sign in.', true); }
}

if (btnLogin) btnLogin.addEventListener('click', () => doAuth(window.prefs.login, 'login'));
if (btnSignup) btnSignup.addEventListener('click', () => doAuth(window.prefs.signup, 'signup'));
if (btnLogout) btnLogout.addEventListener('click', async () => {
  await window.prefs.logout();
  await loadAccount();
  await refreshVoiceAccess();
});
if (btnOwnKey) btnOwnKey.addEventListener('click', async () => {
  const key = (ownKeyEl.value || '').trim();
  if (!key) {
    window.prefs.track('account_action_completed', {
      surface: 'preferences',
      action: 'set_elevenlabs_key',
      outcome: 'rejected',
      reason: 'invalid-request',
    });
    acctMsg('Paste your ElevenLabs key (starts with sk_).', true);
    return;
  }
  await window.prefs.setOwnKey(key);
  ownKeyEl.value = '';
  await loadAccount();
  await refreshVoiceAccess();
});
function setProviderState(cfg) {
  if (!keyStateEl) return;
  keyStateEl.classList.remove('warn');
  if (cfg.apiKeyPresent) keyStateEl.textContent = '✓ personal ElevenLabs key';
  else if (cfg.fishServiceAvailable) keyStateEl.textContent = '✓ ElevenLabs + Fish included';
  else {
    keyStateEl.textContent = '⚠ Sign in or add a key';
    keyStateEl.classList.add('warn');
  }
}
function setFishState(present, serviceAvailable) {
  if (fishStateEl) {
    fishStateEl.textContent = present
      ? '✓ personal key'
      : (serviceAvailable ? '✓ included with account' : 'sign in or add a key');
  }
  if (fishKeyEl) fishKeyEl.placeholder = present ? 'Key saved — paste a new one to replace' : 'Fish Audio API key (sk-…)';
}

async function refreshVoiceAccess() {
  const cfg = await window.prefs.get();
  setProviderState(cfg);
  setFishState(cfg.fishKeyPresent, cfg.fishServiceAvailable);
  voices = await window.prefs.listVoices();
  if (selectedId && !voices.some((v) => v.voice_id === selectedId)) {
    voices.unshift({
      voice_id: selectedId,
      name: cfg.voiceName || 'Current voice',
      description: '',
      provider: selectedId.startsWith('fish:') ? 'fish' : 'elevenlabs',
    });
  }
  render(searchEl.value || '');
}

// Saving a Fish key changes which voices exist, so refresh the list in place
// rather than making the user reopen Preferences.
if (btnFishKey) btnFishKey.addEventListener('click', async () => {
  const key = (fishKeyEl.value || '').trim();
  const r = await window.prefs.setFishKey(key);
  fishKeyEl.value = '';
  setFishState(r && r.present, r && r.serviceAvailable);
  if (fishMsgEl) {
    fishMsgEl.textContent = key
      ? (r && r.present ? 'Saved. Loading Fish Audio voices…' : 'Could not save that key.')
      : (r && r.serviceAvailable ? 'Personal key removed — using Fish Audio through your account.' : 'Fish Audio key removed.');
    fishMsgEl.classList.toggle('err', !!key && !(r && r.present));
  }
  voices = await window.prefs.listVoices();
  render(searchEl.value || '');
  if (fishMsgEl && key && r && r.present) {
    const n = voices.filter((v) => v.provider === 'fish').length;
    fishMsgEl.textContent = n ? `Saved — ${n} Fish Audio voices available.` : 'Saved, but no voices came back.';
  }
});

if (btnClearKey) btnClearKey.addEventListener('click', async () => {
  await window.prefs.setOwnKey('');
  await loadAccount();
  await refreshVoiceAccess();
});
if (btnUpgrade) btnUpgrade.addEventListener('click', () => window.prefs.openBilling());
if (btnBilling) btnBilling.addEventListener('click', () => window.prefs.openBilling());
[acctEmailEl, acctPassEl].forEach((el) => el && el.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); doAuth(window.prefs.login, 'login'); }
}));

init();
