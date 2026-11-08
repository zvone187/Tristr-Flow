'use strict';

const fs = require('node:fs');
const path = require('node:path');

function needsInstallation(app, platform = process.platform) {
  return platform === 'darwin' && app.isPackaged && !app.isInApplicationsFolder();
}

function canInstallNewCopy(executable, applications) {
  const bundleName = path.basename(path.resolve(executable, '../../..'));
  if (!bundleName.endsWith('.app')) return false;
  try {
    // Electron can skip its conflict handler when the move requires elevation.
    fs.accessSync(applications, fs.constants.W_OK | fs.constants.X_OK);
    return !fs.lstatSync(path.join(applications, bundleName), { throwIfNoEntry: false });
  } catch {
    return false;
  }
}

async function offerInstallation(app, dialog, applications = '/Applications') {
  const executable = app.getPath('exe');
  let relaunching = false;
  try {
    if (canInstallNewCopy(executable, applications)) {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        message: 'Install Tristr Flow in Applications?',
        detail: 'Tristr Flow will reopen from Applications so you can sign in and grant access to selected text.',
        buttons: ['Move to Applications', 'Quit'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) return;
      if (canInstallNewCopy(executable, applications)) {
        try {
          relaunching = app.moveToApplicationsFolder({ conflictHandler: () => false });
        } catch {
          // Finder can still install the app when the native move fails.
        }
      }
      if (relaunching) return;
    }
    await dialog.showMessageBox({
      type: 'info',
      message: 'Open Tristr Flow from Applications',
      detail: 'Quit any running copy of Tristr Flow. In Finder, drag Tristr Flow from your download into Applications, then open it there to continue setup.',
      buttons: ['Quit'],
    });
  } finally {
    if (!relaunching) app.quit();
  }
}

module.exports = { needsInstallation, offerInstallation };
