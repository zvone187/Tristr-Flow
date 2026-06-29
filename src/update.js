'use strict';

const https = require('https');

// Lightweight update check: asks GitHub for the latest published release of the
// (open-source) desktop repo and compares it to the running version. No silent
// install — the app just surfaces a "download" link. Works unsigned.

const REPO = process.env.SPEAK_UPDATE_REPO || 'zvone187/Tristr-Flow';

function parseVer(v) {
  return String(v || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
}

// Is version `a` strictly newer than `b`?
function isNewer(a, b) {
  const A = parseVer(a);
  const B = parseVer(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const d = (A[i] || 0) - (B[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: `/repos/${REPO}/releases/latest`,
        method: 'GET',
        headers: {
          'User-Agent': 'TristrFlow-Updater',
          Accept: 'application/vnd.github+json',
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          if (res.statusCode === 404) return resolve(null); // no releases published yet
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`GitHub ${res.statusCode}`));
          }
          try {
            const j = JSON.parse(data);
            resolve({
              version: (j.tag_name || j.name || '').replace(/^v/, ''),
              htmlUrl: j.html_url,
              notes: j.body || '',
              assets: (j.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url })),
            });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Update check timed out.')));
    req.end();
  });
}

// Returns { available:true, version, url, notes } when a newer release exists,
// else { available:false, version? }. Prefers a .dmg asset, falls back to the
// release page.
async function checkForUpdate(currentVersion) {
  const latest = await fetchLatestRelease();
  if (!latest || !latest.version) return { available: false };
  if (!isNewer(latest.version, currentVersion)) return { available: false, version: latest.version };
  const dmg = (latest.assets || []).find((a) => /\.dmg$/i.test(a.name));
  return {
    available: true,
    version: latest.version,
    url: (dmg && dmg.url) || latest.htmlUrl,
    notes: latest.notes,
  };
}

module.exports = { checkForUpdate, isNewer };
