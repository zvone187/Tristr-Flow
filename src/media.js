'use strict';

// Pauses whatever is playing while the app reads, then resumes it — WITHOUT
// muting system output (that would mute our own speech) and WITHOUT starting
// music that wasn't already playing.
//
// Primary: the bundled `mediactl` helper drives macOS "Now Playing"
// (MediaRemote) — the same thing the physical play/pause key controls. It
// covers Spotify, Apple Music, browser tabs (YouTube, etc.) and any other
// source, and pauses/resumes precisely (not a blind toggle). If the helper is
// missing it falls back to per-app AppleScript for Spotify/Apple Music.

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

function helperPath() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bin', 'mediactl'));
  candidates.push(path.join(__dirname, '..', 'bin', 'mediactl'));
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

// Returns the helper's stdout (trimmed) or null if it's unavailable / errored.
function runHelper(arg, timeout = 3000) {
  return new Promise((resolve) => {
    const bin = helperPath();
    if (!bin) return resolve(null);
    execFile(bin, [arg], { timeout }, (err, out) => resolve(err ? null : String(out).trim()));
  });
}

// ---- AppleScript fallback (Spotify / Apple Music only) -------------------
const MEDIA_APPS = ['Spotify', 'Music'];
function osa(script) {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 2500 }, (err, out) =>
      resolve(err ? '' : String(out).trim())
    );
  });
}
async function runningMediaApps() {
  const out = await osa('tell application "System Events" to return name of every process');
  const procs = out.split(',').map((s) => s.trim());
  return MEDIA_APPS.filter((a) => procs.includes(a));
}
async function pauseAppsIfPlaying() {
  const paused = [];
  for (const app of await runningMediaApps()) {
    const r = await osa(
      `tell application "${app}"\n  if player state is playing then\n    pause\n    return "yes"\n  end if\nend tell\nreturn "no"`
    );
    if (r === 'yes') paused.push(app);
  }
  return paused;
}

// Pause; returns an opaque token describing what we paused (or null if nothing
// was playing). Pass the token to resumeMusic() to undo exactly that.
async function pauseMusic() {
  if (process.platform !== 'darwin') return null;

  const status = await runHelper('status');
  if (status === 'playing') {
    const ok = await runHelper('pause');
    return ok === 'ok' ? { via: 'nowplaying' } : null;
  }
  if (status === 'paused') {
    return null; // Now-Playing reports nothing is playing — nothing to do.
  }

  // Helper unavailable or errored (null / "unknown" / "nosym") — fall back.
  const apps = await pauseAppsIfPlaying();
  return apps.length ? { via: 'apps', apps } : null;
}

async function resumeMusic(token) {
  if (process.platform !== 'darwin' || !token) return;
  if (token.via === 'nowplaying') {
    await runHelper('play');
    return;
  }
  if (token.via === 'apps') {
    for (const app of token.apps) osa(`tell application "${app}" to play`);
  }
}

module.exports = { pauseMusic, resumeMusic };
