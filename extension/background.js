'use strict';

// Service worker: turns the keyboard command into a "start" message, and relays
// streaming TTS from the app's localhost bridge to the content script. The fetch
// runs HERE (extension origin) with the shared token, so the page can't reach it.

const BRIDGE = 'http://127.0.0.1:8757/tts';
const TOKEN = 'tristr-flow-local-7c4e9a1b2f8d';

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd !== 'tristr-flow') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (tab && tab.id != null) chrome.tabs.sendMessage(tab.id, { type: 'speak-start' });
  });
});

chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id != null) chrome.tabs.sendMessage(tab.id, { type: 'speak-start' });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'speak-tts') return;
  let stream;
  port.onDisconnect.addListener(() => stream?.abort());
  port.onMessage.addListener(async (msg) => {
    if (stream || !msg || msg.type !== 'tts') return;
    stream = new AbortController();
    try {
      const res = await fetch(BRIDGE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-speak-token': TOKEN },
        body: JSON.stringify({ text: msg.text }),
        signal: stream.signal,
      });
      if (!res.ok || !res.body) {
        const detail = await res.json().catch(() => ({}));
        port.postMessage({ type: 'error', message: detail.error || 'Could not read with Tristr Flow. Open the desktop app and try again.' });
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) {
            try { port.postMessage({ type: 'line', line: JSON.parse(line) }); } catch { /* skip */ }
          }
        }
      }
      port.postMessage({ type: 'end' });
    } catch (e) {
      if (stream.signal.aborted) return;
      port.postMessage({
        type: 'error',
        message: `Can't reach the Tristr Flow app (${e.message}). Make sure it's running.`,
      });
    } finally {
      stream = null;
    }
  });
});
