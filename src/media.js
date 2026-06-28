'use strict';

// Pauses currently-playing music (Spotify / Apple Music) while the app reads,
// and resumes exactly what we paused afterward. We pause per-app by checking
// player state (rather than the media Play/Pause key, which is a toggle that
// would *start* music if nothing was playing).
//
// IMPORTANT: AppleScript compiles every `tell application "X"` block up front,
// so referencing an app that isn't installed fails the whole script. We avoid
// that by first listing running processes, then issuing a SEPARATE osascript
// per running app — so an uninstalled app's terms are never compiled.

const { execFile } = require('child_process');

const MEDIA_APPS = ['Spotify', 'Music'];

function osa(script, cb) {
  execFile('/usr/bin/osascript', ['-e', script], { timeout: 2500 }, cb);
}

function runningMediaApps() {
  return new Promise((resolve) => {
    osa('tell application "System Events" to return name of every process', (err, out) => {
      if (err) return resolve([]);
      const procs = String(out).split(',').map((s) => s.trim());
      resolve(MEDIA_APPS.filter((a) => procs.includes(a)));
    });
  });
}

function pauseIfPlaying(app) {
  return new Promise((resolve) => {
    const script = `tell application "${app}"
  if player state is playing then
    pause
    return "yes"
  end if
end tell
return "no"`;
    osa(script, (err, out) => resolve(!err && String(out).trim() === 'yes'));
  });
}

// Returns Promise<string[]> of the apps we actually paused.
async function pauseMusic() {
  if (process.platform !== 'darwin') return [];
  const running = await runningMediaApps();
  const paused = [];
  for (const app of running) {
    try { if (await pauseIfPlaying(app)) paused.push(app); } catch { /* ignore */ }
  }
  return paused;
}

function resumeMusic(apps) {
  if (process.platform !== 'darwin' || !apps || !apps.length) return;
  for (const app of apps) {
    osa(`tell application "${app}" to play`, () => {});
  }
}

module.exports = { pauseMusic, resumeMusic };
