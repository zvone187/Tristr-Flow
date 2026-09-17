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
  powerMonitor,
  screen,
  systemPreferences,
  clipboard,
  Notification,
  shell,
  dialog,
} = require('electron');
const { randomUUID } = require('crypto');
const path = require('path');

const { loadConfig } = require('./config');
const { getSelectedText, getFrontmostApplicationPid } = require('./selection');
const { synthesize, synthesizeStream, clampSpeed, clampStability } = require('./elevenlabs');
const { isFishVoice, synthesizeFish, synthesizeFishStream } = require('./fishaudio');
const svc = require('./service');
const updater = require('./update');
const { listVoices, mergeVoices, CURATED } = require('./voices');
const { routeVoice } = require('./provider-routing');
const settingsStore = require('./settings');
const localserver = require('./localserver');
const mediaCtl = require('./media');
const { createAnalytics } = require('./analytics');
const { createShortcutManager, selectedTextMenuPresentation } = require('./shortcut-manager');

// A second background instance can silently lose both global accelerators to
// the first one while still showing a working tray menu. Keep one owner.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

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
let trayMenu = null; // built menu, shown on right-click (or left-click in floating mode)
let overlayActive = false; // a reading session is in progress (menu-bar toggle is meaningful)
let shortcutManager = null;
let shortcutStatus = null;
let shortcutHealthTimer = null;
let analytics = null;
let analyticsShutdownStarted = false;
let analyticsShutdownComplete = false;
let lastExternalAppPid = 0;
let currentReading = null;
let appQuitCaptured = false;

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
const OVERLAY_MIN_W = 360;
const OVERLAY_MIN_H = 200;
// v3's /stream/with-timestamps caps a request at 5000 chars; split below that
// (with margin) and stream the segments back-to-back into one continuous timeline.
const SEGMENT_CHARS = 4500;
// Fish drops trailing text on long requests, silently and intermittently:
// measured over repeated identical requests, 965 chars lost 21 words on 1 run in
// 3, while 400 and 700 chars came back complete every time. Keep Fish requests
// short and let the existing multi-segment path stitch them.
const FISH_SEGMENT_CHARS = 700;

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

// (Re)register both triggers from the current state. Returns which succeeded.
function registerHotkeys() {
  if (!shortcutManager) {
    shortcutManager = createShortcutManager({
      globalShortcut,
      onShortcut: () => onHotkey('shortcut'),
    });
  }
  shortcutStatus = shortcutManager.registerAll(state.hotkey, state.hotkey2);
  console.log('[shortcut] registration checked:', shortcutAnalyticsProperties(shortcutStatus));
  captureAnalytics('shortcut_registration_checked', shortcutAnalyticsProperties(shortcutStatus));
  return {
    h1: shortcutStatus.primary.registered,
    h2: shortcutStatus.secondary.registered,
  };
}

function shortcutAnalyticsProperties(status, extra = {}) {
  return {
    primary_registered: !!(status && status.primary.registered),
    secondary_configured: !!(status && status.secondary.configured),
    secondary_registered: !!(status && status.secondary.registered),
    all_registered: !!(status && status.allRegistered),
    ...extra,
  };
}

function captureAnalytics(event, properties) {
  if (analytics) analytics.capture(event, properties);
}

function providerForVoice(voiceId = state && state.voiceId) {
  if (isFishVoice(voiceId)) return 'fish';
  return useService() ? 'service' : 'elevenlabs';
}

function repairHotkeys(source = 'periodic') {
  if (!shortcutManager) return shortcutStatus;
  const previous = shortcutStatus || shortcutManager.status();
  const result = shortcutManager.repair();
  shortcutStatus = result.status;
  const changed =
    previous.allRegistered !== shortcutStatus.allRegistered ||
    previous.anyRegistered !== shortcutStatus.anyRegistered ||
    previous.primary.registered !== shortcutStatus.primary.registered ||
    previous.secondary.registered !== shortcutStatus.secondary.registered;
  if (result.recovered.length || changed) {
    console.log(`[shortcut] health changed (${source}):`, shortcutAnalyticsProperties(shortcutStatus));
    captureAnalytics(
      result.recovered.length ? 'shortcut_registration_recovered' : 'shortcut_registration_changed',
      shortcutAnalyticsProperties(shortcutStatus, {
        source,
        recovered_count: result.recovered.length,
      })
    );
    updateTrayMenu();
  }
  return shortcutStatus;
}

function refreshHotkeys(source) {
  if (!shortcutManager) return shortcutStatus;
  shortcutStatus = shortcutManager.refreshAll();
  console.log(`[shortcut] registrations refreshed (${source}):`, shortcutAnalyticsProperties(shortcutStatus));
  captureAnalytics(
    'shortcut_registration_refreshed',
    shortcutAnalyticsProperties(shortcutStatus, { source })
  );
  updateTrayMenu();
  return shortcutStatus;
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
    overlayMode: state.overlayMode,
    // Account (service mode). ownKey lets a user run in direct mode with their
    // own ElevenLabs key without editing .env.
    serviceToken: state.serviceToken || '',
    serviceEmail: state.serviceEmail || '',
    ownKey: state.ownKey || '',
    fishKey: state.fishKey || '',
    onboarded: state.onboarded || false,
    launchCount: state.launchCount || 0,
    // Random per-install analytics identifier. It is not tied to an email or
    // account and PostHog person-profile processing is disabled for all events.
    analyticsId: state.analyticsId || '',
  });
}

