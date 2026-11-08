import Foundation

/// The service streams MP3. Both playback and timeline measurements use decoded
/// samples at the requested rate. Tests can supply exact synthetic PCM samples.
enum StreamFormat: Equatable, Sendable {
    case pcm(sampleRate: Int)
    case mp3(sampleRate: Int, kbps: Int)

    var sampleRate: Double {
        switch self {
        case .pcm(let rate), .mp3(let rate, _): return Double(rate)
        }
    }
}
