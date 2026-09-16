'use strict';

// Captures the text selected in the FRONTMOST app and returns it, restoring the
// user's clipboard afterward. Returns { text, reason }.
//
// THE CHROME FIX (modifier contamination), validated by adversarial review:
//   The hotkey is Control+Option+S. When it fires the user is usually STILL
//   holding Control+Option. macOS OR-merges the live hardware modifier flags
//   into any synthetic event AT POST TIME, so a naive synthetic Cmd+C reaches
//   Chrome as Ctrl+Opt+Cmd+C. Chrome matches its Copy accelerator strictly and
//   ignores it (native/Cocoa apps like Claude are lenient — why it "worked"
//   there). Pinning flags with CGEventSetFlags alone does NOT help: the OR
//   happens after setFlags, and synthetic key-ups can't retract a held key.
//
//   So we use two modifier-immune / modifier-safe mechanisms, in order:
//     1) PRIMARY: AXPress the frontmost app's Edit > Copy menu item, located by
//        its ⌘C shortcut (cmdChar 'c' + command-only modifiers) so it's
//        localization-proof. This involves NO keystroke, so held modifiers are
//        irrelevant. Works for Chrome, Safari, and native apps.
//     2) FALLBACK: a clean Cmd+C posted to kCGSessionEventTap (which is above
//        the HID modifier-merge) AFTER actively waiting for the held modifiers
//        to clear. Covers apps with non-standard menus.
//
//   Clipboard safety (data-loss bugs found in review and fixed here):
//     - Save/restore ALL pasteboard items/types losslessly via writeObjects, so
//       a copied image/file/custom-UTI is never destroyed.
//     - Only restore if no other process wrote the clipboard after our copy
//       (concurrent clipboard-manager guard).

const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function normalizeTargetPid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

// Capture this on the tray's mouse-down event, before opening a native menu can
// make Tristr Flow itself appear frontmost. osascript stays in the background.
function getFrontmostApplicationPid() {
  if (process.platform !== 'darwin') return 0;
  try {
    const output = execFileSync(
      '/usr/bin/osascript',
      [
        '-l',
        'JavaScript',
        '-e',
        "ObjC.import('AppKit'); var a=$.NSWorkspace.sharedWorkspace.frontmostApplication; a && !a.isNil() ? String(a.processIdentifier) : '0';",
      ],
      { encoding: 'utf8', timeout: 750 }
    );
    return normalizeTargetPid(String(output).trim());
  } catch {
    return 0;
  }
}