// Nudge to enable "open at login" on the 1st, 3rd, and 8th launch (first open,
// then +2, then +5), only while it's off. Stops once enabled or past the last.
const LOGIN_NUDGE_LAUNCHES = [1, 3, 8];
function maybePromptOpenAtLogin() {
  if (getOpenAtLogin()) return;                              // already on — never nag
  if (!LOGIN_NUDGE_LAUNCHES.includes(state.launchCount)) return;
  captureAnalytics('open_at_login_prompt_shown', {
    source: 'launch-nudge',
    launch_count: state.launchCount,
  });
  if (app.focus) app.focus({ steal: true });                // bring the prompt forward
  dialog
    .showMessageBox({
      type: 'question',
      buttons: ['Open at Login', 'Not Now'],
      defaultId: 0,
      cancelId: 1,
      message: 'Open Tristr Flow when you log in?',
      detail: 'It stays in the menu bar, ready the moment you select text and press your shortcut.',
    })
    .then((r) => {
      const enabled = r.response === 0;
      if (enabled) setOpenAtLogin(true);
      captureAnalytics('open_at_login_prompt_responded', {
        source: 'launch-nudge',
        enabled,
      });
    })
    .catch(() => {});
}

// ---- overlay window ------------------------------------------------------

function createOverlay() {
  overlayWin = new BrowserWindow({
    width: OVERLAY_W,
    height: OVERLAY_H,
    show: false,
    frame: false,
    transparent: true,
    // Native frameless resizing is off: its grab band is invisible and spills
    // into the transparent gutter, so drags near the edge resized by accident.
    // Resizing runs off the handles on the card outline instead (see
    // overlay:resizeStart). Size is persisted either way (see saveBounds).
    resizable: false,
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
      backgroundThrottling: false, // keep audio + highlight running while collapsed (menu-bar mode)
    },
  });
  overlayWin.setMinimumSize(OVERLAY_MIN_W, OVERLAY_MIN_H);
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
    stopOverlayResize(); // never let a drag tick against a dead window
    overlayWin = null;
  });
}

// The window's resizable mask is normally cleared, and some macOS builds drop
// size changes on such a window — so raise it for the duration of the call.
function setOverlayBounds(b) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const wasResizable = overlayWin.isResizable();
  if (!wasResizable) overlayWin.setResizable(true);
  overlayWin.setBounds(b);
  if (!wasResizable) overlayWin.setResizable(false);
}

// Size the overlay opens at: whatever the user last resized it to, falling
// back to the built-in default. Position varies by mode; size does not.
function savedOverlaySize() {
  const b = state.overlayBounds;
  const ok = (n, min) => Number.isFinite(n) && n >= min;
  return {
    w: b && ok(b.width, OVERLAY_MIN_W) ? b.width : OVERLAY_W,
    h: b && ok(b.height, OVERLAY_MIN_H) ? b.height : OVERLAY_H,
  };
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
      setOverlayBounds({
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
  // Default placement, but keep whatever size the user last resized to.
  const { w, h } = savedOverlaySize();
  setOverlayBounds({
    x: Math.round(x + (width - w) / 2),
    y: Math.round(y + height - h - 48),
    width: w,
    height: h,
  });
}

// Menu-bar mode: anchor the panel as a dropdown just below the tray icon.
function positionOverlayForTray() {
  if (!overlayWin) return;
  // Anchored under the tray icon, but at the user's last chosen size.
  const { w, h } = savedOverlaySize();
  const tb = tray && tray.getBounds ? tray.getBounds() : null;
  const anchor = tb && tb.width ? { x: tb.x + tb.width / 2, y: tb.y + tb.height } : screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(anchor).workArea;
  let x = Math.round(anchor.x - w / 2);
  let y = Math.round((tb ? tb.y + tb.height : wa.y) + 6);
  x = Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - w - 8);
  y = Math.min(Math.max(y, wa.y + 4), wa.y + wa.height - h - 8);
  setOverlayBounds({ x, y, width: w, height: h });
}

// ---- custom overlay resize ----------------------------------------------
// The renderer holds pointer capture on a handle and tells us which edge is
// being dragged; we track the cursor ourselves so the drag survives the
// pointer leaving the window, and so screen coordinates need no translation.
let resizeDrag = null;
let resizeTimer = null;

function applyResizeTick() {
  const d = resizeDrag;
  if (!d || !overlayWin || overlayWin.isDestroyed()) return stopOverlayResize();
  // Safety net: a lost pointerup must never leave the window stuck resizing.
  if (Date.now() - d.startedAt > 30000) return stopOverlayResize();

  const pt = screen.getCursorScreenPoint();
  const dx = pt.x - d.origin.x;
  const dy = pt.y - d.origin.y;
  const b = d.start;
  let { x, y, width, height } = b;

  if (d.edge.includes('e')) width = b.width + dx;
  if (d.edge.includes('s')) height = b.height + dy;
  if (d.edge.includes('w')) { width = b.width - dx; x = b.x + dx; }
  if (d.edge.includes('n')) { height = b.height - dy; y = b.y + dy; }

  // Clamp to the minimum with the opposite edge pinned, so a fast drag past
  // the limit stops dead instead of dragging the whole window along.
  if (width < OVERLAY_MIN_W) {
    if (d.edge.includes('w')) x = b.x + b.width - OVERLAY_MIN_W;
    width = OVERLAY_MIN_W;
  }
  if (height < OVERLAY_MIN_H) {
    if (d.edge.includes('n')) y = b.y + b.height - OVERLAY_MIN_H;
    height = OVERLAY_MIN_H;
  }

  setOverlayBounds({
    x: Math.round(x), y: Math.round(y),
    width: Math.round(width), height: Math.round(height),
  });
}

function stopOverlayResize() {
  if (resizeTimer) { clearInterval(resizeTimer); resizeTimer = null; }
  if (!resizeDrag) return;
  const completedDrag = resizeDrag;
  resizeDrag = null;
  // 'resized' does not fire for our programmatic setBounds, so persist here.
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setResizable(false); // back to handles-only
    state.overlayBounds = overlayWin.getBounds();
    persist();
  }
  captureAnalytics('overlay_interaction', {
    surface: 'overlay',
    interaction: 'resize',
    edge: completedDrag.edge,
    duration_ms: Date.now() - completedDrag.startedAt,
  });
}

