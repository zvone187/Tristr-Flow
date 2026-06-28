'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('prefs', {
  get: () => ipcRenderer.invoke('settings:get'),
  listVoices: () => ipcRenderer.invoke('settings:listVoices'),
  preview: (voiceId, speed) => ipcRenderer.invoke('settings:preview', { voiceId, speed }),
  setVoice: (voiceId, voiceName) =>
    ipcRenderer.send('settings:setVoice', { voiceId, voiceName }),
  setSpeed: (speed) => ipcRenderer.send('settings:setSpeed', { speed }),
  setStability: (stability) => ipcRenderer.send('settings:setStability', { stability }),
  close: () => ipcRenderer.send('settings:close'),
});
