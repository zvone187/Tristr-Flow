'use strict';

const card = document.getElementById('card');
const textEl = document.getElementById('text');
const wrapEl = document.getElementById('textwrap');
const statusEl = document.getElementById('status');
const voiceEl = document.getElementById('voice');
const dotEl = document.getElementById('dot');
const fillEl = document.getElementById('bar-fill');
const tcurEl = document.getElementById('tcur');
const tdurEl = document.getElementById('tdur');
const closeBtn = document.getElementById('close');
const playBtn = document.getElementById('playpause');
const settingsBtn = document.getElementById('settings');
const speedValEl = document.getElementById('speedval');
const speedDownBtn = document.getElementById('speeddown');
const speedUpBtn = document.getElementById('speedup');

// Discrete speed steps for the overlay's ‹ 1× › control.
const SPEED_STEPS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];
function fmtSpeed(v) {
  return (Math.round(v * 100) / 100).toString().replace(/\.0+$/, '') + '×';
}

// ---- media (MediaSource progressive MP3 playback) -----------------------
let audio = null;
let mediaSource = null;
let sb = null;
const appendQueue = [];
let allReceived = false;
let endedStream = false;
let playRequested = false;
let raf = null;
let playbackSpeed = 1; // client-side playback rate (works on every model)
let following = true; // auto-scroll follows the current word; paused while the user scrolls
let followResumeTimer = null;

// ---- karaoke / alignment state ------------------------------------------
let charStart = []; // absolute seconds, accumulated across chunks/segments
let charEnd = [];
let charToWord = []; // char index -> word index (-1 for whitespace)
let words = []; // { el, first, last, sent }
let sentences = []; // [{ first, last }] word indices
let currentWord = -1;
let currentSentence = -1;
let curSentIdx = 0; // sentence counter while building words
let timeOffset = 0; // added to a segment's relative timestamps (multi-request)

// Continuous highlight via the CSS Custom Highlight API (one range per sentence,
// one for the word) — no per-word boxes, so the sentence reads as one block.
const hlSupported = typeof Highlight !== 'undefined' && typeof CSS !== 'undefined' && CSS.highlights;
let hlSentence = null;
let hlWord = null;
if (hlSupported) {
  hlSentence = new Highlight();
  hlWord = new Highlight();
  hlWord.priority = 1; // word paints on top of the sentence
  CSS.highlights.set('ov-sentence', hlSentence);
  CSS.highlights.set('ov-word', hlWord);
}
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
  sentences = [];
  currentWord = -1;
  currentSentence = -1;
  curSentIdx = 0;
  timeOffset = 0;
  richMode = false;
  following = true;
  if (followResumeTimer) { clearTimeout(followResumeTimer); followResumeTimer = null; }
  if (hlSupported) { hlSentence.clear(); hlWord.clear(); }
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
  if (tcurEl) tcurEl.textContent = '0:00';
  if (tdurEl) tdurEl.textContent = '0:00';
  wrapEl.scrollTop = 0;
  if (voice) voiceEl.textContent = voice;
  setStatus('Preparing voice…');
  dotEl.classList.add('live');
  updatePlayBtn();

  audio = new Audio();
  audio.addEventListener('timeupdate', updateTimes);   // live during playback + after seeks
  audio.addEventListener('durationchange', updateTimes); // total grows as the stream buffers
  audio.preservesPitch = true; // speed up without chipmunk pitch
  // defaultPlaybackRate survives the load (assigning src resets playbackRate to it)
  audio.defaultPlaybackRate = playbackSpeed;
  audio.playbackRate = playbackSpeed;
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
    if (audio.playbackRate !== playbackSpeed) audio.playbackRate = playbackSpeed;
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
    const wi = words.length;
    const w = { el: curWordEl, first: curWordFirst, last: curWordLast, sent: curSentIdx };
    words.push(w);
    if (!sentences[w.sent]) sentences[w.sent] = { first: wi, last: wi };
    else sentences[w.sent].last = wi;
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

function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function totalDur() {
  if (charEnd.length) return charEnd[charEnd.length - 1];
  if (audio && isFinite(audio.duration)) return audio.duration;
  return bufferedEnd();
}
function updateTimes() {
  if (tcurEl) tcurEl.textContent = fmtTime(audio ? audio.currentTime : 0);
  if (tdurEl) tdurEl.textContent = fmtTime(totalDur());
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
  updateTimes();

  if (!audio.paused && !audio.ended) raf = requestAnimationFrame(frame);
  else raf = null;
}

function rangeOfEl(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  return r;
}
// Continuous range from the first word to the last word of a sentence (includes
// the spaces between them, so it paints as one block).
function rangeSpan(firstIdx, lastIdx) {
  const a = words[firstIdx] && words[firstIdx].el;
  const b = words[lastIdx] && words[lastIdx].el;
  if (!a || !b) return null;
  const r = document.createRange();
  try { r.setStartBefore(a); r.setEndAfter(b); } catch { return null; }
  return r;
}