const RESIZE_EDGES = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

ipcMain.on('overlay:resizeStart', (_e, { edge } = {}) => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (!RESIZE_EDGES.has(edge)) return;
  stopOverlayResize(); // drop any drag that never reported its end
  resizeDrag = {
    edge,
    start: overlayWin.getBounds(),
    origin: screen.getCursorScreenPoint(),
    startedAt: Date.now(),
  };
  // Held for the whole drag so setOverlayBounds isn't flipping the style mask
  // on every frame; stopOverlayResize puts it back.
  overlayWin.setResizable(true);
  resizeTimer = setInterval(applyResizeTick, 16);
});

ipcMain.on('overlay:resizeEnd', () => stopOverlayResize());

// Place the overlay according to the chosen mode.
function positionOverlayForMode() {
  if (state.overlayMode === 'menubar') positionOverlayForTray();
  else showOverlayPositioned();
}

// Menu-bar mode: clicking the tray icon shows/hides the panel (audio keeps
// playing while hidden). When nothing is reading, fall back to the menu.
function toggleOverlayPanel() {
  if (overlayActive && overlayWin && !overlayWin.isDestroyed()) {
    if (overlayWin.isVisible()) {
      overlayWin.hide();
      captureAnalytics('overlay_interaction', {
        surface: 'tray',
        interaction: 'hide',
      });
    } else {
      positionOverlayForTray();
      overlayWin.show();
      captureAnalytics('overlay_interaction', {
        surface: 'tray',
        interaction: 'show',
      });
    }
    return;
  }
  showTrayMenu();
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
function stopEverything(source = 'system') {
  if (currentReading) {
    captureAnalytics('reading_stopped', {
      trigger: currentReading.trigger,
      provider: currentReading.provider,
      source,
      duration_ms: Date.now() - currentReading.startedAt,
    });
    currentReading = null;
  }
  overlayActive = false; // reading ended; menu-bar toggle no longer shows the panel
  stopOverlayResize(); // closing mid-drag must not keep resizing a hidden window
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

function openSettings(source = 'system') {
  captureAnalytics('window_opened', { surface: 'preferences', source });
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
    captureAnalytics('window_closed', { surface: 'preferences' });
    settingsWin = null;
  });
  if (app.focus) app.focus({ steal: true });
  settingsWin.show();
  settingsWin.focus();
}

// First-run welcome / setup. Also reachable from the tray ("Setup…").
function openOnboarding(source = 'system') {
  captureAnalytics('window_opened', { surface: 'onboarding', source });
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
  onboardingWin.on('closed', () => {
    captureAnalytics('window_closed', { surface: 'onboarding' });
    onboardingWin = null;
  });
  if (app.focus) app.focus({ steal: true });
  onboardingWin.show();
  onboardingWin.focus();
}

// ---- speak pipeline ------------------------------------------------------

// Split long text into back-to-back streamed requests at sentence/space
// boundaries so there is effectively no length limit.
function segmentText(text, maxChars = SEGMENT_CHARS) {
  if (text.length <= maxChars) return [text];
  const segs = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxChars, text.length);
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

// A personal Fish key remains an optional direct-provider override. Otherwise,
// signed-in users use the same authenticated service proxy as ElevenLabs.
function effectiveFishKey() {
  return (state && state.fishKey) || config.fishApiKey || '';
}

function routeForVoice(voiceId) {
  return routeVoice({
    voiceId,
    elevenKey: effectiveKey(),
    fishKey: effectiveFishKey(),
    serviceToken: (state && state.serviceToken) || '',
    forceService: !!config.forceService,
  });
}