const CAPTURE_JXA = `
ObjC.import('AppKit');
ObjC.import('Foundation');
ObjC.import('Carbon');
ObjC.import('CoreGraphics');
ObjC.import('ApplicationServices');

function sleep(s) { $.NSThread.sleepForTimeInterval(s); }

function requestedTargetApplication() {
  var envValue = $.NSProcessInfo.processInfo.environment.objectForKey('TRISTR_FLOW_TARGET_PID');
  if (envValue && !envValue.isNil()) {
    var pid = parseInt(String(ObjC.unwrap(envValue)), 10);
    if (pid > 0) {
      var requested = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
      if (requested && !requested.isNil()) return requested;
    }
  }
  return $.NSWorkspace.sharedWorkspace.frontmostApplication;
}

// --- lossless clipboard snapshot / restore -------------------------------
function snapshot(pb) {
  var saved = [];
  var items = pb.pasteboardItems;
  var n = items.count;
  for (var i = 0; i < n; i++) {
    var it = items.objectAtIndex(i);
    var types = it.types;
    var ni = $.NSPasteboardItem.alloc.init;
    var m = types.count;
    for (var j = 0; j < m; j++) {
      var t = types.objectAtIndex(j);
      var d = it.dataForType(t);
      if (d && !d.isNil()) ni.setDataForType(d, t);
    }
    saved.push(ni);
  }
  return saved;
}
function restore(pb, saved) {
  pb.clearContents;
  if (saved.length) pb.writeObjects($.NSArray.arrayWithArray($(saved)));
}

function pollChange(pb, startCount, capSeconds) {
  var t = 0, waitMs = 0.008;
  while (t < capSeconds) {
    if (Number(pb.changeCount) !== startCount) return true;
    sleep(waitMs); t += waitMs;
    if (waitMs < 0.04) waitMs += 0.008;
  }
  return Number(pb.changeCount) !== startCount;
}

// --- PRIMARY: press Edit > Copy via Accessibility (modifier-immune) -------
// Returns 'pressed' | 'disabled' | 'notfound' | 'untrusted'.
function tryAXCopy(fa) {
  if (!$.AXIsProcessTrusted()) return 'untrusted';
  if (!fa || fa.isNil()) return 'notfound';
  var app = $.AXUIElementCreateApplication(fa.processIdentifier);

  var mbRef = Ref();
  if ($.AXUIElementCopyAttributeValue(app, 'AXMenuBar', mbRef) !== 0) return 'notfound';
  var kidsRef = Ref();
  if ($.AXUIElementCopyAttributeValue(mbRef[0], 'AXChildren', kidsRef) !== 0) return 'notfound';
  var bar = kidsRef[0];
  var bn = bar.count;

  for (var i = 0; i < bn; i++) {
    var barItem = bar.objectAtIndex(i);
    var subRef = Ref();
    if ($.AXUIElementCopyAttributeValue(barItem, 'AXChildren', subRef) !== 0) continue;
    var subs = subRef[0];
    if (!subs || subs.isNil() || subs.count === 0) continue; // lazy/empty menu -> skip
    var menu = subs.objectAtIndex(0);
    var itRef = Ref();
    if ($.AXUIElementCopyAttributeValue(menu, 'AXChildren', itRef) !== 0) continue;
    var items = itRef[0];
    var mn = items.count;
    for (var j = 0; j < mn; j++) {
      var it = items.objectAtIndex(j);
      var ccRef = Ref();
      if ($.AXUIElementCopyAttributeValue(it, 'AXMenuItemCmdChar', ccRef) !== 0) continue;
      if (!ccRef[0] || ccRef[0].isNil()) continue;
      var ch = ObjC.unwrap(ccRef[0]);
      if (!ch || String(ch).toLowerCase() !== 'c') continue;
      // require command-ONLY (mods === 0); skip ⇧⌘C, ⌥⌘C, etc.
      var mods = 0;
      var mRef = Ref();
      if ($.AXUIElementCopyAttributeValue(it, 'AXMenuItemCmdModifiers', mRef) === 0 && mRef[0] && !mRef[0].isNil()) {
        mods = Number(ObjC.unwrap(mRef[0]));
      }
      if (mods !== 0) continue;
      var enabled = true;
      var eRef = Ref();
      if ($.AXUIElementCopyAttributeValue(it, 'AXEnabled', eRef) === 0 && eRef[0] && !eRef[0].isNil()) {
        enabled = ObjC.unwrap(eRef[0]);
      }
      if (!enabled) return 'disabled';
      return $.AXUIElementPerformAction(it, 'AXPress') === 0 ? 'pressed' : 'notfound';
    }
  }
  return 'notfound';
}

// --- FALLBACK: clean Cmd+C via session tap after modifiers clear ----------
function postCleanCmdC(targetApp) {
  var C = 8, CMD = 0x37;
  var CMD_FLAG = 0x100000;            // kCGEventFlagMaskCommand
  var SESSION_TAP = 1;                // kCGSessionEventTap (above HID merge)
  var HIDSTATE = 1;                   // kCGEventSourceStateHIDSystemState
  var MODBITS = 0x100000 | 0x80000 | 0x40000 | 0x20000; // cmd|opt|ctrl|shift

  // Wait (<=700ms) for the user's physically-held hotkey modifiers to release;
  // this is the decisive part — a clean Cmd+C only lands once they're gone.
  var waited = 0;
  while (waited < 0.7) {
    if ((Number($.CGEventSourceFlagsState(HIDSTATE)) & MODBITS) === 0) break;
    sleep(0.02); waited += 0.02;
  }

  // A tray-menu click can make the status app appear frontmost. The AX path
  // above can copy from an inactive app, but this keystroke fallback cannot.
  if (targetApp && !targetApp.isNil()) {
    var current = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!current || current.isNil() || Number(current.processIdentifier) !== Number(targetApp.processIdentifier)) {
      targetApp.activateWithOptions(2); // NSApplicationActivateIgnoringOtherApps
      sleep(0.08);
    }
  }

  var src = $.CGEventSourceCreate(0); // combined session state
  function post(vk, down, flags) {
    var e = $.CGEventCreateKeyboardEvent(src, vk, down);
    $.CGEventSetFlags(e, flags);
    $.CGEventPost(SESSION_TAP, e);
  }
  post(CMD, true, CMD_FLAG);
  post(C, true, CMD_FLAG);
  sleep(0.02);
  post(C, false, CMD_FLAG);
  post(CMD, false, 0);
}

function run() {
  var pb = $.NSPasteboard.generalPasteboard;
  var res = { ok: true, changed: false, text: '', html: '', source: 'none', reason: '' };
  var targetApp = requestedTargetApplication();

  if ($.IsSecureEventInputEnabled()) { res.reason = 'secure-input'; return JSON.stringify(res); }
  if (!$.AXIsProcessTrusted()) { res.reason = 'not-trusted'; return JSON.stringify(res); }

  var startCount = Number(pb.changeCount);
  var saved = snapshot(pb);

  // 1) Primary: AX menu Copy (modifier-immune). 'disabled'/'notfound' just fall
  // through to the keystroke path (AX enabled-state can be unreliable in Chrome).
  var ax = tryAXCopy(targetApp);
  if (ax === 'untrusted') { res.reason = 'not-trusted'; return JSON.stringify(res); }
  var changed = false;
  if (ax === 'pressed') {
    changed = pollChange(pb, startCount, 0.4);
    if (changed) res.source = 'ax-menu';
  }

  // 2) Fallback: clean synthetic Cmd+C.
  if (!changed) {
    postCleanCmdC(targetApp);
    changed = pollChange(pb, startCount, 0.4);
    if (changed) res.source = 'cmd-c';
  }

  if (changed) {
    var copyCount = Number(pb.changeCount);
    var s = pb.stringForType($.NSPasteboardTypeString);
    if (s && !s.isNil()) res.text = ObjC.unwrap(s);
    // Also grab the rich (HTML) flavor if the app provided one, for formatted display.
    var h = pb.dataForType($.NSPasteboardTypeHTML);
    if (h && !h.isNil()) {
      var hs = $.NSString.alloc.initWithDataEncoding(h, $.NSUTF8StringEncoding);
      if (hs && !hs.isNil()) res.html = ObjC.unwrap(hs) || '';
    }
    res.changed = true;
    // Restore only if nobody else wrote the clipboard after our copy.
    if (Number(pb.changeCount) === copyCount) restore(pb, saved);
  } else {
    res.reason = 'empty-or-nocopy';
  }
  return JSON.stringify(res);
}
`;

