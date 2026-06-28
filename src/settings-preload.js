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
  setHotkey: (which, accel) => ipcRenderer.invoke('settings:setHotkey', { which, accel }),
  setPauseMusic: (value) => ipcRenderer.send('settings:setPauseMusic', { value }),
  setFontSize: (fontSize) => ipcRenderer.send('settings:setFontSize', { fontSize }),
  close: () => ipcRenderer.send('settings:close'),
});