// Can we speak at all right now? Either provider being usable is enough.
function canSpeak() {
  return !!(effectiveKey() || (state && state.serviceToken) || effectiveFishKey());
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

    const route = routeForVoice(state.voiceId);
    if (route === 'fish-direct') {
      activeStream = synthesizeFishStream({
        apiKey: effectiveFishKey(),
        voiceId: state.voiceId,
        modelId: config.fishModelId,
        text,
        onLine, onEnd, onError,
      });
    } else if (route === 'service') {
      activeStream = svc.serviceStream({
        baseUrl: config.serviceBaseUrl,
        token: state.serviceToken,
        voiceId: state.voiceId,
        stability: state.stability,
        text,
        onLine, onEnd, onError,
      });
    } else if (route === 'elevenlabs-direct') {
      activeStream = synthesizeStream({
        apiKey: effectiveKey(),
        voiceId: state.voiceId,
        modelId: config.modelId,
        text,
        stability: state.stability,
        onLine, onEnd, onError,
      });
    } else {
      reject(new Error('Sign in to Tristr Flow or add an API key to use this voice.'));
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

async function speakText(rawText, html, { trigger = 'unknown' } = {}) {
  const text = (rawText || '').trim();
  const hasHtml = !!(html && html.trim());
  if (!text && !hasHtml) {
    captureAnalytics('reading_rejected', { trigger, reason: 'empty' });
    notify('Nothing to read', 'No text was found to read aloud.');
    return;
  }

  if (currentReading) {
    captureAnalytics('reading_stopped', {
      trigger: currentReading.trigger,
      provider: currentReading.provider,
      source: 'system',
      duration_ms: Date.now() - currentReading.startedAt,
    });
  }
  const myGen = ++speakGen; // claim this request; a later stop/request invalidates it
  const provider = providerForVoice();
  const startedAt = Date.now();
  currentReading = {
    gen: myGen,
    trigger,
    provider,
    startedAt,
    playbackStarted: false,
  };

  if (!overlayWin) createOverlay();
  overlayActive = true; // a reading session is live (menu-bar toggle now meaningful)
  positionOverlayForMode();
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
  if (!ttsText.trim()) {
    currentReading = null;
    setTrayState('idle');
    resumeMusicIfNeeded();
    return;
  }

  captureAnalytics('reading_started', {
    trigger,
    provider,
    character_count: ttsText.length,
    has_formatting: hasHtml,
  });

  const segments = segmentText(
    ttsText,
    isFishVoice(state.voiceId) ? FISH_SEGMENT_CHARS : SEGMENT_CHARS
  );
  try {
    for (let i = 0; i < segments.length; i++) {
      if (myGen !== speakGen) return;
      await streamSegment(segments[i], myGen, i);
    }
    if (myGen === speakGen && overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.webContents.send('overlay:all-done', { gen: myGen });
    }
    if (myGen === speakGen) {
      captureAnalytics('reading_synthesis_completed', {
        trigger,
        provider,
        segment_count: segments.length,
        character_count: ttsText.length,
        duration_ms: Date.now() - startedAt,
      });
    }
  } catch (err) {
    console.error('[speak] stream failed:', err);
    captureAnalytics('reading_failed', {
      trigger,
      provider,
      error_name: err && err.name ? err.name : 'Error',
      duration_ms: Date.now() - startedAt,
    });
    if (myGen === speakGen && overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.webContents.send('overlay:error', { message: String(err.message || err) });
      setTrayState('idle');
    }
    resumeMusicIfNeeded();
    if (currentReading && currentReading.gen === myGen) currentReading = null;
  }
}

async function onHotkey(trigger = 'shortcut', { targetPid = 0 } = {}) {
  console.log(`[shortcut] read invoked via ${trigger}`);
  captureAnalytics('read_requested', { trigger });
  // Second press while the overlay is up = stop & dismiss.
  if (overlayWin && overlayWin.isVisible()) {
    stopEverything();
    return;
  }
  if (busy) {
    captureAnalytics('read_rejected', { trigger, reason: 'busy' });
    return;
  }
  busy = true;
  try {
    if (!hasAccessibility()) {
      console.warn('[shortcut] selection capture blocked: Accessibility permission is unavailable');
      captureAnalytics('selection_capture_finished', {
        trigger,
        outcome: 'failed',
        reason: 'not-trusted',
      });
      systemPreferences.isTrustedAccessibilityClient(true);
      notify(
        'Accessibility permission needed',
        'Enable Tristr Flow under System Settings → Privacy & Security → Accessibility, then try again.'
      );
      if (trigger === 'selected_text_menu') {
        shell.openExternal(
          'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
        );
      }
      updateTrayMenu();
      return;
    }
    const { text, html, reason, source } = await getSelectedText({ targetPid });
    if (!text) {
      captureAnalytics('selection_capture_finished', {
        trigger,
        outcome: 'failed',
        reason: reason || 'empty-or-nocopy',
        source: source || 'none',
      });
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
    captureAnalytics('selection_capture_finished', {
      trigger,
      outcome: 'success',
      source: source || 'unknown',
      character_count: text.length,
      has_formatting: !!html,
    });
    await speakText(text, html, { trigger });
  } catch (err) {
    console.error('[speak] hotkey error:', err);
    captureAnalytics('selection_capture_finished', {
      trigger,
      outcome: 'failed',
      reason: 'unexpected-error',
      error_name: err && err.name ? err.name : 'Error',
    });
    notify('Tristr Flow error', String(err.message || err));
  } finally {
    busy = false;
  }
}

async function speakFromClipboard() {
  captureAnalytics('read_requested', { trigger: 'clipboard_menu' });
  const text = clipboard.readText().trim();
  if (!text) {
    captureAnalytics('read_rejected', { trigger: 'clipboard_menu', reason: 'empty-clipboard' });
    notify('Clipboard is empty', 'Copy some text, then use this menu item.');
    return;
  }
  await speakText(text, null, { trigger: 'clipboard_menu' });
}

function setVoice(voiceId, voiceName, source = 'preferences') {
  state.voiceId = voiceId;
  state.voiceName = voiceName;
  persist();
  updateTrayMenu();
  captureAnalytics('setting_changed', {
    surface: source,
    setting_name: 'voice',
    provider: providerForVoice(voiceId),
  });
}

function setSpeedValue(val, source = 'preferences') {
  state.speed = clampSpeed(val);
  persist();
  updateTrayMenu();
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('overlay:speed', { speed: state.speed });
  }
  captureAnalytics('setting_changed', {
    surface: source,
    setting_name: 'speed',
    speed: state.speed,
  });
}

function openUpdateDownload(url, source) {
  captureAnalytics('update_download_opened', { source });
  return shell.openExternal(url);
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
          n.on('click', () => openUpdateDownload(res.url, 'system'));
          n.show();
        } catch { /* ignore */ }
      }
      captureAnalytics('update_check_completed', {
        manual,
        outcome: 'success',
        available: true,
      });
    } else {
      pendingUpdate = null;
      updateTrayMenu();
      if (manual) notify('You’re up to date', `Tristr Flow ${app.getVersion()} is the latest version.`);
      captureAnalytics('update_check_completed', {
        manual,
        outcome: 'success',
        available: false,
      });
    }
  } catch (e) {
    captureAnalytics('update_check_completed', {
      manual,
      outcome: 'failed',
      reason: 'network-error',
      error_name: e && e.name ? e.name : 'Error',
    });
    if (manual) notify('Update check failed', String(e.message || e));
  }
}

