'use strict';

const isDenied = (status) => status === 'denied' || status === 'capture-denied';

async function repairAccessibility({ installed, check, confirm, reset, requestAgain }) {
  if (!installed) return { ok: false, error: 'Open Tristr Flow from Applications to repair its permission.' };
  const status = await check();
  if (!isDenied(status) || !await confirm()) return { ok: true, status };
  const current = await check();
  if (!isDenied(current)) return { ok: true, status: current };
  try {
    await reset('/usr/bin/tccutil', ['reset', 'Accessibility', 'ai.pazi.tristrflow']);
    return { ok: true, status: await requestAgain() };
  } catch {
    return { ok: false, error: 'In Accessibility settings, remove the old Tristr Flow entry, then use + to add Tristr Flow from Applications and turn it on.' };
  }
}
module.exports = { repairAccessibility };
