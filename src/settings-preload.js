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
  setOpenAtLogin: (value) => ipcRenderer.invoke('settings:setOpenAtLogin', { value }),
  setFontSize: (fontSize) => ipcRenderer.send('settings:setFontSize', { fontSize }),
  setTheme: (theme) => ipcRenderer.send('settings:setTheme', { theme }),
  close: () => ipcRenderer.send('settings:close'),
  // Account / service mode
  account: () => ipcRenderer.invoke('account:get'),
  login: (email, password) => ipcRenderer.invoke('account:login', { email, password }),
  signup: (email, password) => ipcRenderer.invoke('account:signup', { email, password }),
  logout: () => ipcRenderer.invoke('account:logout'),
  setOwnKey: (key) => ipcRenderer.invoke('account:setOwnKey', { key }),
  openBilling: () => ipcRenderer.invoke('account:openBilling'),
});
