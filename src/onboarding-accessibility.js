'use strict';

{
  const api = window.onb;
  const card = document.getElementById('accessCard');
  const status = document.getElementById('accessStatus');
  const message = document.getElementById('accessMessage');
  const settings = document.getElementById('btnAccessSettings');
  const retry = document.getElementById('btnRetryAccess');
  const recovery = document.getElementById('accessRecovery');
  const repair = document.getElementById('btnRepairAccess');
  const descriptions = {
    unknown: 'Checking Accessibility permission…',
    denied: 'Turn on Tristr Flow in Accessibility Settings to read text selected in other apps.',
    'capture-denied': 'macOS still blocks reading selected text. Check that the installed copy of Tristr Flow is enabled in Accessibility Settings.',
    unavailable: 'Couldn’t check access to selected text. You can keep using setup and check again.',
    granted: 'Accessibility granted. Your shortcut can now read selected text.',
  };

  let revision = 0;
  let actionPending = false;

  function show(value) {
    const state = Object.hasOwn(descriptions, value) ? value : 'unavailable';
    const denied = state === 'denied' || state === 'capture-denied';
    card.dataset.status = state;
    if (status.textContent !== descriptions[state]) status.textContent = descriptions[state];
    settings.hidden = recovery.hidden = !denied;
    if (!denied) recovery.open = false;
    retry.hidden = state !== 'unavailable';
    if (state === 'granted') message.textContent = '';
  }

  async function check() {
    const current = ++revision;
    try {
      const value = await api.accessibility();
      if (current === revision) show(value);
    } catch {
      if (current === revision) show('unavailable');
    }
  }

  async function changeAccess(shouldRepair) {
    if (actionPending || recovery.hidden) return;
    actionPending = true;
    settings.disabled = repair.disabled = true;
    message.textContent = '';
    const current = ++revision;
    try {
      if (shouldRepair) {
        const result = await api.repairAccessibility();
        if (result.status && current === revision) show(result.status);
        if (result.error && card.dataset.status !== 'granted') message.textContent = result.error;
      } else {
        const value = await api.openAccessibility();
        if (current === revision) show(value);
      }
    } catch {
      if (card.dataset.status !== 'granted') {
        message.textContent = shouldRepair
          ? 'Couldn’t repair the permission. In Accessibility Settings, remove Tristr Flow and add the copy from Applications.'
          : 'Open System Settings, then Privacy & Security, then Accessibility.';
      }
    } finally {
      actionPending = false;
      settings.disabled = repair.disabled = false;
    }
  }

  const unsubscribe = api.onAccessibilityChanged((value) => {
    ++revision;
    show(value);
  });
  settings.addEventListener('click', () => changeAccess(false));
  repair.addEventListener('click', () => changeAccess(true));
  retry.addEventListener('click', check);
  window.addEventListener('onboarding-setup-opened', check);
  window.addEventListener('focus', check);
  window.addEventListener('pagehide', unsubscribe, { once: true });
  check();
}
