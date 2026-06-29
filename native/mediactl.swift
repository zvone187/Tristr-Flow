import Foundation

// Talks to macOS "Now Playing" (the system the physical play/pause key drives),
// so we can pause/resume ANY source (Spotify, Music, browser tab, etc.) and
// avoid starting music that wasn't playing.
let mr = dlopen("/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote", RTLD_LAZY)

typealias SendCmd = @convention(c) (Int, CFDictionary?) -> Bool
typealias GetIsPlaying = @convention(c) (DispatchQueue, @escaping (Bool) -> Void) -> Void

func sym<T>(_ name: String, _ t: T.Type) -> T? {
  guard let mr = mr, let p = dlsym(mr, name) else { return nil }
  return unsafeBitCast(p, to: T.self)
}

let arg = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "status"

switch arg {
case "pause", "play":
  guard let send = sym("MRMediaRemoteSendCommand", SendCmd.self) else { print("nosym"); exit(2) }
  let cmd = (arg == "pause") ? 1 : 0   // kMRPlay=0, kMRPause=1
  let ok = send(cmd, nil)
  print(ok ? "ok" : "fail"); exit(ok ? 0 : 1)
case "status":
  guard let getIsPlaying = sym("MRMediaRemoteGetNowPlayingApplicationIsPlaying", GetIsPlaying.self) else { print("nosym"); exit(2) }
  let sem = DispatchSemaphore(value: 0)
  var playing = false
  getIsPlaying(DispatchQueue.global()) { p in playing = p; sem.signal() }
  if sem.wait(timeout: .now() + 2) == .timedOut { print("unknown"); exit(3) }
  print(playing ? "playing" : "paused"); exit(playing ? 0 : 1)
default:
  print("usage: mediactl pause|play|status"); exit(64)
}
