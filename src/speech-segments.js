'use strict';

const { isFishVoice } = require('./voices');

// v3's /stream/with-timestamps caps a request at 5000 chars; split below that
// (with margin) and stream the segments back-to-back into one continuous timeline.
const SEGMENT_CHARS = 4500;
// Fish drops trailing text on long requests, silently and intermittently:
// measured over repeated identical requests, 965 chars lost 21 words on 1 run in
// 3, while 400 and 700 chars came back complete every time. Keep Fish requests
// short and let the existing multi-segment path stitch them.
const FISH_SEGMENT_CHARS = 700;

function segmentsForVoice(text, voiceId) {
  const maxChars = isFishVoice(voiceId) ? FISH_SEGMENT_CHARS : SEGMENT_CHARS;
  if (text.length <= maxChars) return [text];
  const segs = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxChars, text.length);
    if (end < text.length) {
      const slice = text.slice(i, end);
      let cut = Math.max(
        slice.lastIndexOf('. '),
        slice.lastIndexOf('! '),
        slice.lastIndexOf('? '),
        slice.lastIndexOf('\n')
      );
      if (cut < maxChars * 0.5) cut = slice.lastIndexOf(' ');
      if (cut > 0) end = i + cut + 1;
    }
    segs.push(text.slice(i, end));
    i = end;
  }
  return segs;
}

module.exports = { segmentsForVoice };
