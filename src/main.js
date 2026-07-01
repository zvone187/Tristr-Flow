'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
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
const svc = require('./service');
const updater = require('./update');
const { listVoices, CURATED } = require('./voices');
const settingsStore = require('./settings');
const localserver = require('./localserver');
const mediaCtl = require('./media');

let tray = null;
let overlayWin = null;
let settingsWin = null;
let onboardingWin = null;
let config = null;
let state = null; // mutable, persisted: { voiceId, voiceName, speed }
let busy = false;
let speakGen = 0; // bumped on every new request / stop, to cancel stale in-flight synthesis
let activeStream = null; // current in-flight ElevenLabs stream handle (abortable)
let musicPausePromise = null; // resolves to the apps we paused; null when not paused
let pendingUpdate = null; // { version, url } when a newer GitHub release exists

function maybePauseMusic() {
  if (state.pauseMusic && !musicPausePromise) musicPausePromise = mediaCtl.pauseMusic();
}
function resumeMusicIfNeeded() {
  if (!musicPausePromise) return;
  const p = musicPausePromise;
  musicPausePromise = null;
  p.then((apps) => mediaCtl.resumeMusic(apps)).catch(() => {});
}

const OVERLAY_W = 820;
const OVERLAY_H = 440;
// v3's /stream/with-timestamps caps a request at 5000 chars; split below that
// (with margin) and stream the segments back-to-back into one continuous timeline.
const SEGMENT_CHARS = 4500;

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

function tryRegister(accel) {
  if (!accel) return false;
  try {
    return globalShortcut.register(accel, onHotkey);
  } catch {
    return false; // invalid accelerator string
  }
}

// (Re)register both triggers from the current state. Returns which succeeded.
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const h1 = tryRegister(state.hotkey);
  let h2 = false;
  if (state.hotkey2 && state.hotkey2 !== state.hotkey) h2 = tryRegister(state.hotkey2);
  return { h1, h2 };
}

function clampFont(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return 20;
  return Math.min(34, Math.max(13, v));
}