// Materialize the JXA script to a stable temp path (rewrite if missing).
const SCRIPT_DIR = path.join(os.tmpdir(), 'tristr-flow-jxa');
const SCRIPT_PATH = path.join(SCRIPT_DIR, 'capture.js');
function ensureScript() {
  try {
    fs.mkdirSync(SCRIPT_DIR, { recursive: true });
    fs.writeFileSync(SCRIPT_PATH, CAPTURE_JXA, 'utf8');
    return true;
  } catch (e) {
    console.error('[selection] failed to write JXA script:', e);
    return false;
  }
}
ensureScript();

let inFlight = false;

// Returns { text: string, reason: string }. text === '' means nothing captured;
// reason is one of: '', 'secure-input', 'not-trusted', 'empty-or-nocopy',
// 'capture-failed', 'busy', 'unsupported'.
function getSelectedText({ targetPid = 0 } = {}) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') {
      resolve({ text: '', html: '', reason: 'unsupported', source: 'none' });
      return;
    }
    if (inFlight) {
      resolve({ text: '', html: '', reason: 'busy', source: 'none' });
      return;
    }
    if (!fs.existsSync(SCRIPT_PATH) && !ensureScript()) {
      resolve({ text: '', html: '', reason: 'capture-failed', source: 'none' });
      return;
    }
    inFlight = true;
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', SCRIPT_PATH],
      {
        timeout: 3000,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          TRISTR_FLOW_TARGET_PID: String(normalizeTargetPid(targetPid)),
        },
      },
      (err, stdout, stderr) => {
        inFlight = false;
        if (err) {
          console.error('[selection] osascript error:', stderr || err.message);
          resolve({ text: '', html: '', reason: 'capture-failed', source: 'none' });
          return;
        }
        try {
          const r = JSON.parse(String(stdout).trim());
          resolve({
            text: (r.text || '').trim(),
            html: r.html || '',
            reason: r.reason || '',
            source: r.source || 'none',
          });
        } catch {
          resolve({ text: '', html: '', reason: 'capture-failed', source: 'none' });
        }
      }
    );
  });
}

module.exports = { getSelectedText, getFrontmostApplicationPid, normalizeTargetPid };
