'use strict';

const card = document.getElementById('card');
const textEl = document.getElementById('text');
const wrapEl = document.getElementById('textwrap');
const statusEl = document.getElementById('status');
const voiceEl = document.getElementById('voice');
const dotEl = document.getElementById('dot');
const fillEl = document.getElementById('bar-fill');
const closeBtn = document.getElementById('close');
const playBtn = document.getElementById('playpause');

// ---- media (MediaSource progressive MP3 playback) -----------------------
let audio = null;
let mediaSource = null;
let sb = null;
const appendQueue = [];
let allReceived = false;
let endedStream = false;
let playRequested = false;
let raf = null;

// ---- karaoke / alignment state ------------------------------------------
let charStart = []; // absolute seconds, accumulated across chunks/segments
let charEnd = [];
let charToWord = []; // char index -> word index (-1 for whitespace)
let words = []; // { el, first, last, sent }
let currentWord = -1;
let currentSentence = -1;
let curSentIdx = 0; // sentence counter while building words
let sentStartWord = 0; // first word index of the sentence being built
let timeOffset = 0; // added to a segment's relative timestamps (multi-request)
let richMode = false; // true when formatted (HTML) text was rendered up-front
let loadGen = 0; // gen id from main, echoed back in richReady
// incremental word builder
let curWordEl = null;
let curWordFirst = -1;
let curWordLast = -1;
let pendingWS = '';

function setStatus(s) { statusEl.textContent = s; }

