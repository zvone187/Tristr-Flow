'use strict';

const listEl = document.getElementById('list');
const searchEl = document.getElementById('search');
const speedEl = document.getElementById('speed');
const speedValEl = document.getElementById('speedval');
const keyStateEl = document.getElementById('keystate');
const stabilityEl = document.getElementById('stability');

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
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.prefs.close();
});

init();
