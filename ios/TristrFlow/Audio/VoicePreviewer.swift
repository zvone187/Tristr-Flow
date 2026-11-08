import AVFoundation
import Observation

/// Plays a short sample of a voice from Settings.
@MainActor
@Observable
final class VoicePreviewer {
    private(set) var loadingID: String?
    private(set) var playingID: String?
    private(set) var error: String?

    @ObservationIgnored private var pendingAnalytics: (any ProductTracking)?
    @ObservationIgnored private let client: ServiceClient
    @ObservationIgnored private var player: AVAudioPlayer?
    @ObservationIgnored private var task: Task<Void, Never>?

    init(client: ServiceClient = ServiceClient()) { self.client = client }

    func toggle(_ voice: Voice, token: String, analytics: any ProductTracking, onUnauthorized: @escaping (String) -> Void) {
        let wasThis = loadingID == voice.id || playingID == voice.id
        stop()
        guard !wasThis else { return }
        loadingID = voice.id
        pendingAnalytics = analytics
        error = nil
        task = Task {
            do {
                let data = try await client.sample(voiceID: voice.id, token: token)
                try Task.checkCancellation()
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playback, mode: .spokenAudio)
                try session.setActive(true)
                let player = try AVAudioPlayer(data: data)
                self.player = player
                loadingID = nil
                playingID = voice.id
                guard player.play() else { throw ServiceError.undecodableAudio }
                finishRequest(.success)
                try await Task.sleep(for: .seconds(player.duration + 0.15))
                stop()
            } catch is CancellationError {
            } catch {
                guard !Task.isCancelled else { return }
                finishRequest(.failed)
                stop()
                if let serviceError = error as? ServiceError, case .unauthorized = serviceError {
                    onUnauthorized(token)
                } else {
                    self.error = error.localizedDescription
                }
            }
        }
    }

    // Once the preview starts playing its request is complete. Stopping the
    // audio after that point must not count the same request as cancelled.
    private func finishRequest(_ outcome: ProductEvent.Outcome) {
        pendingAnalytics?.capture(.voicePreview(outcome))
        pendingAnalytics = nil
    }

    func stop() {
        finishRequest(.cancelled)
        task?.cancel()
        task = nil
        if let player {
            player.stop()
            self.player = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        loadingID = nil
        playingID = nil
    }
}