function b64ToBytes(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- teardown / reset ----------------------------------------------------
function teardown() {
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  if (audio) {
    try { audio.pause(); } catch {}
    try { if (audio.src) URL.revokeObjectURL(audio.src); } catch {}
    audio.removeAttribute('src');
    audio = null;
  }
  mediaSource = null;
  sb = null;
  appendQueue.length = 0;
  allReceived = false;
  endedStream = false;
  playRequested = false;
  charStart = [];
  charEnd = [];
  charToWord = [];
  words = [];
  currentWord = -1;
  currentSentence = -1;
  curSentIdx = 0;
  sentStartWord = 0;
  timeOffset = 0;
  richMode = false;
  curWordEl = null;
  curWordFirst = -1;
  curWordLast = -1;
  pendingWS = '';
}

function resetForNew(voice) {
  teardown();
  card.classList.remove('error');
  textEl.innerHTML = '';
  fillEl.style.width = '0%';
  wrapEl.scrollTop = 0;
  if (voice) voiceEl.textContent = voice;
  setStatus('Preparing voice…');
  dotEl.classList.add('live');
  updatePlayBtn();

  audio = new Audio();
  mediaSource = new MediaSource();
  audio.src = URL.createObjectURL(mediaSource);

  mediaSource.addEventListener('sourceopen', () => {
    if (sb) return;
    try {
      sb = mediaSource.addSourceBuffer('audio/mpeg');
    } catch (e) {
      showError('Audio init failed: ' + e.message);
      return;
    }
    sb.addEventListener('updateend', pump);
    pump();
  });

  audio.addEventListener('playing', () => {
    dotEl.classList.add('live');
    setStatus('Reading aloud…');
    if (window.speak) window.speak.started();
    startRaf();
    updatePlayBtn();
  });
  audio.addEventListener('pause', () => { updatePlayBtn(); });
  audio.addEventListener('ended', onPlaybackEnded);
}

// ---- MSE append queue ----------------------------------------------------
function pump() {
  if (!sb || sb.updating) return;
  if (appendQueue.length) {
    const buf = appendQueue.shift();
    try {
      sb.appendBuffer(buf);
    } catch (e) {
      if (e && e.name === 'QuotaExceededError') {
        // Evict already-played audio to make room for very long readings.
        try {
          const cur = audio ? audio.currentTime : 0;
          if (sb.buffered.length && cur > 35) sb.remove(0, cur - 30);
        } catch {}
        appendQueue.unshift(buf); // retry after the remove's updateend
      }
    }
    return;
  }
  // start playback as soon as we have anything buffered
  if (!playRequested && audio && audio.paused && audio.buffered.length && audio.buffered.end(0) > 0.05) {
    playRequested = true;
    audio.play().catch(() => {});
  }
  // finalize the stream once everything is appended
  if (allReceived && !sb.updating && mediaSource && mediaSource.readyState === 'open' && !endedStream) {
    endedStream = true;
    try { mediaSource.endOfStream(); } catch {}
  }
}

// ---- incremental alignment -> word DOM ----------------------------------
function endsSentence(text) {
  return /[.!?…]["'”’)\]]?$/.test(text);
}

function flushWord() {
  if (curWordEl) {
    const w = { el: curWordEl, first: curWordFirst, last: curWordLast, sent: curSentIdx };
    words.push(w);
    // Highlight this word as part of the sentence if it's the active one (streaming).
    if (w.sent === currentSentence) curWordEl.classList.add('cur-sent');
    if (endsSentence(curWordEl.textContent)) curSentIdx++; // next word begins a new sentence
    curWordEl = null;
    curWordFirst = -1;
    curWordLast = -1;
  }
}

// Rich mode: words + charToWord are pre-built from the HTML, so streamed
// alignment only fills in the per-character timings (same canonical index space).
function appendAlignmentTimings(a) {
  const s = a.character_start_times_seconds || [];
  const e = a.character_end_times_seconds || [];
  for (let k = 0; k < s.length; k++) {
    charStart.push((s[k] || 0) + timeOffset);
    charEnd.push((e[k] || 0) + timeOffset);
  }
}

function appendAlignment(a) {
  const chars = a.characters || [];
  const s = a.character_start_times_seconds || [];
  const e = a.character_end_times_seconds || [];
  for (let k = 0; k < chars.length; k++) {
    const idx = charStart.length;
    charStart.push((s[k] || 0) + timeOffset);
    charEnd.push((e[k] || 0) + timeOffset);
    const ch = chars[k];
    if (/\s/.test(ch)) {
      charToWord[idx] = -1;
      flushWord();
      pendingWS += ch;
    } else {
      if (pendingWS) { textEl.appendChild(document.createTextNode(pendingWS)); pendingWS = ''; }
      if (!curWordEl) {
        curWordEl = document.createElement('span');
        curWordEl.className = 'word';
        curWordFirst = idx;
        textEl.appendChild(curWordEl);
      }
      curWordEl.textContent += ch;
      curWordLast = idx;
      charToWord[idx] = words.length; // index this word will get on flush
    }
  }
}

// ---- highlight loop (binary search => robust to seeks) -------------------
function startRaf() {
  if (raf) cancelAnimationFrame(raf);
  raf = requestAnimationFrame(frame);
}

function frame() {
  if (!audio) return;
  const t = audio.currentTime;
  // largest i with charStart[i] <= t
  let lo = 0, hi = charStart.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (charStart[mid] <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const wi = idx >= 0 ? charToWord[idx] : -1;
  if (wi >= 0 && wi !== currentWord) setActive(wi);

  const dur = charEnd.length ? charEnd[charEnd.length - 1] : (audio.duration || 0);
  if (dur && isFinite(dur)) fillEl.style.width = Math.min(100, (t / dur) * 100) + '%';

  if (!audio.paused && !audio.ended) raf = requestAnimationFrame(frame);
  else raf = null;
}

// Medium-style: the current sentence gets a soft highlight, the current word the
// strong one on top. Moving forward/back just moves both highlights.
function setActive(wi) {
  if (!words[wi]) return;
  if (currentWord >= 0 && words[currentWord]) words[currentWord].el.classList.remove('active');

  const si = words[wi].sent;
  if (si !== currentSentence) {
    for (const w of words) {
      if (w.sent === currentSentence) w.el.classList.remove('cur-sent');
      if (w.sent === si) w.el.classList.add('cur-sent');
    }
    currentSentence = si;
  }
  words[wi].el.classList.add('active');
  scrollToWord(words[wi].el);
  currentWord = wi;
}

function scrollToWord(el) {
  const target = el.offsetTop - wrapEl.clientHeight / 2 + el.offsetHeight / 2;
  wrapEl.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
}

// ---- click-to-seek -------------------------------------------------------
function bufferedEnd() {
  return audio && audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0;
}

textEl.addEventListener('click', (e) => {
  const w = e.target.closest('.word');
  if (!w || !audio) return;
  const wi = words.findIndex((x) => x.el === w);
  if (wi < 0) return;
  const t = charStart[words[wi].first]; // timing for this word's first char
  if (t == null || t > bufferedEnd() - 0.05) { flashStatus('Not generated yet…'); return; }
  audio.currentTime = Math.max(0, t);
  currentWord = -1; // force re-highlight from the new position
  if (audio.paused) audio.play().catch(() => {});
  startRaf();
});

let flashTimer = null;
function flashStatus(msg) {
  setStatus(msg);
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { if (audio && !audio.paused) setStatus('Reading aloud…'); }, 1400);
}

// ---- pause / play --------------------------------------------------------
function togglePause() {
  if (!audio) return;
  if (audio.paused) { audio.play().catch(() => {}); }
  else { audio.pause(); }
  updatePlayBtn();
}

function updatePlayBtn() {
  if (!audio || audio.paused) { playBtn.textContent = '▶'; playBtn.title = 'Play (Space)'; dotEl.classList.remove('live'); }
  else { playBtn.textContent = '❚❚'; playBtn.title = 'Pause (Space)'; dotEl.classList.add('live'); }
}

function onPlaybackEnded() {
  fillEl.style.width = '100%';
  setStatus('Finished — click any word to replay');
  dotEl.classList.remove('live');
  updatePlayBtn();
  if (window.speak) window.speak.ended();
}

function showError(message) {
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  card.classList.add('error');
  textEl.textContent = '⚠️  ' + message;
  setStatus('Error');
  dotEl.classList.remove('live');
}

// ---- wiring --------------------------------------------------------------
playBtn.addEventListener('click', togglePause);
closeBtn.addEventListener('click', () => { teardown(); if (window.speak) window.speak.close(); });

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); togglePause(); }
  else if (e.key === 'Escape') { teardown(); if (window.speak) window.speak.close(); }
});

