'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class TextNode {
  constructor(value) {
    this.nodeType = 3;
    this.nodeValue = value;
  }

  get textContent() { return this.nodeValue; }
}

class ElementNode {
  constructor(tag, children = []) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    for (const child of children) this.appendChild(child);
  }

  appendChild(child) {
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }

  getAttribute(name) { return this.attributes.get(name.toLowerCase()) ?? null; }
  setAttribute(name, value) { this.attributes.set(name.toLowerCase(), String(value)); }
  removeAttribute(name) { this.attributes.delete(name.toLowerCase()); }

  addEventListener(type, listener) { this.listeners.set(type, listener); }

  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }

  get src() { return this.getAttribute('src') || ''; }
  set src(value) { this.setAttribute('src', value); }
  get alt() { return this.getAttribute('alt') || ''; }
  set alt(value) { this.setAttribute('alt', value); }
  get referrerPolicy() { return this.getAttribute('referrerpolicy') || ''; }
  set referrerPolicy(value) { this.setAttribute('referrerpolicy', value); }
  get decoding() { return this.getAttribute('decoding') || ''; }
  set decoding(value) { this.setAttribute('decoding', value); }

  get textContent() {
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.childNodes = [];
    this.appendChild(new TextNode(value));
  }
}

function element(tag, ...children) { return new ElementNode(tag, children); }
function text(value) { return new TextNode(value); }
function image(src, attributes = {}) {
  const img = element('img');
  img.setAttribute('src', src);
  for (const [name, value] of Object.entries(attributes)) img.setAttribute(name, value);
  return img;
}

function buildRich(sourceBody) {
  const window = {};
  const document = {
    createElement: (tag) => new ElementNode(tag),
    createTextNode: (value) => new TextNode(value),
  };
  class DOMParser {
    parseFromString() { return { body: sourceBody }; }
  }
  const script = fs.readFileSync(path.join(__dirname, '../src/richtext.js'), 'utf8');
  vm.runInNewContext(script, { window, document, DOMParser, URL });
  return window.SpeakRich.build('<copied article fixture>');
}

function descendants(node, tag) {
  const found = [];
  for (const child of node.childNodes || []) {
    if (child.tagName === tag.toUpperCase()) found.push(child);
    found.push(...descendants(child, tag));
  }
  return found;
}

test('selected article images preserve HTTP, HTTPS, and protocol-relative sources', () => {
  const sources = [
    ['https://images.example.com/article/photo.jpg?size=large', 'https://images.example.com/article/photo.jpg?size=large'],
    ['http://images.example.com/article/photo.png', 'http://images.example.com/article/photo.png'],
    ['//images.example.com/article/photo.webp', 'https://images.example.com/article/photo.webp'],
  ];
  for (const [src, expected] of sources) {
    const result = buildRich(element('body', element('p', text('Article text.'), image(src))));
    const images = descendants(result.fragment, 'img');
    assert.equal(images.length, 1, src);
    assert.equal(images[0].src, expected);
    assert.equal(images[0].referrerPolicy, 'no-referrer');
    assert.equal(images[0].decoding, 'async');
    assert.equal(result.text, 'Article text.');
  }
});

test('selected article images preserve embedded raster formats', () => {
  for (const mime of ['png', 'gif', 'jpeg', 'webp', 'avif', 'bmp']) {
    const src = `data:image/${mime};base64,aW1hZ2U=`;
    const result = buildRich(element('body', element('p', text('Article.'), image(src))));
    const images = descendants(result.fragment, 'img');
    assert.equal(images.length, 1, mime);
    assert.equal(images[0].src, src);
  }
});

