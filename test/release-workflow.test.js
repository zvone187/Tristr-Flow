'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('release metadata is bumped consistently to 0.1.2', () => {
  const pkg = require('../package.json');
  const lock = require('../package-lock.json');
  assert.equal(pkg.version, '0.1.2');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.build.artifactName, 'Tristr-Flow-${version}-${arch}.${ext}');
  assert.equal(pkg.build.afterPack, 'scripts/after-pack.js');
});

test('unsigned macOS releases receive a complete ad-hoc bundle signature', () => {
  const hook = fs.readFileSync(path.join(root, 'scripts/after-pack.js'), 'utf8');
  assert.match(hook, /electronPlatformName !== 'darwin'/);
  assert.match(hook, /codesign/);
  assert.match(hook, /'--deep'/);
  assert.match(hook, /'--sign', '-'/);
});

test('hardened releases preserve Electron runtime and media automation entitlements', () => {
  const pkg = require('../package.json');
  assert.equal(typeof pkg.build.mac.entitlements, 'string');
  const entitlements = fs.readFileSync(path.join(root, pkg.build.mac.entitlements), 'utf8');
  for (const key of [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation',
    'com.apple.security.automation.apple-events',
  ]) {
    assert.ok(entitlements.includes(`<key>${key}</key>\n    <true/>`), `Missing entitlement: ${key}`);
  }
});

test('tagged releases validate before publishing the arm64 macOS app', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /push:\s*\n\s+tags:\s*\n\s+- ['"]v\*['"]/);
  assert.match(workflow, /permissions:\s*\n\s+contents: write/);
  assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.match(workflow, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  assert.match(workflow, /node-version: ['"]24['"]/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run lint/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /electron-builder --mac --arm64 --publish never/);
  assert.match(workflow, /gh release (?:create|upload)/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(workflow, /GITHUB_REF_NAME/);
});

test('production releases require Developer ID signing and Apple notarization', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');

  assert.match(workflow, /CSC_LINK: \$\{\{ secrets\.MAC_CSC_LINK \}\}/);
  assert.match(workflow, /CSC_KEY_PASSWORD: \$\{\{ secrets\.MAC_CSC_KEY_PASSWORD \}\}/);
  assert.match(workflow, /APPLE_API_KEY_BASE64: \$\{\{ secrets\.APPLE_API_KEY_BASE64 \}\}/);
  assert.match(workflow, /APPLE_API_KEY_ID: \$\{\{ secrets\.APPLE_API_KEY_ID \}\}/);
  assert.match(workflow, /APPLE_API_ISSUER: \$\{\{ secrets\.APPLE_API_ISSUER \}\}/);
  assert.match(workflow, /APPLE_API_KEY: \$\{\{ runner\.temp \}\}\/AuthKey_\$\{\{ secrets\.APPLE_API_KEY_ID \}\}\.p8/);
  assert.match(workflow, /--config\.mac\.hardenedRuntime=true/);
  assert.match(workflow, /--config\.forceCodeSigning=true/);
  assert.match(workflow, /codesign --verify --deep --strict/);
  assert.match(workflow, /spctl --assess --type execute/);
  assert.match(workflow, /xcrun stapler validate/);
});