if (window.speak) {
  window.speak.onLoading(({ gen, voice, html, fontSize }) => {
    resetForNew(voice);
    loadGen = gen || 0;
    if (fontSize) textEl.style.fontSize = fontSize + 'px';
    if (html && window.SpeakRich) {
      let built = null;
      try { built = window.SpeakRich.build(html); } catch { built = null; }
      if (built && built.text && built.text.trim()) {
        richMode = true;
        words = built.words;
        charToWord = built.charToWord; // full canonical index space, pre-built
        // assign sentence index to each pre-built word
        let sIdx = 0;
        for (const w of words) { w.sent = sIdx; if (endsSentence(w.el.textContent)) sIdx++; }
        textEl.appendChild(built.fragment);
        window.speak.richReady(loadGen, built.text, true);
        return;
      }
    }
    // plain mode: words/timings are built incrementally from the stream
    if (html) window.speak.richReady(loadGen, null, false);
  });

  window.speak.onSegment(({ index }) => {
    // New request segment: continue the same audio timeline. Offset this
    // segment's (relative) timestamps by the audio generated so far.
    if (index > 0) {
      flushWord();
      timeOffset = Math.max(bufferedEnd(), charEnd.length ? charEnd[charEnd.length - 1] : 0);
    }
  });

  window.speak.onChunk(({ audioBase64, alignment }) => {
    if (audioBase64) { appendQueue.push(b64ToBytes(audioBase64)); pump(); }
    if (alignment) { if (richMode) appendAlignmentTimings(alignment); else appendAlignment(alignment); }
  });

  window.speak.onAllDone(() => { flushWord(); allReceived = true; pump(); });

  window.speak.onError(({ message }) => showError(message));

  window.speak.onFontSize(({ fontSize }) => { if (fontSize) textEl.style.fontSize = fontSize + 'px'; });

  window.speak.onStop(() => { teardown(); });
}