test('rebuilt images retain safe alternate text and discard copied active attributes', () => {
  const sourceImage = image('https://images.example.com/photo.jpg', {
    alt: 'A photo with <script> text & a caption',
    onload: 'window.stolen = true',
    onerror: 'window.stolen = true',
    style: 'position: fixed; width: 99999px',
    srcset: 'https://tracker.example.com/private 2x',
    href: 'javascript:alert(1)',
    class: 'copied-unsafe-class',
    id: 'copied-unsafe-id',
    width: '99999',
    height: '99999',
  });
  const result = buildRich(element('body', element('p', text('Article.'), sourceImage)));
  const img = descendants(result.fragment, 'img')[0];
  assert.ok(img);
  assert.notEqual(img, sourceImage);
  assert.equal(img.alt, 'A photo with <script> text & a caption');
  for (const attribute of ['onload', 'onerror', 'style', 'srcset', 'href', 'id', 'width', 'height']) {
    assert.equal(img.getAttribute(attribute), null, attribute);
  }
  assert.equal(img.className.includes('copied-unsafe-class'), false);
  assert.equal(descendants(result.fragment, 'script').length, 0);
  assert.equal(result.text, 'Article.');
});

test('picture fallbacks and figure captions keep their selected article order', () => {
  const source = element('source');
  source.setAttribute('srcset', 'https://tracker.example.com/unused.jpg');
  const result = buildRich(element('body',
    element('p', text('Before.')),
    element('figure',
      element('picture', source, image('https://images.example.com/photo.jpg', { alt: 'Unspoken photo description' })),
      element('figcaption', text('Caption text.')),
    ),
    element('p', text('After.')),
  ));
  const figures = descendants(result.fragment, 'figure');
  assert.equal(figures.length, 1);
  assert.deepEqual(figures[0].childNodes.filter((child) => child.nodeType === 1).map((child) => child.tagName), ['IMG', 'FIGCAPTION']);
  assert.equal(descendants(result.fragment, 'source').length, 0);
  assert.equal(result.text, 'Before. Caption text. After.');
  assert.deepEqual(Array.from(result.words, (word) => word.el.textContent), ['Before.', 'Caption', 'text.', 'After.']);
});

test('images separate adjacent text without adding alternate text to speech or alignment', () => {
  const result = buildRich(element('body', element('p',
    text('Before'),
    image('https://images.example.com/photo.jpg', { alt: 'A long description that must not be read aloud' }),
    text('after.'),
  )));
  assert.equal(descendants(result.fragment, 'img').length, 1);
  assert.equal(result.text, 'Before after.');
  assert.deepEqual(Array.from(result.charToWord), [0, 0, 0, 0, 0, 0, -1, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual(Array.from(result.words, (word) => ({ text: word.el.textContent, first: word.first, last: word.last })), [
    { text: 'Before', first: 0, last: 5 },
    { text: 'after.', first: 7, last: 12 },
  ]);
  assert.deepEqual(result.fragment.childNodes[0].childNodes.filter((child) => child.nodeType === 1).map((child) => child.tagName), ['SPAN', 'IMG', 'SPAN']);
});

test('image sources cannot read local files, run active content, or include credentials', () => {
  const unsafeSources = [
    'file:///Users/example/private.png',
    'javascript:alert(1)',
    'blob:https://example.com/copied-image',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/png,plain-text',
    'data:image/png;base64,',
    'data:image/png;base64,not-valid-base64!',
    '/article/photo.png',
    'photo.png',
    'https://name:password@images.example.com/photo.png',
    '//name:password@images.example.com/photo.png',
  ];
  for (const src of unsafeSources) {
    const result = buildRich(element('body', element('p', text('Safe text.'), image(src))));
    assert.equal(descendants(result.fragment, 'img').length, 0, src);
    assert.equal(result.text, 'Safe text.');
  }
});

test('linked images retain the image without creating a navigable link', () => {
  const link = element('a', image('https://images.example.com/photo.jpg'));
  link.setAttribute('href', 'https://tracker.example.com/click');
  const result = buildRich(element('body', element('p', text('Article.'), link)));
  assert.equal(descendants(result.fragment, 'img').length, 1);
  assert.equal(descendants(result.fragment, 'a').length, 0);
  assert.equal(result.text, 'Article.');
});
