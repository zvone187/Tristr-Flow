'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  systemPreferences,
  clipboard,
  Notification,
  shell,
} = require('electron');
const path = require('path');

const { loadConfig } = require('./config');
const { getSelectedText } = require('./selection');
const { synthesize, synthesizeStream, clampSpeed, clampStability } = require('./elevenlabs');
const { listVoices, CURATED } = require('./voices');
const settingsStore = require('./settings');

let tray = null;
let overlayWin = null;
let settingsWin = null;
let config = null;
let state = null; // mutable, persisted: { voiceId, voiceName, speed }
let busy = false;
let speakGen = 0; // bumped on every new request / stop, to cancel stale in-flight synthesis
let activeStream = null; // current in-flight ElevenLabs stream handle (abortable)

const OVERLAY_W = 820;
const OVERLAY_H = 440;
const SEGMENT_CHARS = 9000; // split longer text into back-to-back streamed requests

function hotkeyLabel(accel) {
  return (accel || config.hotkey)
    .replace('CommandOrControl', '⌘')
    .replace('Command', '⌘')
    .replace('Control', '⌃')
    .replace('Alt', '⌥')
    .replace('Option', '⌥')
    .replace('Shift', '⇧')
    .replace(/\+/g, ' ');
}

function notify(title, body) {
  try {
    new Notification({ title, body, silent: true }).show();
  } catch {
    /* ignore */
  }
}

function hasAccessibility() {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.isTrustedAccessibilityClient(false);
}

function persist() {
  settingsStore.save({
    voiceId: state.voiceId,
    voiceName: state.voiceName,
    speed: state.speed,
    stability: state.stability,
    overlayBounds: state.overlayBounds || null,
  });
}

// ---- overlay window ------------------------------------------------------

function createOverlay() {
  overlayWin = new BrowserWindow({
    width: OVERLAY_W,
    height: OVERLAY_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: true, // user can resize; size is persisted (see saveBounds)
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    hasShadow: false,
    acceptFirstMouse: true, // first click on the inactive overlay hits the button, not just focus
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // extra isolation for the renderer that shows untrusted clipboard HTML
    },
  });
  overlayWin.setMinimumSize(360, 200);
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));

  // Never let rendered clipboard HTML navigate or open windows (defense-in-depth
  // on top of the renderer CSP, which cannot stop main-process navigation).
  overlayWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlayWin.webContents.on('will-navigate', (e) => e.preventDefault());

  // Persist the user's chosen size/position (drag-end events; debounced).
  let boundsTimer = null;
  const saveBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (overlayWin && !overlayWin.isDestroyed()) {
        state.overlayBounds = overlayWin.getBounds();
        persist();
      }
    }, 400);
  };
  overlayWin.on('resized', saveBounds);
  overlayWin.on('moved', saveBounds);

  overlayWin.on('closed', () => {
    overlayWin = null;
  });
}

// Restore the user's saved size/position if it is still on a visible display;
// otherwise fall back to the default bottom-center placement.
function showOverlayPositioned() {
  if (!overlayWin) return;
  const b = state.overlayBounds;
  if (
    b &&
    Number.isFinite(b.x) && Number.isFinite(b.y) &&
    Number.isFinite(b.width) && Number.isFinite(b.height) &&
    b.width >= 300 && b.height >= 160
  ) {
    const wa = screen.getDisplayMatching(b).workArea;
    const onScreen =
      b.x < wa.x + wa.width && b.x + b.width > wa.x &&
      b.y < wa.y + wa.height && b.y + b.height > wa.y;
    if (onScreen) {
      overlayWin.setBounds({
        x: b.x,
        y: b.y,
        width: Math.min(b.width, wa.width),
        height: Math.min(b.height, wa.height),
      });
      return;
    }
  }
  positionOverlay();
}

function positionOverlay() {
  if (!overlayWin) return;
  const pt = screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint(pt);
  const { x, y, width, height } = disp.workArea;
  overlayWin.setBounds({
    x: Math.round(x + (width - OVERLAY_W) / 2),
    y: Math.round(y + height - OVERLAY_H - 48),
    width: OVERLAY_W,
    height: OVERLAY_H,
  });
}

