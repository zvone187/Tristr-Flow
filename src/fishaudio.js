'use strict';

const https = require('https');
const http = require('http');

// Fish Audio provider (https://api.fish.audio).
//
// Two endpoints are used:
//   POST /v1/tts                        -> raw audio, for one-shot voice previews
//   POST /v1/tts/stream/with-timestamp  -> Server-Sent Events carrying audio AND
//                                          real word timings as it generates
//
// The streaming route is what reading uses: audio starts within ~200ms and the
// karaoke highlight runs on measured word spans rather than an estimate. Fish
// reports words without their punctuation, so CharTimeline converts word spans
// into the per-character alignment the renderer indexes by, giving callers the
// same shape ElevenLabs returns:
//
//   { characters, character_start_times_seconds, character_end_times_seconds }
//
// so nothing downstream needs to know which provider produced a segment.

const HOST = 'api.fish.audio';
// Overridable so the streaming path can be exercised against a local test
// double (the live endpoint needs API credit). Never set in normal use.
const BASE = process.env.FISH_API_BASE || '';
const DEFAULT_MODEL = 's1'; // backbone; also 's2.1-pro', 's2-pro'
const VOICE_PREFIX = 'fish:';

// Our voice ids are namespaced so a saved id always says which provider owns
// it — ElevenLabs ids stay bare, so existing settings keep working.
function isFishVoice(voiceId) {
  return typeof voiceId === 'string' && voiceId.startsWith(VOICE_PREFIX);
}
function fishVoiceId(voiceId) {
  return isFishVoice(voiceId) ? voiceId.slice(VOICE_PREFIX.length) : voiceId;
}

// ---- MP3 duration --------------------------------------------------------
// Walks the frame headers and sums each frame's real duration. Works for CBR
// and VBR alike, and needs no decoding.
const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const RATES = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000],  // MPEG2.5
};

// Parse the frame header at `i`, or null if that is not a valid Layer III frame.
function frameAt(buf, i) {
  if (i + 4 > buf.length) return null;
  if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) return null;
  const verBits = (buf[i + 1] >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layer = (buf[i + 1] >> 1) & 0x03;   // 1 = Layer III
  const brIdx = (buf[i + 2] >> 4) & 0x0f;
  const srIdx = (buf[i + 2] >> 2) & 0x03;
  const pad = (buf[i + 2] >> 1) & 0x01;
  if (verBits === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3 || !RATES[verBits]) return null;
  const bitrate = (verBits === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3)[brIdx] * 1000;
  const rate = RATES[verBits][srIdx];
  if (!bitrate || !rate) return null;
  const samples = verBits === 3 ? 1152 : 576;
  const len = Math.floor((samples / 8) * bitrate / rate) + pad;
  return len < 4 ? null : { len, samples, rate };
}

function id3End(buf) {
  if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    return 10 + ((buf[6] & 0x7f) << 21 | (buf[7] & 0x7f) << 14 | (buf[8] & 0x7f) << 7 | (buf[9] & 0x7f));
  }
  return 0;
}

// Strip the ID3v2 tag and the leading Xing/Info metadata frame, leaving pure
// audio frames that can be concatenated with another chunk's output.
//
// Both matter. The ID3 tag is not audio, and the Xing frame is a silent header
// carrying a frame COUNT — leave it in and a decoder believes the whole stream
// is only as long as the first chunk (verified: afinfo reported 2.19s for a 7s
// concatenation until it was stripped).
function stripMp3Container(buf) {
  if (!buf || buf.length < 4) return buf || Buffer.alloc(0);
  let i = id3End(buf);
  while (i + 4 <= buf.length && !frameAt(buf, i)) i++; // find first real frame
  const f = frameAt(buf, i);
  if (f) {
    const tag = buf.slice(i, i + f.len).toString('latin1');
    if (tag.includes('Xing') || tag.includes('Info')) i += f.len; // metadata, not audio
  }
  return buf.slice(i);
}

