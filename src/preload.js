'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('speak', {
  // main -> renderer (streaming)
  onLoading: (cb) => ipcRenderer.on('overlay:loading', (_e, d) => cb(d)),
  onSegment: (cb) => ipcRenderer.on('overlay:segment', (_e, d) => cb(d)),
  onChunk: (cb) => ipcRenderer.on('overlay:chunk', (_e, d) => cb(d)),
  onAllDone: (cb) => ipcRenderer.on('overlay:all-done', (_e, d) => cb(d)),
  onError: (cb) => ipcRenderer.on('overlay:error', (_e, d) => cb(d)),
  onFontSize: (cb) => ipcRenderer.on('overlay:fontSize', (_e, d) => cb(d)),
  onSpeed: (cb) => ipcRenderer.on('overlay:speed', (_e, d) => cb(d)),
  onStop: (cb) => ipcRenderer.on('overlay:stop', () => cb()),
  // renderer -> main
  richReady: (gen, text, ok) => ipcRenderer.send('overlay:rich-ready', { gen, text, ok }),
  started: () => ipcRenderer.send('overlay:started'),
  ended: () => ipcRenderer.send('overlay:ended'),
  close: () => ipcRenderer.send('overlay:close'),
  openSettings: () => ipcRenderer.send('overlay:openSettings'),
  setSpeed: (speed) => ipcRenderer.send('overlay:setSpeed', { speed }),
  // voice picker (reuses the settings IPC)
  listVoices: () => ipcRenderer.invoke('settings:listVoices'),
  previewVoice: (voiceId) => ipcRenderer.invoke('settings:preview', { voiceId, speed: 1 }),
  pickVoice: (voiceId, voiceName) => ipcRenderer.send('settings:setVoice', { voiceId, voiceName }),
  currentVoiceId: () => ipcRenderer.invoke('settings:get').then((c) => (c && c.voiceId) || null),
});