function updateTrayMenu() {
  if (!tray) return;
  const ok = hasAccessibility();
  if (shortcutManager) shortcutStatus = shortcutManager.status();
  const liveShortcutStatus = shortcutStatus || {
    primary: { configured: !!state.hotkey, registered: false },
    secondary: { configured: !!state.hotkey2, registered: false },
    allRegistered: false,
    anyRegistered: false,
  };
  const selectedTextItem = selectedTextMenuPresentation({
    accessibilityGranted: ok,
    status: liveShortcutStatus,
  });

  const voiceItems = CURATED.map((v) => ({
    label: v.name,
    type: 'radio',
    checked: v.voice_id === state.voiceId,
    click: () => setVoice(v.voice_id, v.name, 'tray'),
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
    click: () => setSpeedValue(val, 'tray'),
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
      captureAnalytics('setting_changed', {
        surface: 'tray',
        setting_name: 'stability',
        stability: state.stability,
      });
    },
  }));

  const template = [];
  if (pendingUpdate) {
    template.push(
      { label: `⬆︎  Update available — get ${pendingUpdate.version}…`, click: () => openUpdateDownload(pendingUpdate.url, 'tray') },
      { type: 'separator' }
    );
  }
  template.push(
    { label: 'Tristr Flow', enabled: false },
    {
      label: `${liveShortcutStatus.primary.registered ? '\u2713' : '\u26a0\ufe0f'} Hotkey:  ${hotkeyLabel(state.hotkey)}`,
      enabled: false,
    }
  );
  if (state.hotkey2) {
    template.push({
      label: `${liveShortcutStatus.secondary.registered ? '\u2713' : '\u26a0\ufe0f'} Also:  ${hotkeyLabel(state.hotkey2)}`,
      enabled: false,
    });
  }
  template.push(
    { type: 'separator' },
    {
      label: selectedTextItem.label,
      sublabel: selectedTextItem.sublabel,
      click: () => onHotkey('selected_text_menu', { targetPid: lastExternalAppPid }),
    },
    { label: 'Read clipboard text aloud', click: speakFromClipboard },
    { type: 'separator' },
    { label: 'Preferences — Voice, Shortcuts…', click: () => openSettings('tray'), accelerator: 'Command+,' },
    { label: 'Setup — Account…', click: () => openOnboarding('tray') },
    { label: `Voice:  ${state.voiceName}`, submenu: voiceItems },
    { label: 'Stability', submenu: stabilityItems },
    {
      label: 'Pause music while reading',
      type: 'checkbox',
      checked: !!state.pauseMusic,
      click: () => {
        state.pauseMusic = !state.pauseMusic;
        persist();
        captureAnalytics('setting_changed', {
          surface: 'tray',
          setting_name: 'pause_music',
          enabled: state.pauseMusic,
        });
      },
    },
    { label: 'Speed', submenu: speedItems }
  );
  template.push(
    { type: 'separator' },
    {
      label: ok ? '✓ Accessibility granted' : '⚠️  Grant Accessibility…',
      click: () => {
        if (!ok) {
          captureAnalytics('accessibility_prompt_opened', { surface: 'tray' });
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
    { type: 'separator' },
    { label: 'Check for Updates…', click: () => checkUpdates({ manual: true }) },
    { label: 'Quit Tristr Flow', click: () => app.quit() }
  );
  trayMenu = Menu.buildFromTemplate(template); // shown via popUpContextMenu (see createTray)
}

function rememberSelectionOwner() {
  const pid = getFrontmostApplicationPid();
  if (pid && pid !== process.pid) lastExternalAppPid = pid;
}

function showTrayMenu() {
  rememberSelectionOwner();
  // Opening the fallback menu is an explicit signal that shortcuts may be
  // unhealthy, so force a native re-registration even if Electron's cached
  // isRegistered() result still says they are present.
  refreshHotkeys('tray-open');
  captureAnalytics('tray_menu_opened', {
    surface: 'tray',
    accessibility_granted: hasAccessibility(),
    ...shortcutAnalyticsProperties(shortcutStatus),
  });
  updateTrayMenu();
  if (tray && trayMenu) tray.popUpContextMenu(trayMenu);
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
  // Remember the selection-owning app before a native menu interaction can
  // affect macOS's notion of the frontmost application.
  if (process.platform === 'darwin') {
    tray.on('mouse-down', rememberSelectionOwner);
  }
  // We drive the menu manually (not setContextMenu) so a left-click can toggle
  // the panel in menu-bar mode instead of always opening the menu.
  tray.on('click', () => {
    if (state.overlayMode === 'menubar') toggleOverlayPanel();
    else showTrayMenu();
  });
  tray.on('right-click', showTrayMenu);
}

// ---- IPC: settings window <-> main --------------------------------------

ipcMain.handle('settings:get', () => ({
  voiceId: state.voiceId,
  voiceName: state.voiceName,
  speed: state.speed,
  stability: state.stability,
  apiKeyPresent: !!effectiveKey(),
  fishKeyPresent: !!effectiveFishKey(),
  fishServiceAvailable: !!state.serviceToken,
  model: config.modelId,
  speedSupported: true, // speed is now client-side playbackRate — works on every model
  hotkey: state.hotkey,
  hotkey2: state.hotkey2 || '',
  pauseMusic: state.pauseMusic,
  fontSize: state.fontSize,
  theme: state.theme,
  overlayMode: state.overlayMode,
  openAtLogin: getOpenAtLogin(),
}));

ipcMain.on('settings:setOverlayMode', (_e, { mode, source = 'preferences' }) => {
  state.overlayMode = mode === 'menubar' ? 'menubar' : 'floating';
  persist();
  captureAnalytics('setting_changed', {
    surface: source,
    setting_name: 'overlay_mode',
    setting_value: state.overlayMode,
    overlay_mode: state.overlayMode,
  });
  // re-place an open overlay to match the new mode
  if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) positionOverlayForMode();
});

// ---- launch at login -----------------------------------------------------
function getOpenAtLogin() {
  try { return !!app.getLoginItemSettings().openAtLogin; } catch { return false; }
}
function setOpenAtLogin(value) {
  try { app.setLoginItemSettings({ openAtLogin: !!value }); } catch { /* ignore */ }
  return getOpenAtLogin();
}
ipcMain.handle('settings:setOpenAtLogin', (_e, { value, source = 'preferences' }) => {
  const openAtLogin = setOpenAtLogin(value);
  captureAnalytics('setting_changed', {
    surface: source,
    setting_name: 'open_at_login',
    enabled: openAtLogin,
  });
  return { openAtLogin };
});

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
  captureAnalytics('billing_opened', { surface: 'preferences', account_mode: accountMode() });
  shell.openExternal(`${config.serviceBaseUrl || 'https://tristr-flow.onrender.com'}/account`);
  return { ok: true };
});

