'use strict';

function readClipboardContent(clipboard) {
  return {
    text: (clipboard.readText() || '').trim(),
    html: clipboard.readHTML() || '',
  };
}

module.exports = { readClipboardContent };
