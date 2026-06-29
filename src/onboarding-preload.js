'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('onb', {
  account: () => ipcRenderer.invoke('account:get'),
  login: (email, password) => ipcRenderer.invoke('account:login', { email, password }),
  signup: (email, password) => ipcRenderer.invoke('account:signup', { email, password }),
  setOwnKey: (key) => ipcRenderer.invoke('account:setOwnKey', { key }),
  curatedVoices: () => ipcRenderer.invoke('voices:curated'),
  setVoice: (voiceId, voiceName) => ipcRenderer.send('settings:setVoice', { voiceId, voiceName }),
  setOpenAtLogin: (value) => ipcRenderer.invoke('settings:setOpenAtLogin', { value }),
  get: () => ipcRenderer.invoke('settings:get'),
  setHotkey: (which, accel) => ipcRenderer.invoke('settings:setHotkey', { which, accel }),
  finish: () => ipcRenderer.send('onboarding:finish'),
});
