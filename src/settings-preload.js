'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('prefs', {
  get: () => ipcRenderer.invoke('settings:get'),
  listVoices: () => ipcRenderer.invoke('settings:listVoices', { source: 'preferences' }),
  preview: (voiceId, speed) => ipcRenderer.invoke('settings:preview', { voiceId, speed, source: 'preferences' }),
  setVoice: (voiceId, voiceName) =>
    ipcRenderer.send('settings:setVoice', { voiceId, voiceName, source: 'preferences' }),
  setSpeed: (speed) => ipcRenderer.send('settings:setSpeed', { speed, source: 'preferences' }),
  setStability: (stability) => ipcRenderer.send('settings:setStability', { stability, source: 'preferences' }),
  setHotkey: (which, accel) => ipcRenderer.invoke('settings:setHotkey', { which, accel, source: 'preferences' }),
  setPauseMusic: (value) => ipcRenderer.send('settings:setPauseMusic', { value, source: 'preferences' }),
  setOverlayMode: (mode) => ipcRenderer.send('settings:setOverlayMode', { mode, source: 'preferences' }),
  setOpenAtLogin: (value) => ipcRenderer.invoke('settings:setOpenAtLogin', { value, source: 'preferences' }),
  setFontSize: (fontSize) => ipcRenderer.send('settings:setFontSize', { fontSize, source: 'preferences' }),
  setTheme: (theme) => ipcRenderer.send('settings:setTheme', { theme, source: 'preferences' }),
  close: () => ipcRenderer.send('settings:close'),
  // Account / service mode
  account: () => ipcRenderer.invoke('account:get'),
  login: (email, password) => ipcRenderer.invoke('account:login', { email, password, source: 'preferences' }),
  signup: (email, password) => ipcRenderer.invoke('account:signup', { email, password, source: 'preferences' }),
  logout: () => ipcRenderer.invoke('account:logout'),
  setOwnKey: (key) => ipcRenderer.invoke('account:setOwnKey', { key, source: 'preferences' }),
  setFishKey: (key) => ipcRenderer.invoke('account:setFishKey', { key, source: 'preferences' }),
  openBilling: () => ipcRenderer.invoke('account:openBilling'),
  track: (event, properties) => ipcRenderer.send('analytics:track', { event, properties }),
});
