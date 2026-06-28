'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('speak', {
  // main -> renderer (streaming)
  onLoading: (cb) => ipcRenderer.on('overlay:loading', (_e, d) => cb(d)),
  onSegment: (cb) => ipcRenderer.on('overlay:segment', (_e, d) => cb(d)),
  onChunk: (cb) => ipcRenderer.on('overlay:chunk', (_e, d) => cb(d)),
  onAllDone: (cb) => ipcRenderer.on('overlay:all-done', (_e, d) => cb(d)),
  onError: (cb) => ipcRenderer.on('overlay:error', (_e, d) => cb(d)),
  onStop: (cb) => ipcRenderer.on('overlay:stop', () => cb()),
  // renderer -> main
  started: () => ipcRenderer.send('overlay:started'),
  ended: () => ipcRenderer.send('overlay:ended'),
  close: () => ipcRenderer.send('overlay:close'),
});
