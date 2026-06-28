'use strict';

const listEl = document.getElementById('list');
const searchEl = document.getElementById('search');
const speedEl = document.getElementById('speed');
const speedValEl = document.getElementById('speedval');
const keyStateEl = document.getElementById('keystate');
const stabilityEl = document.getElementById('stability');
const pauseMusicEl = document.getElementById('pausemusic');
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
  let word = 'Normal';
  if (n <= 0.75) word = 'Slowest';
  else if (n < 0.95) word = 'Slower';
  else if (n <= 1.05) word = 'Normal';
  else if (n < 1.2) word = 'Faster';
  else word = 'Fastest';
  return `${n.toFixed(2)}× · ${word}`;
}

function setActiveStability(val) {
  stabilityEl.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', Math.abs(Number(b.dataset.val) - Number(val)) < 0.001);
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
  const shown = voices.filter(
    (v) =>
      !f ||
      v.name.toLowerCase().includes(f) ||
      (v.description || '').toLowerCase().includes(f)
  );
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
    }
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
  if (pauseMusicEl) pauseMusicEl.checked = cfg.pauseMusic !== false;
  setActiveStability(cfg.stability);
  speedEl.value = cfg.speed;
  speedValEl.textContent = speedLabel(cfg.speed);
  if (cfg.speedSupported === false) {
    speedEl.disabled = true;
    speedValEl.textContent = 'Not supported by Eleven v3';
    document.getElementById('speedrow').classList.add('disabled');
  }
  if (cfg.apiKeyPresent) {
    keyStateEl.textContent = '✓ ElevenLabs connected';
  } else {
    keyStateEl.textContent = '⚠ No API key';
    keyStateEl.classList.add('warn');
  }

  voices = await window.prefs.listVoices();
  // Make sure the currently-selected voice is visible even if not curated.
  if (selectedId && !voices.some((v) => v.voice_id === selectedId)) {
    voices.unshift({
      voice_id: selectedId,
      name: cfg.voiceName || 'Current voice',
      description: '',
    });
  }
  render('');
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

searchEl.addEventListener('input', () => render(searchEl.value));

if (pauseMusicEl) {
  pauseMusicEl.addEventListener('change', () => window.prefs.setPauseMusic(pauseMusicEl.checked));
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
  b.addEventListener('click', () => startRecording(Number(b.dataset.which)))
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

init();
