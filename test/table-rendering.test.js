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
    this.childNodes = children;
    this.className = '';
  }

  appendChild(child) {
    this.childNodes.push(child);
    return child;
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.childNodes = [new TextNode(value)];
  }
}

function element(tag, ...children) { return new ElementNode(tag, children); }
function text(value) { return new TextNode(value); }

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
  vm.runInNewContext(script, { window, document, DOMParser });
  return window.SpeakRich.build('<copied HTML fixture>');
}

function descendants(node, tag) {
  const found = [];
  for (const child of node.childNodes || []) {
    if (child.tagName === tag.toUpperCase()) found.push(child);
    found.push(...descendants(child, tag));
  }
  return found;
}

test('copied tables retain rows, columns, headers, and spoken word alignment', () => {
  const body = element('body',
    element('p', text('Before the table.')),
    element('table',
      element('thead', element('tr',
        element('th', text('Options selected')),
        element('th', text('Users')),
        element('th', text('Share')),
      )),
      element('tbody', element('tr',
        element('td', text('1')),
        element('td', text('160')),
        element('td', text('17.7%')),
      )),
    ),
    element('p', text('After the table.')),
  );

  const result = buildRich(body);
  const tables = descendants(result.fragment, 'table');
  assert.equal(tables.length, 1);
  assert.equal(descendants(tables[0], 'tr').length, 2);
  assert.equal(descendants(tables[0], 'th').length, 3);
  assert.equal(descendants(tables[0], 'td').length, 3);
  assert.equal(result.text, 'Before the table. Options selected Users Share 1 160 17.7% After the table.');
  assert.equal(result.charToWord.length, result.text.length);
  assert.ok(result.words.every((word) => word.el.tagName === 'SPAN'));
});

test('table rendering still strips active content and preserves ordinary formatting', () => {
  const body = element('body',
    element('p', element('strong', text('Summary'))),
    element('table',
      element('caption', text('Results')),
      element('tbody', element('tr', element('td', element('em', text('Safe'))))),
      element('tfoot', element('tr', element('td', text('Total')))),
    ),
    element('script', text('never display me')),
  );

  const result = buildRich(body);
  const table = descendants(result.fragment, 'table')[0];
  assert.ok(table);
  assert.equal(descendants(table, 'caption').length, 1);
  assert.equal(descendants(table, 'tfoot').length, 1);
  assert.equal(result.text.includes('never display me'), false);
  assert.equal(result.text, 'Summary Results Safe Total');
  assert.ok(descendants(result.fragment, 'span').some((span) => span.className.includes('b')));
  assert.ok(descendants(result.fragment, 'span').some((span) => span.className.includes('i')));
});

test('clipboard reading keeps HTML alongside plain text and accepts HTML-only content', () => {
  const { readClipboardContent } = require('../src/clipboard-content');
  const html = '<table><tr><td>one</td><td>two</td></tr></table>';
  assert.deepEqual(readClipboardContent({
    readText: () => ' one two ',
    readHTML: () => html,
  }), { text: 'one two', html });
  assert.deepEqual(readClipboardContent({
    readText: () => '',
    readHTML: () => html,
  }), { text: '', html });
  assert.deepEqual(readClipboardContent({
    readText: () => 'Plain only',
    readHTML: () => '',
  }), { text: 'Plain only', html: '' });
});
