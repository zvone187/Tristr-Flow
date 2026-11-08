import MediaPlayer

/// Lock-screen / Control Center title and play-pause, so a read can be paused
/// without unlocking the phone.
@MainActor
final class NowPlaying {
    var onPlay: (() -> Void)?
    var onPause: (() -> Void)?
    var onToggle: (() -> Void)?

    private var title = ""
    private var artist = ""
    private var commandsConfigured = false

    func begin(title: String, artist: String) {
        self.title = title
        self.artist = artist
        guard !commandsConfigured else { return }
        commandsConfigured = true
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.onPlay?() }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.onPause?() }
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.onToggle?() }
            return .success
        }
    }

    func update(elapsed: Double, duration: Double, rate: Double, playing: Bool) {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: artist,
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? rate : 0,
        ]
    }

    func clear() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }
}