function setTrayState(s) {
  if (!tray) return;
  if (s === 'loading') tray.setTitle(' ⏳');
  else if (s === 'playing') tray.setTitle(' 🔈');
  else tray.setTitle(' 🔊');
}

// Hard stop: silence audio, cancel any in-flight synthesis, hide the overlay.
// Routed through by every close path so "talking" can never outlive the window.
function stopEverything() {
  speakGen++; // invalidate any synthesis promise that hasn't resolved yet
  if (activeStream) { try { activeStream.abort(); } catch {} activeStream = null; }
  if (overlayWin && !overlayWin.isDestroyed()) {
    try {
      overlayWin.webContents.setAudioMuted(true); // kills playback from the main process
    } catch {
      /* ignore */
    }
    overlayWin.webContents.send('overlay:stop');
    overlayWin.hide();
  }
  setTrayState('idle');
}

// ---- settings window -----------------------------------------------------

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 640,
    height: 600,
    title: 'Speak Selection — Preferences',
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#16161c',
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
  if (app.focus) app.focus({ steal: true });
  settingsWin.show();
  settingsWin.focus();
}

// ---- speak pipeline ------------------------------------------------------

// Split long text into back-to-back streamed requests at sentence/space
// boundaries so there is effectively no length limit.
function segmentText(text) {
  if (text.length <= SEGMENT_CHARS) return [text];
  const segs = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + SEGMENT_CHARS, text.length);
    if (end < text.length) {
      const slice = text.slice(i, end);
      let cut = Math.max(
        slice.lastIndexOf('. '),
        slice.lastIndexOf('! '),
        slice.lastIndexOf('? '),
        slice.lastIndexOf('\n')
      );
      if (cut < SEGMENT_CHARS * 0.5) cut = slice.lastIndexOf(' ');
      if (cut > 0) end = i + cut + 1;
    }
    segs.push(text.slice(i, end));
    i = end;
  }
  return segs;
}

function streamSegment(text, gen, index) {
  return new Promise((resolve, reject) => {
    if (gen !== speakGen || !overlayWin || overlayWin.isDestroyed()) return resolve();
    overlayWin.webContents.send('overlay:segment', { gen, index });
    activeStream = synthesizeStream({
      apiKey: config.apiKey,
      voiceId: state.voiceId,
      modelId: config.modelId,
      text,
      stability: state.stability,
      onLine: (line) => {
        if (gen !== speakGen) { if (activeStream) activeStream.abort(); return; }
        if (overlayWin && !overlayWin.isDestroyed()) {
          overlayWin.webContents.send('overlay:chunk', {
            gen,
            audioBase64: line.audio_base64 || null,
            alignment: line.alignment || null,
          });
        }
      },
      onEnd: () => { activeStream = null; resolve(); },
      onError: (err) => { activeStream = null; reject(err); },
    });
  });
}

// Resolves when the overlay reports back the canonical text it built from rich
// HTML (single source of truth: spoken == shown == aligned). Times out to plain.
let pendingRich = null;
function waitRichReady(gen) {
  return new Promise((resolve) => {
    pendingRich = { gen, resolve };
    setTimeout(() => {
      if (pendingRich && pendingRich.gen === gen) { pendingRich.resolve(null); pendingRich = null; }
    }, 4000);
  });
}

async function speakText(rawText, html) {
  const text = (rawText || '').trim();
  const hasHtml = !!(html && html.trim());
  if (!text && !hasHtml) {
    notify('Nothing to read', 'No text was found to read aloud.');
    return;
  }

  const myGen = ++speakGen; // claim this request; a later stop/request invalidates it

  if (!overlayWin) createOverlay();
  showOverlayPositioned();
  overlayWin.webContents.setAudioMuted(false);
  if (app.focus) app.focus({ steal: true }); // accessory app: activate so keys reach the overlay
  overlayWin.show();
  overlayWin.focus(); // so Space/Esc reach the overlay (capture already happened)
  setTrayState('loading');
  overlayWin.webContents.send('overlay:loading', {
    gen: myGen,
    voice: state.voiceName,
    html: hasHtml ? html : null,
  });

  // If the selection was formatted, let the overlay render + extract the exact
  // text it shows, and speak THAT (keeps the highlight from drifting).
  let ttsText = text;
  if (hasHtml) {
    const rr = await waitRichReady(myGen);
    if (myGen !== speakGen) return;
    if (rr && rr.ok && rr.text && rr.text.trim()) ttsText = rr.text;
  }
  if (!ttsText.trim()) { setTrayState('idle'); return; }

  const segments = segmentText(ttsText);
  try {
    for (let i = 0; i < segments.length; i++) {
      if (myGen !== speakGen) return;
      await streamSegment(segments[i], myGen, i);
    }
    if (myGen === speakGen && overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.webContents.send('overlay:all-done', { gen: myGen });
    }
  } catch (err) {
    console.error('[speak] stream failed:', err);
    if (myGen === speakGen && overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.webContents.send('overlay:error', { message: String(err.message || err) });
      setTrayState('idle');
    }
  }
}

