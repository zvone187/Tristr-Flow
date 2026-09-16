'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin' || process.env.CSC_LINK || process.env.CSC_NAME) {
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  const result = spawnSync(
    '/usr/bin/codesign',
    ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath],
    { stdio: 'inherit' }
  );

  if (result.error || result.status !== 0) {
    throw result.error || new Error(`Ad-hoc codesign failed with status ${result.status}`);
  }
};