// Medium-style: the current sentence gets one soft, continuous highlight; the
// current word a strong one on top.
function setActive(wi) {
  if (!words[wi]) return;
  if (!hlSupported) {
    if (currentWord >= 0 && words[currentWord]) words[currentWord].el.classList.remove('active');
    words[wi].el.classList.add('active');
    currentWord = wi;
    scrollToWord(words[wi].el);
    return;
  }
  hlWord.clear();
  hlWord.add(rangeOfEl(words[wi].el));
  const si = words[wi].sent;
  const sent = sentences[si];
  if (sent) {
    hlSentence.clear();
    const sr = rangeSpan(sent.first, sent.last); // recomputed: grows as words stream in
    if (sr) hlSentence.add(sr);
  }
  if (wi !== currentWord) scrollToWord(words[wi].el);
  currentWord = wi;
  currentSentence = si;
}

// Pause auto-follow while the user is scrolling; resume after they settle.
function pauseFollow() {
  following = false;
  if (followResumeTimer) clearTimeout(followResumeTimer);
  followResumeTimer = setTimeout(() => { following = true; }, 4000);
}
function resumeFollow() {
  if (followResumeTimer) { clearTimeout(followResumeTimer); followResumeTimer = null; }
  following = true;
}

function scrollToWord(el) {
  if (!following) return; // don't fight a user who's scrolling/reading elsewhere
  const wr = wrapEl.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  const margin = wr.height * 0.2;
  // already in the comfortable middle band — leave the scroll where it is
  if (er.top >= wr.top + margin && er.bottom <= wr.bottom - margin) return;
  const delta = er.top - wr.top - wr.height / 2 + er.height / 2;
  wrapEl.scrollTo({ top: wrapEl.scrollTop + delta, behavior: 'smooth' });
}

wrapEl.addEventListener('wheel', pauseFollow, { passive: true });
wrapEl.addEventListener('touchmove', pauseFollow, { passive: true });

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
  resumeFollow(); // clicking a word means "follow from here"
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
  if (!audio || audio.paused) { playBtn.textContent = '▶︎'; playBtn.title = 'Play (Space)'; dotEl.classList.remove('live'); }
  else { playBtn.textContent = '❚❚'; playBtn.title = 'Pause (Space)'; dotEl.classList.add('live'); }
}

// ---- speed ---------------------------------------------------------------
function renderSpeed() {
  if (speedValEl) speedValEl.textContent = fmtSpeed(playbackSpeed);
}
function applySpeed(v) {
  playbackSpeed = Math.min(2.5, Math.max(0.75, v));
  if (audio) { audio.defaultPlaybackRate = playbackSpeed; audio.playbackRate = playbackSpeed; }
  renderSpeed();
  if (window.speak && window.speak.setSpeed) window.speak.setSpeed(playbackSpeed); // persist + sync Preferences
}
function stepSpeed(dir) {
  let idx = 0, best = Infinity;
  SPEED_STEPS.forEach((s, i) => { const d = Math.abs(s - playbackSpeed); if (d < best) { best = d; idx = i; } });
  idx = Math.min(SPEED_STEPS.length - 1, Math.max(0, idx + dir));
  applySpeed(SPEED_STEPS[idx]);
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
settingsBtn.addEventListener('click', () => { if (window.speak && window.speak.openSettings) window.speak.openSettings(); });
if (speedDownBtn) speedDownBtn.addEventListener('click', () => stepSpeed(-1));
if (speedUpBtn) speedUpBtn.addEventListener('click', () => stepSpeed(1));

const SCROLL_KEYS = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'];
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); togglePause(); }
  else if (e.key === 'Escape') { teardown(); if (window.speak) window.speak.close(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); stepSpeed(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); stepSpeed(1); }
  else if (SCROLL_KEYS.includes(e.key)) { pauseFollow(); } // user is scrolling with the keyboard
});

if (window.speak) {
  window.speak.onLoading(({ gen, voice, html, fontSize, speed }) => {
    if (speed) playbackSpeed = speed;
    renderSpeed();
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
        // assign sentence index + ranges to each pre-built word
        let sIdx = 0;
        for (let i = 0; i < words.length; i++) {
          const w = words[i];
          w.sent = sIdx;
          if (!sentences[sIdx]) sentences[sIdx] = { first: i, last: i };
          else sentences[sIdx].last = i;
          if (endsSentence(w.el.textContent)) sIdx++;
        }
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

  window.speak.onSpeed(({ speed }) => { if (speed) { playbackSpeed = speed; if (audio) { audio.defaultPlaybackRate = speed; audio.playbackRate = speed; } renderSpeed(); } });

  window.speak.onStop(() => { teardown(); });
}
