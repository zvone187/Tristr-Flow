'use strict';

// In-page reader: speaks the current selection and paints a karaoke highlight
// directly over the page's real text using the CSS Custom Highlight API (so it
// follows native scrolling/reflow with no DOM mutation).

(function () {
  if (window.__speakSelectionLoaded) return;
  window.__speakSelectionLoaded = true;

  const supported = typeof Highlight !== 'undefined' && CSS && CSS.highlights;

  // playback / media
  let audio = null, mediaSource = null, sb = null;
  let appendQueue = [], allReceived = false, endedStream = false, playRequested = false;
  let raf = null, port = null, active = false;

  // alignment / words
  let charStart = [], charEnd = [], charToWord = [], words = [], currentWord = -1, timeOffset = 0;
  let selMap = null; // { text, map:[{node,offset}] }

  // highlights + UI
  let hlCur = null, hlRead = null, pill = null, statusEl = null, playBtn = null;

  function b64ToBytes(b64) {
    const bin = atob(b64), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---- selection -> text + per-character node/offset map ----------------
  function buildSelectionMap() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const rootEl = range.commonAncestorContainer.nodeType === 3
      ? range.commonAncestorContainer.parentNode
      : range.commonAncestorContainer;
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
    let text = '';
    const map = [];
    let n;
    while ((n = walker.nextNode())) {
      if (!range.intersectsNode(n)) continue;
      let s = 0, e = n.nodeValue.length;
      if (n === range.startContainer) s = range.startOffset;
      if (n === range.endContainer) e = range.endOffset;
      const str = n.nodeValue.slice(s, e);
      for (let k = 0; k < str.length; k++) { map.push({ node: n, offset: s + k }); text += str[k]; }
    }
    return text.trim() ? { text, map } : null;
  }

  function buildWords() {
    words = [];
    charToWord = new Array(selMap.text.length).fill(-1);
    const t = selMap.text;
    let i = 0;
    while (i < t.length) {
      if (/\s/.test(t[i])) { i++; continue; }
      const first = i;
      while (i < t.length && !/\s/.test(t[i])) { charToWord[i] = words.length; i++; }
      words.push({ first, last: i - 1 });
    }
  }

  function rangeForWord(wi) {
    const w = words[wi];
    if (!w) return null;
    const a = selMap.map[w.first], b = selMap.map[w.last];
    if (!a || !b) return null;
    const r = document.createRange();
    try { r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset + 1); } catch { return null; }
    return r;
  }

  // ---- alignment timing -------------------------------------------------
  function appendTimings(a) {
    const s = a.character_start_times_seconds || [], e = a.character_end_times_seconds || [];
    for (let k = 0; k < s.length; k++) { charStart.push((s[k] || 0) + timeOffset); charEnd.push((e[k] || 0) + timeOffset); }
  }

  function setHighlight(wi) {
    if (wi === currentWord || !supported) return;
    currentWord = wi;
    hlCur.clear();
    const r = rangeForWord(wi);
    if (r) hlCur.add(r);
    hlRead.clear();
    for (let k = 0; k < wi; k++) { const rr = rangeForWord(k); if (rr) hlRead.add(rr); }
  }

  function frame() {
    if (!audio) return;
    const t = audio.currentTime;
    let lo = 0, hi = charStart.length - 1, idx = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (charStart[m] <= t) { idx = m; lo = m + 1; } else hi = m - 1; }
    const wi = idx >= 0 ? charToWord[Math.min(idx, charToWord.length - 1)] : -1;
    if (wi >= 0) setHighlight(wi);
    if (audio && !audio.paused && !audio.ended) raf = requestAnimationFrame(frame);
    else raf = null;
  }

  // ---- MSE progressive playback ----------------------------------------
  function pump() {
    if (!sb || sb.updating) return;
    if (appendQueue.length) {
      const buf = appendQueue.shift();
      try { sb.appendBuffer(buf); }
      catch (e) {
        if (e && e.name === 'QuotaExceededError') {
          try { const c = audio ? audio.currentTime : 0; if (sb.buffered.length && c > 35) sb.remove(0, c - 30); } catch {}
          appendQueue.unshift(buf);
        }
      }
      return;
    }
    if (!playRequested && audio && audio.paused && audio.buffered.length && audio.buffered.end(0) > 0.05) {
      playRequested = true;
      audio.play().then(() => setStatus('Reading…')).catch(() => setStatus('Click ▶ to play'));
    }
    if (allReceived && !sb.updating && mediaSource && mediaSource.readyState === 'open' && !endedStream) {
      endedStream = true;
      try { mediaSource.endOfStream(); } catch {}
    }
  }

  function setupMedia() {
    audio = new Audio();
    mediaSource = new MediaSource();
    audio.src = URL.createObjectURL(mediaSource);
    mediaSource.addEventListener('sourceopen', () => {
      if (sb) return;
      try { sb = mediaSource.addSourceBuffer('audio/mpeg'); } catch { setStatus('Audio init failed'); return; }
      sb.addEventListener('updateend', pump);
      pump();
    });
    audio.addEventListener('playing', () => { setStatus('Reading…'); updatePlay(); if (!raf) raf = requestAnimationFrame(frame); });
    audio.addEventListener('pause', updatePlay);
    audio.addEventListener('ended', () => { setStatus('Done'); updatePlay(); });
  }

  // ---- streaming via background port -----------------------------------
  function onLine(line) {
    if (line.type === 'segment') {
      if (line.index > 0) timeOffset = charEnd.length ? charEnd[charEnd.length - 1] : timeOffset;
      return;
    }
    if (line.type === 'error') { setStatus('⚠ ' + line.message); return; }
    if (line.type === 'done') { allReceived = true; pump(); return; }
    if (line.audio) { appendQueue.push(b64ToBytes(line.audio)); pump(); }
    if (line.alignment) appendTimings(line.alignment);
  }

  function start() {
    if (active) { stop(); return; } // toggle
    const m = buildSelectionMap();
    if (!m) { flash('Select some text first'); return; }
    if (!supported) { flash('This browser lacks the CSS Highlight API'); return; }
    active = true;
    selMap = m;
    charStart = []; charEnd = []; currentWord = -1; timeOffset = 0;
    appendQueue = []; allReceived = false; endedStream = false; playRequested = false;
    buildWords();
    hlCur = new Highlight(); hlRead = new Highlight();
    CSS.highlights.set('ss-current', hlCur);
    CSS.highlights.set('ss-read', hlRead);
    setupMedia();
    showPill();
    setStatus('Preparing…');
    port = chrome.runtime.connect({ name: 'speak-tts' });
    port.onMessage.addListener((msg) => {
      if (msg.type === 'line') onLine(msg.line);
      else if (msg.type === 'end') { allReceived = true; pump(); }
      else if (msg.type === 'error') setStatus('⚠ ' + msg.message);
    });
    port.onDisconnect.addListener(() => { port = null; });
    port.postMessage({ type: 'tts', text: selMap.text });
  }

  function stop() {
    active = false;
    if (raf) cancelAnimationFrame(raf); raf = null;
    if (audio) { try { audio.pause(); } catch {} try { if (audio.src) URL.revokeObjectURL(audio.src); } catch {} audio = null; }
    mediaSource = null; sb = null; appendQueue = [];
    if (port) { try { port.disconnect(); } catch {} port = null; }
    if (CSS && CSS.highlights) { CSS.highlights.delete('ss-current'); CSS.highlights.delete('ss-read'); }
    hidePill();
  }

  function togglePause() {
    if (!audio) return;
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
    updatePlay();
  }

  // ---- minimal control pill --------------------------------------------
  function showPill() {
    if (pill) return;
    pill = document.createElement('div');
    pill.id = 'ss-pill';
    playBtn = document.createElement('button'); playBtn.textContent = '❚❚'; playBtn.title = 'Play / Pause';
    playBtn.addEventListener('click', togglePause);
    const stopBtn = document.createElement('button'); stopBtn.textContent = '✕'; stopBtn.title = 'Stop (Esc)';
    stopBtn.addEventListener('click', stop);
    statusEl = document.createElement('span'); statusEl.className = 'ss-status'; statusEl.textContent = 'Preparing…';
    pill.appendChild(playBtn); pill.appendChild(statusEl); pill.appendChild(stopBtn);
    document.documentElement.appendChild(pill);
  }
  function hidePill() { if (pill) { pill.remove(); pill = null; statusEl = null; playBtn = null; } }
  function setStatus(s) { if (statusEl) statusEl.textContent = s; }
  function updatePlay() { if (playBtn) playBtn.textContent = audio && !audio.paused ? '❚❚' : '▶'; }
  function flash(msg) { showPill(); setStatus(msg); setTimeout(() => { if (!active) hidePill(); }, 1600); }

  chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === 'speak-start') start(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && active) stop(); }, true);
})();