async function onHotkey() {
  // Second press while the overlay is up = stop & dismiss.
  if (overlayWin && overlayWin.isVisible()) {
    stopEverything();
    return;
  }
  if (busy) return;
  busy = true;
  try {
    if (!hasAccessibility()) {
      systemPreferences.isTrustedAccessibilityClient(true);
      notify(
        'Accessibility permission needed',
        'Enable Speak Selection under System Settings → Privacy & Security → Accessibility, then try again.'
      );
      updateTrayMenu();
      return;
    }
    const { text, html, reason } = await getSelectedText();
    if (!text) {
      if (reason === 'not-trusted') {
        systemPreferences.isTrustedAccessibilityClient(true);
        notify(
          'Accessibility permission needed',
          'Enable Speak Selection under System Settings → Privacy & Security → Accessibility, then try again.'
        );
      } else if (reason === 'secure-input') {
        notify(
          "Can't read selection",
          'A password or secure field is active. Click into normal text and try again.'
        );
      } else if (reason === 'capture-failed') {
        notify('Could not capture selection', 'Something went wrong reading the selection. Try again.');
      } else {
        notify('No text selected', 'Select some text first, then press the hotkey.');
      }
      return;
    }
    await speakText(text, html);
  } catch (err) {
    console.error('[speak] hotkey error:', err);
    notify('Speak Selection error', String(err.message || err));
  } finally {
    busy = false;
  }
}

async function speakFromClipboard() {
  const text = clipboard.readText().trim();
  if (!text) {
    notify('Clipboard is empty', 'Copy some text, then use this menu item.');
    return;
  }
  await speakText(text);
}

function setVoice(voiceId, voiceName) {
  state.voiceId = voiceId;
  state.voiceName = voiceName;
  persist();
  updateTrayMenu();
}

// ---- tray ----------------------------------------------------------------

