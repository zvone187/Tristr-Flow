'use strict';

function createAccessibilityController({
  isTrusted, probeCapture, hasPrompted, markPrompted, prompt, openSettings, onChange,
}) {
  let status = 'unknown';
  let pendingCheck = null;
  let timer = null;
  let watchUntil = 0;

  function stopWatching() {
    clearTimeout(timer);
    timer = null;
    watchUntil = 0;
  }

  async function readStatus() {
    try {
      if (!isTrusted()) return 'denied';
      // The action itself runs in an osascript child. The app switch alone
      // cannot confirm that this process will be able to read a selection.
      return await probeCapture() ? 'granted' : 'capture-denied';
    } catch {
      return 'unavailable';
    }
  }

  function check() {
    if (!pendingCheck) {
      pendingCheck = readStatus().then((next) => {
        if (next === 'granted') stopWatching();
        if (next !== status) {
          const previous = status;
          status = next;
          onChange(next, previous);
        }
        return next;
      }).finally(() => { pendingCheck = null; });
    }
    return pendingCheck;
  }

  function scheduleCheck() {
    if (timer || Date.now() >= watchUntil) return;
    timer = setTimeout(async () => {
      timer = null;
      await check();
      scheduleCheck();
    }, 1200);
    timer.unref?.();
  }

  async function request({ userInitiated = false } = {}) {
    const current = await check();
    if (current === 'granted' || current === 'unavailable') return current;
    if (current === 'denied' && !hasPrompted()) {
      markPrompted();
      prompt();
    }
    // The native prompt is asynchronous. Watch briefly while Settings has
    // focus, then return to checking on demand if the user left it disabled.
    watchUntil = Date.now() + 2 * 60 * 1000;
    scheduleCheck();
    if (userInitiated) await openSettings();
    return status;
  }

  return { status: () => status, check, request, stopWatching };
}

module.exports = { createAccessibilityController };
