'use strict';

function createShortcutManager({ globalShortcut, onShortcut }) {
  let primary = '';
  let secondary = '';

  function normalize(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function isRegistered(accelerator) {
    if (!accelerator) return false;
    try {
      return !!globalShortcut.isRegistered(accelerator);
    } catch {
      return false;
    }
  }

  function slot(accelerator) {
    return {
      accelerator,
      configured: !!accelerator,
      registered: isRegistered(accelerator),
    };
  }

  function status() {
    const primaryStatus = slot(primary);
    const secondaryStatus = slot(secondary);
    const configured = [primaryStatus, secondaryStatus].filter((item) => item.configured);
    const registered = configured.filter((item) => item.registered);
    return {
      primary: primaryStatus,
      secondary: secondaryStatus,
      allRegistered: configured.length > 0 && registered.length === configured.length,
      anyRegistered: registered.length > 0,
    };
  }

  function tryRegister(accelerator) {
    if (!accelerator) return false;
    try {
      return !!globalShortcut.register(accelerator, onShortcut);
    } catch {
      return false;
    }
  }

  function registerAll(primaryAccelerator, secondaryAccelerator) {
    primary = normalize(primaryAccelerator);
    const candidateSecondary = normalize(secondaryAccelerator);
    secondary = candidateSecondary && candidateSecondary !== primary ? candidateSecondary : '';
    globalShortcut.unregisterAll();
    tryRegister(primary);
    tryRegister(secondary);
    return status();
  }

  function repair() {
    const before = status();
    const recovered = [];
    for (const item of [before.primary, before.secondary]) {
      if (!item.configured || item.registered) continue;
      if (tryRegister(item.accelerator) && isRegistered(item.accelerator)) {
        recovered.push(item.accelerator);
      }
    }
    return { recovered, status: status() };
  }

  // Re-register even when Electron still reports a shortcut as present. This
  // repairs stale native registrations after macOS sleep/unlock transitions.
  function refreshAll() {
    return registerAll(primary, secondary);
  }

  function dispose() {
    globalShortcut.unregisterAll();
  }

  return { registerAll, repair, refreshAll, status, dispose };
}

function selectedTextMenuPresentation({ accessibilityGranted, status }) {
  if (!accessibilityGranted) {
    return {
      label: '\u26a0\ufe0f Read selected text',
      sublabel: 'Grant Accessibility to restore selection capture',
      needsAttention: true,
    };
  }

  if (!status || !status.anyRegistered) {
    return {
      label: '\u26a0\ufe0f Read selected text',
      sublabel: 'Shortcuts unavailable — use this fallback',
      needsAttention: true,
    };
  }

  if (!status.allRegistered) {
    return {
      label: '\u26a0\ufe0f Read selected text',
      sublabel: 'One shortcut is unavailable — use this fallback',
      needsAttention: true,
    };
  }

  return {
    label: '\u25b6 Read selected text',
    sublabel: 'Uses the current selection, just like the shortcut',
    needsAttention: false,
  };
}

module.exports = { createShortcutManager, selectedTextMenuPresentation };