// Exact playback duration: the sum of every audio frame's own duration. Works
// for CBR and VBR, needs no decoding, and (with the Xing frame excluded) matches
// what the system decoder reports to the millisecond.
function mp3Duration(buf) {
  if (!buf || buf.length < 4) return 0;
  const audio = stripMp3Container(buf);
  let i = 0;
  let seconds = 0;
  while (i + 4 <= audio.length) {
    const f = frameAt(audio, i);
    if (!f) { i++; continue; } // resync
    seconds += f.samples / f.rate;
    i += f.len;
  }
  return seconds;
}

// ---- synthetic alignment -------------------------------------------------
// Relative "how long does this character take to say" weights. Speech spends
// almost no time on a space and a real beat on a full stop, so a flat spread
// drifts badly; this keeps the highlight sitting on the right word.
// Weights fitted against real ElevenLabs per-character timings over four sample
// texts (prose, numbers, choppy punctuation, one long unpunctuated run), then
// leave-one-out validated: mean error 0.32s -> 0.21s, and no held-out sample
// regressed. A space outweighing a letter is not a typo — word boundaries carry
// real duration while letters inside a word are rattled off fast.
function charWeight(ch, next) {
  if (ch === '\n') return 8;
  if (/\s/.test(ch)) return 1.3;
  if (/[.!?…]/.test(ch)) return next && !/\s/.test(next) ? 1 : 8; // not a decimal point
  if (/[,;:]/.test(ch)) return 8;
  if (/[-—–"'\u201c\u201d\u2018\u2019()[\]]/.test(ch)) return 0.8;
  if (/[0-9]/.test(ch)) return 5; // digits are spoken as whole words
  return 1;
}

// Builds an ElevenLabs-shaped alignment for `text` spread over `duration`.
function buildAlignment(text, duration) {
  // One entry per UTF-16 code unit, NOT per code point. richtext.js builds its
  // canonical index space with `st.charToWord[st.canonical.length]`, which is a
  // UTF-16 length — so a code-point count would slide every character after the
  // first emoji and drag the highlight out of sync for the rest of the text.
  const chars = new Array(text.length);
  for (let k = 0; k < text.length; k++) chars[k] = text[k];
  const n = chars.length;
  const starts = new Array(n);
  const ends = new Array(n);
  if (!n) return { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] };

  const w = new Array(n);
  let total = 0;
  for (let k = 0; k < n; k++) {
    w[k] = charWeight(chars[k], chars[k + 1]);
    total += w[k];
  }
  const dur = duration > 0 ? duration : n * 0.06; // fallback if the MP3 was unreadable
  const scale = total > 0 ? dur / total : 0;

  let acc = 0;
  for (let k = 0; k < n; k++) {
    starts[k] = acc * scale;
    acc += w[k];
    ends[k] = acc * scale;
  }
  return {
    characters: chars,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  };
}

// Fish returns JSON errors; surface the message rather than a wall of payload,
// and translate the ones a user can actually act on.
function fishError(status, body) {
  let msg = '';
  try { msg = (JSON.parse(body) || {}).message || ''; } catch { msg = ''; }
  if (status === 402) {
    return new Error(
      'Fish Audio has no API credit. Add funds at fish.audio/app/developers ' +
      '(API credit is separate from platform credit), or pick an ElevenLabs voice.'
    );
  }
  if (status === 401 || status === 403) return new Error('Fish Audio rejected the API key.');
  return new Error(`Fish Audio ${status}: ${msg || String(body).slice(0, 160)}`);
}

// ---- voice library -------------------------------------------------------
function apiGet(apiKey, path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { method: 'GET', hostname: HOST, path, headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } },
      (res) => {
        let d = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Fish Audio ${res.statusCode}: ${d.slice(0, 200)}`));
          }
          try { resolve(JSON.parse(d)); } catch { reject(new Error('Bad JSON from Fish Audio.')); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Fish Audio request timed out.')));
    req.end();
  });
}

// Fish Audio's own catalogue of production voices ("Fish Official"). These are
// the defaults the platform ships — clean narration/conversational voices —
// rather than the community library, which is mostly character and meme voices.
const FISH_OFFICIAL_AUTHOR = 'd8b0991f96b44e489422ca2ddf0bd31d';

function toVoice(it, tag) {
  return {
    voice_id: VOICE_PREFIX + it._id,
    name: it.title || 'Untitled voice',
    description: (it.description || (it.tags || []).join(', ') || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    provider: 'fish',
    ...(tag ? { tag } : {}),
  };
}

function usable(it) {
  return it && it.state === 'trained' && it.type === 'tts';
}

// The user's own cloned/custom voices first, then Fish's official defaults.
// Falls back to the popular community library only if the official list is
// unavailable, so the picker is never empty when the key works.
async function listFishVoices(apiKey, { language = 'en' } = {}) {
  if (!apiKey) return [];

  const [mine, official] = await Promise.all([
    apiGet(apiKey, '/model?page_size=30&self=true').catch(() => null),
    apiGet(
      apiKey,
      `/model?page_size=100&author_id=${FISH_OFFICIAL_AUTHOR}&sort_by=task_count` +
        (language ? `&language=${encodeURIComponent(language)}` : '')
    ).catch(() => null),
  ]);

  const out = [];
  const seen = new Set();
  const add = (it, tag) => {
    if (!usable(it) || seen.has(it._id)) return;
    seen.add(it._id);
    out.push(toVoice(it, tag));
  };

  for (const it of (mine && mine.items) || []) add(it, 'custom');
  for (const it of (official && official.items) || []) add(it);

  if (!out.length) {
    const pop = await apiGet(
      apiKey,
      `/model?page_size=60&page_number=1&sort_by=task_count${language ? `&language=${encodeURIComponent(language)}` : ''}`
    ).catch(() => null);
    for (const it of (pop && pop.items) || []) add(it);
  }
  return out;
}

// ---- synthesis -----------------------------------------------------------
function ttsRequest({ apiKey, voiceId, modelId, text, temperature, topP, path }, onResponse, onError) {
  const payload = JSON.stringify({
    text,
    reference_id: fishVoiceId(voiceId),
    format: 'mp3',
    mp3_bitrate: 128,
    ...(typeof temperature === 'number' ? { temperature } : {}),
    ...(typeof topP === 'number' ? { top_p: topP } : {}),
  });
  const route = path || '/v1/tts';
  const target = BASE ? new URL(route, BASE) : null;
  const transport = target && target.protocol === 'http:' ? http : https;
  const req = transport.request(
    {
      method: 'POST',
      hostname: target ? target.hostname : HOST,
      ...(target && target.port ? { port: target.port } : {}),
      path: route,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        model: modelId || DEFAULT_MODEL,
        'Content-Length': Buffer.byteLength(payload),
      },
    },
    onResponse
  );
  req.on('error', onError);
  req.setTimeout(120000, () => req.destroy(new Error('Fish Audio request timed out.')));
  req.write(payload);
  req.end();
  return req;
}

// One-shot synthesis (used for voice previews). Resolves with the same shape as
// the ElevenLabs helper so callers can stay provider-agnostic.
function synthesizeFish({ apiKey, voiceId, modelId, text }) {
  return new Promise((resolve, reject) => {
    if (!apiKey) return reject(new Error('No Fish Audio API key configured.'));
    if (!text || !text.trim()) return reject(new Error('Nothing to speak.'));

    ttsRequest(
      { apiKey, voiceId, modelId, text },
      (res) => {
        const parts = [];
        res.on('data', (d) => parts.push(d));
        res.on('end', () => {
          const buf = Buffer.concat(parts);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(fishError(res.statusCode, buf.toString('utf8')));
          }
          resolve({
            audio_base64: buf.toString('base64'),
            alignment: buildAlignment(text, mp3Duration(buf)),
          });
        });
        res.on('error', reject);
      },
      reject
    );
  });
}

// ---- progressive streaming ----------------------------------------------
// Fish's /v1/tts/stream/with-timestamp is a Server-Sent Events stream carrying
// BOTH the audio and real word timings as generation proceeds, so audio starts
// almost immediately and the highlight uses measured times rather than an
// estimate. Events look like:
//
//   {audio_base64, content, chunk_seq, chunk_audio_offset_sec,
//    alignment: {segments:[{text,start,end}], audio_duration} | null}
//
// `segments` is CUMULATIVE for the current chunk_seq and grows event by event;
// times are relative to that chunk, offset by chunk_audio_offset_sec.
const STREAM_PATH = '/v1/tts/stream/with-timestamp';

// Fish reports words without the punctuation attached to them, so the timeline
// converts word spans into the per-character times the renderer indexes by:
// characters inside a word are spread across its span, and the characters
// between words (spaces, commas, full stops) fill the gap to the next word.
function CharTimeline(text) {
  this.text = text;
  this.cursor = 0;  // first character with no time yet
  this.lastEnd = 0; // absolute end of the last word committed
}

// Assign times for `words` (absolute seconds, in order) and return an
// ElevenLabs-shaped alignment for exactly the characters newly covered.
CharTimeline.prototype.commit = function (words) {
  const chars = [];
  const starts = [];
  const ends = [];
  for (const w of words) {
    const at = w.text ? this.text.indexOf(w.text, this.cursor) : -1;
    if (at < 0) continue; // never seen in the text (normalised away) — skip it
    // Reported spans can overlap slightly, most often across a chunk seam
    // (measured: an 80ms backstep on a 61s read). The renderer binary-searches
    // these arrays, so they have to be non-decreasing or it lands on the wrong
    // character; clamp rather than trust the wire.
    if (w.start < this.lastEnd) w.start = this.lastEnd;
    if (w.end < w.start) w.end = w.start;
    // Characters between the previous word and this one: the gap belongs to them.
    for (let k = this.cursor; k < at; k++) {
      const f = (k - this.cursor) / Math.max(1, at - this.cursor);
      chars.push(this.text[k]);
      starts.push(this.lastEnd + (w.start - this.lastEnd) * f);
      ends.push(this.lastEnd + (w.start - this.lastEnd) * ((k - this.cursor + 1) / Math.max(1, at - this.cursor)));
    }
    // Characters of the word itself, spread evenly across its span.
    const n = w.text.length;
    const span = Math.max(0, w.end - w.start);
    for (let k = 0; k < n; k++) {
      chars.push(this.text[at + k]);
      starts.push(w.start + (span * k) / n);
      ends.push(w.start + (span * (k + 1)) / n);
    }
    this.cursor = at + n;
    this.lastEnd = w.end;
  }
  if (!chars.length) return null;
  return {
    characters: chars,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  };
};

// Whatever is left after the last word (trailing punctuation, a final newline).
CharTimeline.prototype.flush = function (endTime) {
  if (this.cursor >= this.text.length) return null;
  const chars = [];
  const starts = [];
  const ends = [];
  const total = this.text.length - this.cursor;
  const span = Math.max(0, endTime - this.lastEnd);
  for (let k = this.cursor; k < this.text.length; k++) {
    const i = k - this.cursor;
    chars.push(this.text[k]);
    starts.push(this.lastEnd + (span * i) / total);
    ends.push(this.lastEnd + (span * (i + 1)) / total);
  }
  this.cursor = this.text.length;
  return {
    characters: chars,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  };
};

function synthesizeFishStream({ apiKey, voiceId, modelId, text, onLine, onEnd, onError }) {
  if (!apiKey) { onError(new Error('No Fish Audio API key configured.')); return { abort() {} }; }
  if (!text || !text.trim()) { setImmediate(() => onEnd()); return { abort() {} }; }

  const timeline = new CharTimeline(text);
  let aborted = false;
  let finished = false;
  let buf = '';           // undelivered SSE text
  let chunkSeq = -1;      // chunk currently being reported
  let chunkOffset = 0;    // that chunk's offset into the whole audio
  let committed = 0;      // words of this chunk already given times
  let lastDuration = 0;   // best known absolute end of audio so far
  const audioParts = [];  // kept only to measure what actually arrived

  const finish = (fn, arg) => {
    if (aborted || finished) return;
    finished = true;
    fn(arg);
  };

  // A word's own end is sometimes degenerate (Fish reports "1994" as
  // 3.36-3.36 when it actually runs to the next word), so a word is only
  // committed once the following word — or the end of the stream — pins its
  // real end. That keeps the highlight off zero-length spans.
  function commitWords(segments, isEnd) {
    const usable = isEnd ? segments.length : segments.length - 1;
    if (usable <= committed) return;
    const words = [];
    for (let i = committed; i < usable; i++) {
      const seg = segments[i];
      const next = segments[i + 1];
      const start = chunkOffset + (seg.start || 0);
      let end = chunkOffset + (seg.end || 0);
      if (end <= start) end = next ? chunkOffset + (next.start || 0) : Math.max(start, lastDuration);
      words.push({ text: seg.text, start, end });
    }
    committed = usable;
    const al = timeline.commit(words);
    if (al && !aborted) onLine({ audio_base64: null, alignment: al });
  }

  function handleEvent(d) {
    if (aborted) return;
    if (typeof d.chunk_seq === 'number' && d.chunk_seq !== chunkSeq) {
      chunkSeq = d.chunk_seq;
      chunkOffset = d.chunk_audio_offset_sec || 0;
      committed = 0; // segments restart per chunk
    }
    // Audio goes out the moment it arrives — this is what makes playback start
    // early; the renderer takes audio and alignment independently.
    if (d.audio_base64) {
      audioParts.push(Buffer.from(d.audio_base64, 'base64'));
      onLine({ audio_base64: d.audio_base64, alignment: null });
    }
    if (d.alignment) {
      if (typeof d.alignment.audio_duration === 'number') {
        lastDuration = Math.max(lastDuration, chunkOffset + d.alignment.audio_duration);
      }
      if (Array.isArray(d.alignment.segments)) commitWords(d.alignment.segments, false);
    }
  }

  let lastSegments = null;
  const req = ttsRequest(
    { apiKey, voiceId, modelId, text, path: STREAM_PATH },
    (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const parts = [];
        res.on('data', (d) => parts.push(d));
        res.on('end', () => finish(onError, fishError(res.statusCode, Buffer.concat(parts).toString('utf8'))));
        return;
      }
      res.setEncoding('utf8');
      res.on('data', (d) => {
        if (aborted) return;
        buf += d;
        let sep;
        // SSE frames are separated by a blank line; a frame's payload is its
        // "data:" lines joined. This is not the NDJSON the ElevenLabs path uses.
        while ((sep = buf.search(/\r?\n\r?\n/)) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + (buf[sep] === '\r' ? 4 : 2));
          const payload = frame
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).replace(/^ /, ''))
            .join('');
          if (!payload) continue;
          let parsed;
          try { parsed = JSON.parse(payload); } catch { continue; }
          if (parsed && parsed.alignment && Array.isArray(parsed.alignment.segments)) {
            lastSegments = parsed.alignment.segments;
          }
          handleEvent(parsed);
        }
      });
      res.on('end', () => {
        if (aborted) return;
        if (lastSegments) commitWords(lastSegments, true); // pin the final word
        // Fish's reported audio_duration occasionally overshoots what it
        // actually sent (measured: 56.4s claimed against 44.98s delivered, in a
        // cleanly-ended stream). Trust the bytes, not the claim — otherwise the
        // trailing characters get times past the end of the audio and the
        // highlight stalls short of the end.
        const delivered = mp3Duration(Buffer.concat(audioParts));
        const endAt = delivered > 0 ? Math.min(lastDuration, delivered) : lastDuration;
        const tail = timeline.flush(endAt);
        if (tail) onLine({ audio_base64: null, alignment: tail });
        finish(onEnd);
      });
      // A chunked response whose connection dies mid-stream still emits a clean
      // 'end' in Node — silently handing back half a reading as if it finished.
      // 'aborted' is the only signal that separates the two.
      res.on('aborted', () => finish(onError, new Error('Fish Audio ended the stream early.')));
      res.on('error', (e) => finish(onError, e));
    },
    (e) => finish(onError, e)
  );

  return {
    // Must settle. main.js wraps each segment in a promise whose only resolve /
    // reject are onEnd / onError, so an abort that fires neither leaves that
    // promise pending forever and the read never reports done. ElevenLabs gets
    // this for free (its req.destroy() surfaces as an 'error'); the SSE path
    // swallows it, so raise it explicitly — exactly once.
    abort() {
      if (aborted || finished) return;
      aborted = true;
      finished = true;
      try { req.destroy(); } catch { /* ignore */ }
      onError(new Error('Fish Audio stream aborted.'));
    },
  };
}

module.exports = {
  isFishVoice,
  fishVoiceId,
  listFishVoices,
  synthesizeFish,
  synthesizeFishStream,
  mp3Duration,
  stripMp3Container,
  buildAlignment,
  CharTimeline,
  VOICE_PREFIX,
};
