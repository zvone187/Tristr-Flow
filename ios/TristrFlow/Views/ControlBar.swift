import SwiftUI

/// Progress, times, play/pause and the ‹ speed › stepper under the text.
struct ControlBar: View {
    @Environment(ReadingSession.self) private var session
    @Environment(AppSettings.self) private var settings

    var body: some View {
        VStack(spacing: 10) {
            ProgressView(value: min(session.currentTime, total), total: total)
                .tint(Theme.accent)
                .accessibilityHidden(true)

            HStack {
                Text(Self.clock(session.currentTime))
                    .accessibilityIdentifier("currentTime")
                    .accessibilityValue(String(format: "%.2f", session.currentTime))
                Spacer()
                Text(status)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .accessibilityIdentifier("status")
                Spacer()
                // "+" while more audio is still streaming in.
                Text(Self.clock(session.duration) + (session.isComplete ? "" : "+"))
                    .accessibilityIdentifier("duration")
                    .accessibilityValue(session.isComplete ? "complete" : "streaming")
            }
            .font(.footnote.monospacedDigit())

            HStack {
                SpeedControl(speed: session.speed) { value in
                    session.setSpeed(value)
                    settings.speed = value
                }
                Spacer()
                playButton
                Spacer()
                SpeedControl.placeholder // keeps the play button centred
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 6)
        .background(.bar)
    }

    private var total: Double { max(session.duration, 0.01) }

    private var playButton: some View {
        Button {
            session.togglePlay()
        } label: {
            ZStack {
                Circle().fill(Theme.accent)
                if session.phase == .preparing {
                    ProgressView().tint(.white)
                } else {
                    Image(systemName: session.phase == .playing ? "pause.fill" : "play.fill")
                        .font(.system(size: 24, weight: .bold))
                        .foregroundStyle(.white)
                        .offset(x: session.phase == .playing ? 0 : 2)
                }
            }
            .frame(width: 64, height: 64)
            .shadow(color: .black.opacity(0.18), radius: 8, y: 4)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("playPause")
        .accessibilityLabel(session.phase == .playing ? "Pause" : "Play")
    }

    private var status: String {
        if let notice = session.notice { return notice }
        if session.isBuffering { return "Buffering…" }
        switch session.phase {
        case .preparing: return "Preparing…"
        case .playing:
            let curated = Voice.curated.first { $0.id == settings.voiceID }
            return curated?.name.components(separatedBy: ", ").first ?? settings.voiceName
        case .paused: return "Paused"
        case .finished: return "Done. Tap a word to replay."
        default: return ""
        }
    }

    static func clock(_ seconds: Double) -> String {
        let s = max(0, Int(seconds.rounded(.down)))
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

/// The playback speeds match the desktop reader.
struct SpeedControl: View {
    let speed: Double
    let onChange: (Double) -> Void

    private let steps = AppSettings.speedSteps
    private var index: Int {
        steps.enumerated().min(by: { abs($0.element - speed) < abs($1.element - speed) })?.offset ?? 1
    }

    var body: some View {
        HStack(spacing: 0) {
            Button { onChange(steps[max(0, index - 1)]) } label: {
                Image(systemName: "chevron.left").frame(width: 34, height: 34)
            }
            .disabled(index == 0)
            .accessibilityLabel("Slower")
            .accessibilityIdentifier("slower")

            Text(Self.label(speed))
                .font(.subheadline.weight(.semibold).monospacedDigit())
                .frame(minWidth: 50)
                .accessibilityIdentifier("speed")

            Button { onChange(steps[min(steps.count - 1, index + 1)]) } label: {
                Image(systemName: "chevron.right").frame(width: 34, height: 34)
            }
            .disabled(index == steps.count - 1)
            .accessibilityLabel("Faster")
            .accessibilityIdentifier("faster")
        }
        .background(Capsule().fill(Color(.secondarySystemFill)))
    }

    static var placeholder: some View { Color.clear.frame(width: 118, height: 34) }

    static func label(_ speed: Double) -> String { String(format: "%g×", speed) }
}
