'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('onb', {
  account: () => ipcRenderer.invoke('account:get'),
  login: (email, password) => ipcRenderer.invoke('account:login', { email, password, source: 'onboarding' }),
  signup: (email, password) => ipcRenderer.invoke('account:signup', { email, password, source: 'onboarding' }),
  setOwnKey: (key) => ipcRenderer.invoke('account:setOwnKey', { key, source: 'onboarding' }),
  curatedVoices: () => ipcRenderer.invoke('voices:curated'),
  setVoice: (voiceId, voiceName) => ipcRenderer.send('settings:setVoice', { voiceId, voiceName, source: 'onboarding' }),
  setOpenAtLogin: (value) => ipcRenderer.invoke('settings:setOpenAtLogin', { value, source: 'onboarding' }),
  get: () => ipcRenderer.invoke('settings:get'),
  setHotkey: (which, accel) => ipcRenderer.invoke('settings:setHotkey', { which, accel, source: 'onboarding' }),
  finish: () => ipcRenderer.send('onboarding:finish'),
  track: (event, properties) => ipcRenderer.send('analytics:track', { event, properties }),
});
