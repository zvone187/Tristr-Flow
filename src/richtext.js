'use strict';

// Securely turns untrusted clipboard HTML into (a) a formatted DOM with
// first-party `.word` spans and (b) the canonical plain text that is sent to
// ElevenLabs, with a char->word map so the streamed alignment highlights the
// right word. Hardened per adversarial review:
//   - ALLOWLIST rebuild via DOMParser (inert) + createElement, never innerHTML.
//   - Copied attributes dropped except validated image sources and plain alt
//     text. Links become styled text without navigation. Images omit referrers.
//   - <script>/<style>/<svg>/<math>/<iframe>/etc. subtrees dropped.
//   - The canonical text is derived from THIS rebuilt tree, so what is spoken ==
//     what is shown == what the alignment indexes (no spoofing / drift).
(function () {
  // tag -> inline format class on the word span
  const INLINE = new Map([
    ['B', 'b'], ['STRONG', 'b'],
    ['I', 'i'], ['EM', 'i'],
    ['U', 'u'],
    ['S', 'strike'], ['STRIKE', 'strike'], ['DEL', 'strike'],
    ['CODE', 'code'], ['KBD', 'code'], ['SAMP', 'code'],
    ['MARK', 'mark'], ['SMALL', 'small'],
    ['A', 'link'], ['SUP', 'sup'], ['SUB', 'sub'],
  ]);
  // tag -> safe block element to create
  const BLOCK = new Map([
    ['P', 'p'], ['DIV', 'div'], ['SECTION', 'div'], ['ARTICLE', 'div'],
    ['FIGURE', 'figure'], ['FIGCAPTION', 'figcaption'],
    ['UL', 'ul'], ['OL', 'ol'], ['LI', 'li'],
    ['H1', 'h1'], ['H2', 'h2'], ['H3', 'h3'], ['H4', 'h4'], ['H5', 'h5'], ['H6', 'h6'],
    ['BLOCKQUOTE', 'blockquote'], ['PRE', 'pre'],
    ['TABLE', 'table'], ['CAPTION', 'caption'],
    ['THEAD', 'thead'], ['TBODY', 'tbody'], ['TFOOT', 'tfoot'],
    ['TR', 'tr'], ['TD', 'td'], ['TH', 'th'],
  ]);
  // subtrees to drop entirely
  const DROP = new Set([
    'SCRIPT', 'STYLE', 'SVG', 'MATH', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META',
    'BASE', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'OPTION', 'NOSCRIPT',
    'TEMPLATE', 'SOURCE', 'VIDEO', 'AUDIO', 'CANVAS', 'HEAD',
    'TITLE', 'AREA', 'MAP', 'FRAME', 'FRAMESET', 'APPLET',
  ]);

  function imageSource(raw) {
    const value = String(raw || '').trim();
    // Embedded images must be raster data, never active SVG or HTML content.
    if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/]+={0,2}$/i.test(value)) {
      return value;
    }
    try {
      // No document base: relative paths must not resolve against app files.
      const url = new URL(value.startsWith('//') ? 'https:' + value : value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function build(html) {
    const root = document.createElement('div');
    root.className = 'rich';
    const st = {
      canonical: '',
      charToWord: [],
      words: [],
      curWord: null,
      curFirst: -1,
      pendingSep: false,
      blockHasContent: false,
    };
    let doc;
    try {
      doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    } catch {
      return null;
    }
    if (!doc || !doc.body) return null;
    walk(doc.body, root, [], st);
    endWord(st);
    return { fragment: root, text: st.canonical, charToWord: st.charToWord, words: st.words };
  }

  function endWord(st) {
    if (st.curWord) {
      st.words.push({ el: st.curWord, first: st.curFirst, last: st.canonical.length - 1, start: 0 });
      st.curWord = null;
      st.curFirst = -1;
    }
  }

  function flushSep(st, outParent) {
    if (!st.pendingSep) return;
    endWord(st);
    if (st.canonical.length > 0) {
      st.charToWord[st.canonical.length] = -1;
      st.canonical += ' ';
      if (st.blockHasContent) outParent.appendChild(document.createTextNode(' '));
    }
    st.pendingSep = false;
  }

  function emitText(text, outParent, fmt, st) {
    for (const ch of text) {
      if (/\s/.test(ch)) { st.pendingSep = true; continue; }
      flushSep(st, outParent);
      if (!st.curWord) {
        st.curWord = document.createElement('span');
        st.curWord.className = ('word ' + fmt.join(' ')).trim();
        st.curFirst = st.canonical.length;
        outParent.appendChild(st.curWord);
      }
      st.curWord.textContent += ch;
      st.charToWord[st.canonical.length] = st.words.length;
      st.canonical += ch;
      st.blockHasContent = true;
    }
  }

  function walk(node, outParent, fmt, st) {
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (child.nodeType === 3) {
        emitText(child.nodeValue || '', outParent, fmt, st);
      } else if (child.nodeType === 1) {
        const tag = child.tagName;
        if (DROP.has(tag)) continue;
        if (tag === 'IMG') {
          const src = imageSource(child.getAttribute('src'));
          if (!src) continue;
          endWord(st);
          st.pendingSep = true;
          const img = document.createElement('img');
          img.alt = child.getAttribute('alt') || '';
          img.referrerPolicy = 'no-referrer';
          img.decoding = 'async';
          img.addEventListener('error', () => { img.hidden = true; });
          img.src = src;
          outParent.appendChild(img);
          continue;
        }
        if (tag === 'BR') { endWord(st); st.pendingSep = true; continue; }
        if (BLOCK.has(tag)) {
          endWord(st);
          st.pendingSep = true;
          const el = document.createElement(BLOCK.get(tag));
          if (tag === 'TABLE') {
            const scroll = document.createElement('div');
            scroll.className = 'table-scroll';
            scroll.appendChild(el);
            outParent.appendChild(scroll);
          } else {
            outParent.appendChild(el);
          }
          const saved = st.blockHasContent;
          st.blockHasContent = false;
          walk(child, el, fmt, st);
          endWord(st);
          st.pendingSep = true;
          st.blockHasContent = saved;
        } else if (INLINE.has(tag)) {
          walk(child, outParent, fmt.concat([INLINE.get(tag)]), st);
        } else {
          walk(child, outParent, fmt, st); // unwrap unknown inline
        }
      }
    }
  }

  window.SpeakRich = { build };
})();
