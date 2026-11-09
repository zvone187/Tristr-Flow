'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('onb', {
  account: () => ipcRenderer.invoke('onboarding:account'),
  accessibility: () => ipcRenderer.invoke('accessibility:status'),
  openAccessibility: () => ipcRenderer.invoke('accessibility:open'),
  repairAccessibility: () => ipcRenderer.invoke('accessibility:repair'),
  onAccessibilityChanged: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('accessibility:changed', handler);
    return () => ipcRenderer.removeListener('accessibility:changed', handler);
  },
  login: (email, password) => ipcRenderer.invoke('account:login', { email, password, source: 'onboarding' }),
  signup: (email, password) => ipcRenderer.invoke('account:signup', { email, password, source: 'onboarding' }),
  logout: () => ipcRenderer.invoke('account:logout', { source: 'onboarding' }),
  curatedVoices: () => ipcRenderer.invoke('voices:curated'),
  setVoice: (voiceId, voiceName) => ipcRenderer.send('settings:setVoice', { voiceId, voiceName, source: 'onboarding' }),
  setOpenAtLogin: (value) => ipcRenderer.invoke('settings:setOpenAtLogin', { value, source: 'onboarding' }),
  get: () => ipcRenderer.invoke('settings:get'),
  setHotkey: (which, accel) => ipcRenderer.invoke('settings:setHotkey', { which, accel, source: 'onboarding' }),
  finish: () => ipcRenderer.send('onboarding:finish'),
  track: (event, properties) => ipcRenderer.send('analytics:track', { event, properties }),
});