ipcMain.handle('account:login', async (_e, { email, password, source = 'preferences' }) => {
  try {
    const r = await svc.login({ baseUrl: config.serviceBaseUrl, email, password });
    state.serviceToken = r.apiToken;
    state.serviceEmail = r.email;
    state.onboarded = true;
    persist();
    updateTrayMenu();
    captureAnalytics('account_action_completed', {
      action: 'login',
      outcome: 'success',
      account_mode: accountMode(),
      surface: source,
    });
    return { ok: true, email: r.email, creditsMicros: r.creditsMicros };
  } catch (e) {
    captureAnalytics('account_action_completed', {
      action: 'login',
      outcome: 'failed',
      surface: source,
      error_name: e && e.name ? e.name : 'Error',
    });
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('account:signup', async (_e, { email, password, source = 'preferences' }) => {
  try {
    const r = await svc.signup({ baseUrl: config.serviceBaseUrl, email, password });
    state.serviceToken = r.apiToken;
    state.serviceEmail = r.email;
    state.onboarded = true;
    persist();
    updateTrayMenu();
    captureAnalytics('account_action_completed', {
      action: 'signup',
      outcome: 'success',
      account_mode: accountMode(),
      surface: source,
    });
    return { ok: true, email: r.email, creditsMicros: r.creditsMicros };
  } catch (e) {
    captureAnalytics('account_action_completed', {
      action: 'signup',
      outcome: 'failed',
      surface: source,
      error_name: e && e.name ? e.name : 'Error',
    });
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('account:logout', () => {
  state.serviceToken = '';
  state.serviceEmail = '';
  persist();
  updateTrayMenu();
  captureAnalytics('account_action_completed', {
    action: 'logout',
    outcome: 'success',
    account_mode: accountMode(),
    surface: 'preferences',
  });
  return { ok: true };
});

// Onboarding starts with the curated ElevenLabs voices, then refreshes after
// authentication so account-backed Fish voices are available immediately.
ipcMain.handle('voices:curated', () => availableVoices());

ipcMain.on('onboarding:finish', () => {
  state.onboarded = true;
  persist();
  updateTrayMenu();
  captureAnalytics('onboarding_completed', {
    surface: 'onboarding',
    account_mode: accountMode(),
  });
  if (onboardingWin && !onboardingWin.isDestroyed()) onboardingWin.close();
});

// Lets a user run in direct mode with their own ElevenLabs key (no login),
// without editing .env. Empty string clears it (falls back to env key if any).
// Fish Audio key. Kept separate from the ElevenLabs own-key: a user can have
// one, both, or neither. A local key is a direct-provider override; without it,
// signed-in users use the service's Fish account.
ipcMain.handle('account:setFishKey', (_e, { key, source = 'preferences' }) => {
  state.fishKey = String(key || '').trim();
  if (state.fishKey) state.onboarded = true;
  persist();
  updateTrayMenu();
  captureAnalytics('account_action_completed', {
    action: 'set_fish_key',
    outcome: 'success',
    account_mode: accountMode(),
    surface: source,
    setting_value: state.fishKey ? 'configured' : 'cleared',
  });
  // voices.js keys its Fish cache on the key value, so the next listVoices()
  // refetches on its own.
  return {
    ok: true,
    present: !!effectiveFishKey(),
    serviceAvailable: !!state.serviceToken,
  };
});

ipcMain.handle('account:setOwnKey', (_e, { key, source = 'preferences' }) => {
  state.ownKey = (key || '').trim();
  state.onboarded = true;
  persist();
  updateTrayMenu();
  captureAnalytics('account_action_completed', {
    action: 'set_elevenlabs_key',
    outcome: 'success',
    account_mode: accountMode(),
    surface: source,
    setting_value: state.ownKey ? 'configured' : 'cleared',
  });
  return { ok: true, hasOwnKey: !!effectiveKey(), mode: accountMode() };
});

ipcMain.on('settings:setTheme', (_e, { theme, source = 'preferences' }) => {
  state.theme = cleanTheme(theme);
  persist();
  nativeTheme.themeSource = state.theme; // live-updates overlay + settings prefers-color-scheme
  captureAnalytics('setting_changed', {
    surface: source,
    setting_name: 'theme',
    setting_value: state.theme,
  });
});

ipcMain.on('settings:setFontSize', (_e, { fontSize, source = 'preferences' }) => {
  state.fontSize = clampFont(fontSize);
  persist();
  // live-apply to an open overlay
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('overlay:fontSize', { fontSize: state.fontSize });
  }
  captureAnalytics('setting_changed', {
    surface: source,
    setting_name: 'font_size',
    font_size: state.fontSize,
  });
});

ipcMain.on('settings:setPauseMusic', (_e, { value, source = 'preferences' }) => {
  state.pauseMusic = !!value;
  persist();
  updateTrayMenu();
  captureAnalytics('setting_changed', {
    surface: source,
    setting_name: 'pause_music',
    enabled: state.pauseMusic,
  });
});

// Set/clear a global trigger (which = 1 primary, 2 secondary). Validates by
// actually registering; reverts and reports on conflict/invalid combo.
ipcMain.handle('settings:setHotkey', (_e, { which, accel, source = 'preferences' }) => {
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
    captureAnalytics('setting_changed', {
      surface: source,
      setting_name: which === 2 ? 'hotkey_secondary' : 'hotkey_primary',
      shortcut_slot: which === 2 ? 2 : 1,
      outcome: 'failed',
    });
    return { ok: false, hotkey: state.hotkey, hotkey2: state.hotkey2 || '', error: `“${hotkeyLabel(accel)}” is unavailable (in use or invalid).` };
  }
  persist();
  updateTrayMenu();
  captureAnalytics('setting_changed', {
    surface: source,
    setting_name: which === 2 ? 'hotkey_secondary' : 'hotkey_primary',
    shortcut_slot: which === 2 ? 2 : 1,
    setting_value: accel ? 'configured' : 'cleared',
    outcome: 'success',
  });
  return { ok: true, hotkey: state.hotkey, hotkey2: state.hotkey2 || '' };
});

async function availableVoices() {
  const localVoices = await listVoices(effectiveKey(), effectiveFishKey());
  if (!state.serviceToken || effectiveFishKey()) return localVoices;
  try {
    const serviceVoices = await svc.listServiceVoices({
      baseUrl: config.serviceBaseUrl,
      token: state.serviceToken,
    });
    return mergeVoices(localVoices, serviceVoices);
  } catch (error) {
    console.warn('[voices] service catalogue unavailable:', error && error.message ? error.message : 'unknown error');
    return localVoices;
  }
}

ipcMain.handle('settings:listVoices', async (_e, { source = 'preferences' } = {}) => {
  const startedAt = Date.now();
  try {
    const voices = await availableVoices();
    captureAnalytics('voice_list_completed', {
      surface: source,
      outcome: 'success',
      voice_count: voices.length,
      duration_ms: Date.now() - startedAt,
    });
    return voices;
  } catch (error) {
    captureAnalytics('voice_list_completed', {
      surface: source,
      outcome: 'failed',
      duration_ms: Date.now() - startedAt,
      error_name: error && error.name ? error.name : 'Error',
    });
    throw error;
  }
});

ipcMain.handle('settings:preview', async (_e, { voiceId, speed, source = 'preferences' }) => {
  const startedAt = Date.now();
  const provider = isFishVoice(voiceId) ? 'fish' : 'elevenlabs';
  const route = routeForVoice(voiceId);
  const text = "Hey! This is how I sound. I'll read your selected text aloud, just like this.";
  try {
    if (route === 'service') {
      const result = await svc.serviceSynthesize({
        baseUrl: config.serviceBaseUrl,
        token: state.serviceToken,
        voiceId,
        stability: state.stability,
        text,
      });
      captureAnalytics('voice_preview_completed', {
        surface: source,
        provider,
        delivery: 'service',
        outcome: 'success',
        duration_ms: Date.now() - startedAt,
      });
      return result;
    }
    if (route === 'fish-direct') {
      const fr = await synthesizeFish({
        apiKey: effectiveFishKey(),
        voiceId,
        modelId: config.fishModelId,
        text,
      });
      captureAnalytics('voice_preview_completed', {
        surface: source,
        provider,
        delivery: 'direct',
        outcome: 'success',
        duration_ms: Date.now() - startedAt,
      });
      return { audioBase64: fr.audio_base64 };
    }
    if (route !== 'elevenlabs-direct') {
      throw new Error('Sign in to Tristr Flow or add an API key to preview this voice.');
    }
    const result = await synthesize({
      apiKey: effectiveKey(),
      voiceId,
      modelId: config.modelId,
      speed: clampSpeed(speed),
      stability: state.stability,
      text,
    });
    captureAnalytics('voice_preview_completed', {
      surface: source,
      provider,
      delivery: 'direct',
      outcome: 'success',
      duration_ms: Date.now() - startedAt,
    });
    return { audioBase64: result.audio_base64 };
  } catch (err) {
    captureAnalytics('voice_preview_completed', {
      surface: source,
      provider,
      outcome: 'failed',
      duration_ms: Date.now() - startedAt,
      error_name: err && err.name ? err.name : 'Error',
    });
    return { error: String(err.message || err) };
  }
});

ipcMain.on('settings:setVoice', (_e, { voiceId, voiceName, source = 'preferences' }) => {
  setVoice(voiceId, voiceName, source);
});

ipcMain.on('settings:setSpeed', (_e, { speed, source = 'preferences' }) => setSpeedValue(speed, source));
ipcMain.on('overlay:setSpeed', (_e, { speed }) => setSpeedValue(speed, 'overlay')); // speed control on the reading overlay

ipcMain.on('settings:setStability', (_e, { stability, source = 'preferences' }) => {
  state.stability = clampStability(stability);
  persist();
  updateTrayMenu();
  captureAnalytics('setting_changed', {
    surface: source,
    setting_name: 'stability',
    stability: state.stability,
  });
});

ipcMain.on('settings:close', () => {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
});

// Renderers can report only catalogued, schema-validated events. analytics.js
// rejects unknown names, properties, and free-form string values.
ipcMain.on('analytics:track', (_e, { event, properties } = {}) => {
  captureAnalytics(event, properties);
});

ipcMain.on('overlay:rich-ready', (_e, { gen, text, ok }) => {
  if (pendingRich && pendingRich.gen === gen) {
    pendingRich.resolve({ text, ok });
    pendingRich = null;
  }
});
ipcMain.on('overlay:started', () => {
  setTrayState('playing');
  if (!currentReading) return;
  if (!currentReading.playbackStarted) {
    currentReading.playbackStarted = true;
    captureAnalytics('reading_playback_started', {
      trigger: currentReading.trigger,
      provider: currentReading.provider,
      duration_ms: Date.now() - currentReading.startedAt,
    });
  } else {
    captureAnalytics('reading_playback_state_changed', {
      trigger: currentReading.trigger,
      playback_state: 'playing',
    });
  }
});
ipcMain.on('overlay:paused', () => {
  if (!currentReading || !currentReading.playbackStarted) return;
  captureAnalytics('reading_playback_state_changed', {
    trigger: currentReading.trigger,
    playback_state: 'paused',
  });
});
ipcMain.on('overlay:ended', () => {
  setTrayState('idle');
  resumeMusicIfNeeded();
  if (currentReading) {
    captureAnalytics('reading_playback_completed', {
      trigger: currentReading.trigger,
      provider: currentReading.provider,
      duration_ms: Date.now() - currentReading.startedAt,
    });
    currentReading = null;
  }
});
ipcMain.on('overlay:close', () => stopEverything('overlay'));
ipcMain.on('overlay:openSettings', () => openSettings('overlay'));

// ---- lifecycle -----------------------------------------------------------

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    refreshHotkeys('second-instance');
    notify('Tristr Flow is already running', 'The existing menu-bar app kept ownership of your shortcuts.');
  });
}

if (hasSingleInstanceLock) app.whenReady().then(() => {
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
    overlayMode: saved.overlayMode === 'menubar' ? 'menubar' : (config.overlayMode || 'floating'),
    // Account (service mode).
    serviceToken: saved.serviceToken || '',
    serviceEmail: saved.serviceEmail || '',
    ownKey: saved.ownKey || '',
    fishKey: saved.fishKey || '',
    // Existing users who already have a key/login are implicitly onboarded.
    onboarded:
      saved.onboarded ||
      !!(config.apiKey || saved.serviceToken || saved.ownKey),
    launchCount: saved.launchCount || 0,
    analyticsId: saved.analyticsId || randomUUID(),
  };
  state.launchCount += 1; // count this launch
  persist();
  analytics = createAnalytics({
    token: config.posthogToken,
    host: config.posthogHost,
    distinctId: state.analyticsId,
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  });
  nativeTheme.themeSource = state.theme; // 'system' follows macOS; else force light/dark

  // Keep the settings window chrome in sync when the appearance changes.
  nativeTheme.on('updated', () => {
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#211d1a' : '#faf9f6');
    }
  });

  if (app.dock) app.dock.hide();

  // Standard Edit menu so ⌘C / ⌘A / ⌘V / ⌘X work in every window (needed for
  // selecting + copying the read-aloud text in the overlay).
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]));

  createOverlay();
  const reg = registerHotkeys();
  createTray();
  // Localhost bridge for the Chrome extension's in-page highlighting.
  try {
    localserver.start({
      getConfig: () => config,
      getState: () => state,
      captureAnalytics,
    });
  } catch (e) {
    console.error('[localserver] failed to start:', e);
  }

  if (!reg.h1) {
    notify('Hotkey registration failed', `Could not register ${hotkeyLabel(state.hotkey)}. It may be in use by another app.`);
  }
  if (state.hotkey2 && !reg.h2) {
    notify('Second hotkey failed', `Could not register ${hotkeyLabel(state.hotkey2)}.`);
  }
  captureAnalytics('app_launched', {
    accessibility_granted: hasAccessibility(),
    account_mode: accountMode(),
    onboarded: state.onboarded,
    open_at_login_enabled: getOpenAtLogin(),
    launch_count: state.launchCount,
    overlay_mode: state.overlayMode,
    ...shortcutAnalyticsProperties(shortcutStatus),
  });

  // macOS can drop global registrations across sleep/unlock, and an accelerator
  // conflict can disappear while this app stays open. Recover without a restart.
  shortcutHealthTimer = setInterval(() => repairHotkeys('periodic'), 30000);
  const repairAfterSystemTransition = (source) => {
    setTimeout(() => refreshHotkeys(source), 1000);
  };
  powerMonitor.on('resume', () => repairAfterSystemTransition('resume'));
  powerMonitor.on('unlock-screen', () => repairAfterSystemTransition('unlock-screen'));

  // First run: welcome + setup. Existing users (env key / saved login / own key)
  // are already marked onboarded above and skip straight in.
  if (!state.onboarded) {
    openOnboarding('system');
  } else if (!canSpeak()) {
    notify(
      'Tristr Flow needs setup',
      'Open the menu-bar icon ▸ Setup to sign in or add your ElevenLabs key.'
    );
  }
  if (!hasAccessibility()) {
    systemPreferences.isTrustedAccessibilityClient(true);
  }

  // Nudge to open-at-login on launches 1/3/8 (onboarding already asks new users,
  // so only nudge those who finished it). Short delay so the app settles first.
  if (state.onboarded) setTimeout(() => maybePromptOpenAtLogin(), 1500);

  // Check for a newer release shortly after launch, then periodically.
  setTimeout(() => checkUpdates(), 8000);
  setInterval(() => checkUpdates(), 6 * 60 * 60 * 1000);
});

app.on('will-quit', () => {
  if (shortcutHealthTimer) clearInterval(shortcutHealthTimer);
  if (shortcutManager) shortcutManager.dispose();
  else globalShortcut.unregisterAll();
});

// Give the final small analytics batch a bounded chance to flush so a recently
// recorded event is not dropped on a fast exit.
app.on('before-quit', (event) => {
  if (!appQuitCaptured) {
    appQuitCaptured = true;
    captureAnalytics('app_quit', {
      account_mode: state ? accountMode() : 'unconfigured',
    });
  }
  if (!analytics || !analytics.enabled || analyticsShutdownComplete) return;
  event.preventDefault();
  if (analyticsShutdownStarted) return;
  analyticsShutdownStarted = true;
  Promise.race([
    analytics.shutdown(),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]).finally(() => {
    analyticsShutdownComplete = true;
    app.quit();
  });
});

app.on('window-all-closed', (e) => {
  if (process.platform === 'darwin') e.preventDefault();
});