function updateTrayMenu() {
  if (!tray) return;
  const ok = hasAccessibility();

  const voiceItems = CURATED.map((v) => ({
    label: v.name,
    type: 'radio',
    checked: v.voice_id === state.voiceId,
    click: () => setVoice(v.voice_id, v.name),
  }));

  const speedOptions = [
    ['Slowest (0.7×)', 0.7],
    ['Slower (0.85×)', 0.85],
    ['Normal (1.0×)', 1.0],
    ['Faster (1.15×)', 1.15],
    ['Fastest (1.2×)', 1.2],
  ];
  const speedItems = speedOptions.map(([label, val]) => ({
    label,
    type: 'radio',
    checked: Math.abs(state.speed - val) < 0.001,
    click: () => {
      state.speed = val;
      persist();
    },
  }));

  const stabilityOptions = [
    ['Creative — most expressive', 0.0],
    ['Natural — balanced', 0.5],
    ['Robust — most stable', 1.0],
  ];
  const stabilityItems = stabilityOptions.map(([label, val]) => ({
    label,
    type: 'radio',
    checked: Math.abs(state.stability - val) < 0.001,
    click: () => {
      state.stability = val;
      persist();
    },
  }));

  const speedSupported = config.modelId !== 'eleven_v3'; // v3 ignores speed

  const template = [
    { label: 'Speak Selection', enabled: false },
    { label: `Hotkey:  ${hotkeyLabel()}`, enabled: false },
    { label: `Also:  ${hotkeyLabel(config.hotkey2)}`, enabled: false },
    { type: 'separator' },
    { label: 'Preferences — Voice & Stability…', click: openSettings, accelerator: 'Command+,' },
    { label: `Voice:  ${state.voiceName}`, submenu: voiceItems },
    { label: 'Stability', submenu: stabilityItems },
  ];
  if (speedSupported) {
    template.push({ label: 'Speed', submenu: speedItems });
  }
  template.push(
    { type: 'separator' },
    {
      label: ok ? '✓ Accessibility granted' : '⚠️  Grant Accessibility…',
      click: () => {
        if (!ok) {
          systemPreferences.isTrustedAccessibilityClient(true);
          shell.openExternal(
            'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
          );
        }
      },
    },
    {
      label: config.apiKey ? '✓ ElevenLabs key loaded' : '⚠️  No API key found',
      enabled: false,
    },
    { label: 'Read clipboard text aloud', click: speakFromClipboard },
    { type: 'separator' },
    { label: 'Quit Speak Selection', click: () => app.quit() }
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  setTrayState('idle');
  tray.setToolTip('Speak Selection');
  updateTrayMenu();
}

// ---- IPC: settings window <-> main --------------------------------------

ipcMain.handle('settings:get', () => ({
  voiceId: state.voiceId,
  voiceName: state.voiceName,
  speed: state.speed,
  stability: state.stability,
  apiKeyPresent: !!config.apiKey,
  model: config.modelId,
  speedSupported: config.modelId !== 'eleven_v3', // v3 ignores the speed setting
}));

ipcMain.handle('settings:listVoices', () => listVoices(config.apiKey));

ipcMain.handle('settings:preview', async (_e, { voiceId, speed }) => {
  try {
    const result = await synthesize({
      apiKey: config.apiKey,
      voiceId,
      modelId: config.modelId,
      speed: clampSpeed(speed),
      stability: state.stability,
      text: "Hey! This is how I sound. I'll read your selected text aloud, just like this.",
    });
    return { audioBase64: result.audio_base64 };
  } catch (err) {
    return { error: String(err.message || err) };
  }
});

ipcMain.on('settings:setVoice', (_e, { voiceId, voiceName }) => {
  setVoice(voiceId, voiceName);
});

ipcMain.on('settings:setSpeed', (_e, { speed }) => {
  state.speed = clampSpeed(speed);
  persist();
  updateTrayMenu();
});

ipcMain.on('settings:setStability', (_e, { stability }) => {
  state.stability = clampStability(stability);
  persist();
  updateTrayMenu();
});

ipcMain.on('settings:close', () => {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
});

ipcMain.on('overlay:rich-ready', (_e, { gen, text, ok }) => {
  if (pendingRich && pendingRich.gen === gen) {
    pendingRich.resolve({ text, ok });
    pendingRich = null;
  }
});
ipcMain.on('overlay:started', () => setTrayState('playing'));
ipcMain.on('overlay:ended', () => setTrayState('idle'));
ipcMain.on('overlay:close', () => stopEverything());

// ---- lifecycle -----------------------------------------------------------

app.whenReady().then(() => {
  config = loadConfig();
  const saved = settingsStore.load();
  state = {
    voiceId: saved.voiceId || config.voiceId,
    voiceName: saved.voiceName || config.voiceName,
    speed: clampSpeed(saved.speed != null ? saved.speed : config.speed),
    stability: clampStability(
      saved.stability != null ? saved.stability : config.stability
    ),
    overlayBounds: saved.overlayBounds || null,
  };

  if (app.dock) app.dock.hide();

  createOverlay();
  createTray();

  const registered = globalShortcut.register(config.hotkey, onHotkey);
  if (!registered) {
    notify(
      'Hotkey registration failed',
      `Could not register ${hotkeyLabel()}. It may be in use by another app.`
    );
  }
  if (config.hotkey2) {
    const reg2 = globalShortcut.register(config.hotkey2, onHotkey);
    if (!reg2) {
      notify('Second hotkey failed', `Could not register ${hotkeyLabel(config.hotkey2)}.`);
    }
  }

  if (!config.apiKey) {
    notify(
      'Missing ElevenLabs API key',
      'No ELEVENLABS_API_KEY found. Add one to ~/Development/pazi/api/.env or the app .env.'
    );
  }
  if (!hasAccessibility()) {
    systemPreferences.isTrustedAccessibilityClient(true);
  }
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', (e) => {
  if (process.platform === 'darwin') e.preventDefault();
});