function cleanTheme(t) {
  return t === 'light' || t === 'dark' ? t : 'system';
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
    hotkey: state.hotkey,
    hotkey2: state.hotkey2,
    pauseMusic: state.pauseMusic,
    fontSize: state.fontSize,
    theme: state.theme,
    // Account (service mode). ownKey lets a user run in direct mode with their
    // own ElevenLabs key without editing .env.
    serviceToken: state.serviceToken || '',
    serviceEmail: state.serviceEmail || '',
    ownKey: state.ownKey || '',
    onboarded: state.onboarded || false,
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
  // 'floating' keeps the overlay above all normal app windows but BELOW the
  // Command-Tab switcher (which sits at a higher system level). 'screen-saver'
  // would sit above the switcher and cover it.
  overlayWin.setAlwaysOnTop(true, 'floating');
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
  // Logo (template) is the menu-bar icon; reflect state in the tooltip only.
  tray.setTitle('');
  tray.setToolTip(
    s === 'loading' ? 'Tristr Flow — Preparing…' :
    s === 'playing' ? 'Tristr Flow — Reading aloud' :
    'Tristr Flow'
  );
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
  resumeMusicIfNeeded();
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
    height: 680,
    title: 'Tristr Flow — Preferences',
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#211d1a' : '#faf9f6',
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

// First-run welcome / setup. Also reachable from the tray ("Setup…").
function openOnboarding() {
  if (onboardingWin && !onboardingWin.isDestroyed()) {
    onboardingWin.show();
    onboardingWin.focus();
    return;
  }
  onboardingWin = new BrowserWindow({
    width: 500,
    height: 660,
    title: 'Welcome to Tristr Flow',
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#211d1a' : '#faf9f6',
    webPreferences: {
      preload: path.join(__dirname, 'onboarding-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  onboardingWin.loadFile(path.join(__dirname, 'onboarding.html'));
  onboardingWin.on('closed', () => { onboardingWin = null; });
  if (app.focus) app.focus({ steal: true });
  onboardingWin.show();
  onboardingWin.focus();
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

// The ElevenLabs key actually in effect: a key the user pasted in Preferences
// wins over one found in the environment / pazi .env.
function effectiveKey() {
  return (state && state.ownKey) || config.apiKey || '';
}

// Whether to route through the hosted service instead of calling ElevenLabs
// directly: forced for testing, otherwise whenever there's no own key but the
// user is signed in. (No key + not signed in => onboarding handles it.)
function useService() {
  if (config.forceService) return !!(state && state.serviceToken);
  return !effectiveKey() && !!(state && state.serviceToken);
}

function streamSegment(text, gen, index) {
  return new Promise((resolve, reject) => {
    if (gen !== speakGen || !overlayWin || overlayWin.isDestroyed()) return resolve();
    overlayWin.webContents.send('overlay:segment', { gen, index });
    const onLine = (line) => {
      if (gen !== speakGen) { if (activeStream) activeStream.abort(); return; }
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send('overlay:chunk', {
          gen,
          audioBase64: line.audio_base64 || null,
          alignment: line.alignment || null,
        });
      }
    };
    const onEnd = () => { activeStream = null; resolve(); };
    const onError = (err) => { activeStream = null; reject(err); };

    if (useService()) {
      activeStream = svc.serviceStream({
        baseUrl: config.serviceBaseUrl,
        token: state.serviceToken,
        voiceId: state.voiceId,
        stability: state.stability,
        text,
        onLine, onEnd, onError,
      });
    } else {
      activeStream = synthesizeStream({
        apiKey: effectiveKey(),
        voiceId: state.voiceId,
        modelId: config.modelId,
        text,
        stability: state.stability,
        onLine, onEnd, onError,
      });
    }
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
  maybePauseMusic(); // pause Spotify/Apple Music while we read (resumed on end/stop)
  overlayWin.webContents.send('overlay:loading', {
    gen: myGen,
    voice: state.voiceName,
    html: hasHtml ? html : null,
    fontSize: state.fontSize,
    speed: state.speed,
  });

  // If the selection was formatted, let the overlay render + extract the exact
  // text it shows, and speak THAT (keeps the highlight from drifting).
  let ttsText = text;
  if (hasHtml) {
    const rr = await waitRichReady(myGen);
    if (myGen !== speakGen) return;
    if (rr && rr.ok && rr.text && rr.text.trim()) ttsText = rr.text;
  }
  if (!ttsText.trim()) { setTrayState('idle'); resumeMusicIfNeeded(); return; }

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
    resumeMusicIfNeeded();
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
        'Enable Tristr Flow under System Settings → Privacy & Security → Accessibility, then try again.'
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
          'Enable Tristr Flow under System Settings → Privacy & Security → Accessibility, then try again.'
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
    notify('Tristr Flow error', String(err.message || err));
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

function setSpeedValue(val) {
  state.speed = clampSpeed(val);
  persist();
  updateTrayMenu();
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('overlay:speed', { speed: state.speed });
  }
}

// ---- tray ----------------------------------------------------------------

// Lightweight update check: compares the running version to the latest GitHub
// release. If newer, surfaces a clickable notification + a tray "download" item.
// No silent install (the app is unsigned) — one click opens the .dmg download.
async function checkUpdates({ manual = false } = {}) {
  try {
    const res = await updater.checkForUpdate(app.getVersion());
    if (res && res.available) {
      const isNewlyFound = !pendingUpdate || pendingUpdate.version !== res.version;
      pendingUpdate = { version: res.version, url: res.url };
      updateTrayMenu();
      if (isNewlyFound || manual) {
        try {
          const n = new Notification({
            title: `Tristr Flow ${res.version} is available`,
            body: 'Click to download the update.',
            silent: false,
          });
          n.on('click', () => shell.openExternal(res.url));
          n.show();
        } catch { /* ignore */ }
      }
    } else {
      pendingUpdate = null;
      updateTrayMenu();
      if (manual) notify('You’re up to date', `Tristr Flow ${app.getVersion()} is the latest version.`);
    }
  } catch (e) {
    if (manual) notify('Update check failed', String(e.message || e));
  }
}

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
    ['0.75×', 0.75],
    ['Normal (1.0×)', 1.0],
    ['1.25×', 1.25],
    ['1.5×', 1.5],
    ['2.0×', 2.0],
  ];
  const speedItems = speedOptions.map(([label, val]) => ({
    label,
    type: 'radio',
    checked: Math.abs(state.speed - val) < 0.001,
    click: () => setSpeedValue(val),
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

  const template = [];
  if (pendingUpdate) {
    template.push(
      { label: `⬆︎  Update available — get ${pendingUpdate.version}…`, click: () => shell.openExternal(pendingUpdate.url) },
      { type: 'separator' }
    );
  }
  template.push(
    { label: 'Tristr Flow', enabled: false },
    { label: `Hotkey:  ${hotkeyLabel(state.hotkey)}`, enabled: false }
  );
  if (state.hotkey2) template.push({ label: `Also:  ${hotkeyLabel(state.hotkey2)}`, enabled: false });
  template.push(
    { type: 'separator' },
    { label: 'Preferences — Voice, Shortcuts…', click: openSettings, accelerator: 'Command+,' },
    { label: 'Setup — Account…', click: openOnboarding },
    { label: `Voice:  ${state.voiceName}`, submenu: voiceItems },
    { label: 'Stability', submenu: stabilityItems },
    {
      label: 'Pause music while reading',
      type: 'checkbox',
      checked: !!state.pauseMusic,
      click: () => { state.pauseMusic = !state.pauseMusic; persist(); },
    },
    { label: 'Speed', submenu: speedItems }
  );
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
      label:
        accountMode() === 'direct'
          ? '✓ Using your ElevenLabs key'
          : accountMode() === 'service'
            ? `✓ Signed in${state.serviceEmail ? ' — ' + state.serviceEmail : ''}`
            : '⚠️  Not set up — open Setup',
      enabled: false,
    },
    { label: 'Read clipboard text aloud', click: speakFromClipboard },
    { type: 'separator' },
    { label: 'Check for Updates…', click: () => checkUpdates({ manual: true }) },
    { label: 'Quit Tristr Flow', click: () => app.quit() }
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function trayIcon() {
  // Monochrome logo as a macOS "template" image (auto-adapts to light/dark menu
  // bars). @2x is picked up automatically from the sibling file.
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'trayTemplate.png'));
    if (!img.isEmpty()) { img.setTemplateImage(true); return img; }
  } catch { /* fall through */ }
  return nativeImage.createEmpty();
}

function createTray() {
  tray = new Tray(trayIcon());
  setTrayState('idle');
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
  speedSupported: true, // speed is now client-side playbackRate — works on every model
  hotkey: state.hotkey,
  hotkey2: state.hotkey2 || '',
  pauseMusic: state.pauseMusic,
  fontSize: state.fontSize,
  theme: state.theme,
  openAtLogin: getOpenAtLogin(),
}));

// ---- launch at login -----------------------------------------------------
function getOpenAtLogin() {
  try { return !!app.getLoginItemSettings().openAtLogin; } catch { return false; }
}
function setOpenAtLogin(value) {
  try { app.setLoginItemSettings({ openAtLogin: !!value }); } catch { /* ignore */ }
  return getOpenAtLogin();
}
ipcMain.handle('settings:setOpenAtLogin', (_e, { value }) => ({ openAtLogin: setOpenAtLogin(value) }));

// ---- IPC: account / service mode ----------------------------------------

function accountMode() {
  if (effectiveKey() && !config.forceService) return 'direct'; // own key -> ElevenLabs directly
  if (state.serviceToken) return 'service';                    // signed in -> hosted proxy
  return 'unconfigured';                                       // needs onboarding
}

ipcMain.handle('account:get', async () => {
  const out = {
    mode: accountMode(),
    signedIn: !!state.serviceToken,
    email: state.serviceEmail || '',
    hasOwnKey: !!effectiveKey(),
    ownKeyFromEnv: !!config.apiKey, // key came from env/.env (can't be cleared in-app)
    serviceUrl: config.serviceBaseUrl,
    creditsMicros: null,
    creditsDollars: null,
    minutesLeft: null,
    plan: null,
  };
  if (state.serviceToken) {
    try {
      const me = await svc.me({ baseUrl: config.serviceBaseUrl, token: state.serviceToken });
      out.email = me.email;
      out.creditsMicros = me.creditsMicros;
      out.creditsDollars = me.creditsDollars;
      out.minutesLeft = me.minutesLeft;
      out.plan = me.plan;
    } catch (e) {
      out.error = String(e.message || e);
    }
  }
  return out;
});

// Opens the hosted account/billing page in the browser (upgrade / manage Pro).
ipcMain.handle('account:openBilling', () => {
  shell.openExternal(`${config.serviceBaseUrl || 'https://tristr-flow.onrender.com'}/account`);
  return { ok: true };
});

ipcMain.handle('account:login', async (_e, { email, password }) => {
  try {
    const r = await svc.login({ baseUrl: config.serviceBaseUrl, email, password });
    state.serviceToken = r.apiToken;
    state.serviceEmail = r.email;
    state.onboarded = true;
    persist();
    updateTrayMenu();
    return { ok: true, email: r.email, creditsMicros: r.creditsMicros };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('account:signup', async (_e, { email, password }) => {
  try {
    const r = await svc.signup({ baseUrl: config.serviceBaseUrl, email, password });
    state.serviceToken = r.apiToken;
    state.serviceEmail = r.email;
    state.onboarded = true;
    persist();
    updateTrayMenu();
    return { ok: true, email: r.email, creditsMicros: r.creditsMicros };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('account:logout', () => {
  state.serviceToken = '';
  state.serviceEmail = '';
  persist();
  updateTrayMenu();
  return { ok: true };
});

// Static curated voice list for onboarding (works with or without a key/login,
// unlike settings:listVoices which queries the ElevenLabs library).
ipcMain.handle('voices:curated', () => CURATED);

ipcMain.on('onboarding:finish', () => {
  state.onboarded = true;
  persist();
  updateTrayMenu();
  if (onboardingWin && !onboardingWin.isDestroyed()) onboardingWin.close();
});

// Lets a user run in direct mode with their own ElevenLabs key (no login),
// without editing .env. Empty string clears it (falls back to env key if any).
ipcMain.handle('account:setOwnKey', (_e, { key }) => {
  state.ownKey = (key || '').trim();
  state.onboarded = true;
  persist();
  updateTrayMenu();
  return { ok: true, hasOwnKey: !!effectiveKey(), mode: accountMode() };
});

ipcMain.on('settings:setTheme', (_e, { theme }) => {
  state.theme = cleanTheme(theme);
  persist();
  nativeTheme.themeSource = state.theme; // live-updates overlay + settings prefers-color-scheme
});

ipcMain.on('settings:setFontSize', (_e, { fontSize }) => {
  state.fontSize = clampFont(fontSize);
  persist();
  // live-apply to an open overlay
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('overlay:fontSize', { fontSize: state.fontSize });
  }
});

ipcMain.on('settings:setPauseMusic', (_e, { value }) => {
  state.pauseMusic = !!value;
  persist();
  updateTrayMenu();
});

// Set/clear a global trigger (which = 1 primary, 2 secondary). Validates by
// actually registering; reverts and reports on conflict/invalid combo.
ipcMain.handle('settings:setHotkey', (_e, { which, accel }) => {
  const oldH1 = state.hotkey;
  const oldH2 = state.hotkey2;
  if (which === 2) state.hotkey2 = accel || '';
  else state.hotkey = accel || '';

  const reg = registerHotkeys();
  const ok = which === 2 ? (!state.hotkey2 || reg.h2) : reg.h1;
  if (!ok) {
    state.hotkey = oldH1;
    state.hotkey2 = oldH2;
    registerHotkeys();
    return { ok: false, hotkey: state.hotkey, hotkey2: state.hotkey2 || '', error: `“${hotkeyLabel(accel)}” is unavailable (in use or invalid).` };
  }
  persist();
  updateTrayMenu();
  return { ok: true, hotkey: state.hotkey, hotkey2: state.hotkey2 || '' };
});

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

ipcMain.on('settings:setSpeed', (_e, { speed }) => setSpeedValue(speed));
ipcMain.on('overlay:setSpeed', (_e, { speed }) => setSpeedValue(speed)); // speed control on the reading overlay

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
ipcMain.on('overlay:ended', () => { setTrayState('idle'); resumeMusicIfNeeded(); });
ipcMain.on('overlay:close', () => stopEverything());
ipcMain.on('overlay:openSettings', () => openSettings());

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
    hotkey: saved.hotkey || config.hotkey,
    hotkey2: saved.hotkey2 != null ? saved.hotkey2 : config.hotkey2,
    pauseMusic: saved.pauseMusic != null ? saved.pauseMusic : config.pauseMusic,
    fontSize: clampFont(saved.fontSize != null ? saved.fontSize : config.fontSize),
    theme: cleanTheme(saved.theme || config.theme),
    // Account (service mode).
    serviceToken: saved.serviceToken || '',
    serviceEmail: saved.serviceEmail || '',
    ownKey: saved.ownKey || '',
    // Existing users who already have a key/login are implicitly onboarded.
    onboarded:
      saved.onboarded ||
      !!(config.apiKey || saved.serviceToken || saved.ownKey),
  };
  nativeTheme.themeSource = state.theme; // 'system' follows macOS; else force light/dark

  // Keep the settings window chrome in sync when the appearance changes.
  nativeTheme.on('updated', () => {
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#211d1a' : '#faf9f6');
    }
  });

  if (app.dock) app.dock.hide();

  createOverlay();
  createTray();
  // Localhost bridge for the Chrome extension's in-page highlighting.
  try {
    localserver.start({ getConfig: () => config, getState: () => state });
  } catch (e) {
    console.error('[localserver] failed to start:', e);
  }

  const reg = registerHotkeys();
  if (!reg.h1) {
    notify('Hotkey registration failed', `Could not register ${hotkeyLabel(state.hotkey)}. It may be in use by another app.`);
  }
  if (state.hotkey2 && !reg.h2) {
    notify('Second hotkey failed', `Could not register ${hotkeyLabel(state.hotkey2)}.`);
  }

  // First run: welcome + setup. Existing users (env key / saved login / own key)
  // are already marked onboarded above and skip straight in.
  if (!state.onboarded) {
    openOnboarding();
  } else if (!effectiveKey() && !state.serviceToken) {
    notify(
      'Tristr Flow needs setup',
      'Open the menu-bar icon ▸ Setup to sign in or add your ElevenLabs key.'
    );
  }
  if (!hasAccessibility()) {
    systemPreferences.isTrustedAccessibilityClient(true);
  }

  // Check for a newer release shortly after launch, then periodically.
  setTimeout(() => checkUpdates(), 8000);
  setInterval(() => checkUpdates(), 6 * 60 * 60 * 1000);
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', (e) => {
  if (process.platform === 'darwin') e.preventDefault();
});
