import SwiftUI

/// Paste (or type) the text to read.
struct ComposeView: View {
    @Binding var draft: String
    let onRead: () -> Void
    @Environment(AppSettings.self) private var settings

    var body: some View {
        VStack(spacing: 14) {
            ZStack(alignment: .topLeading) {
                TextEditor(text: $draft)
                    .font(.system(size: 18))
                    .scrollContentBackground(.hidden)
                    .padding(10)
                    .accessibilityIdentifier("composeEditor")
                if draft.isEmpty {
                    Text("Paste or type the text you want to hear…")
                        .font(.system(size: 18))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 15)
                        .padding(.vertical, 18)
                        .allowsHitTesting(false)
                }
            }
            .background(RoundedRectangle(cornerRadius: 16).fill(Theme.surface))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.primary.opacity(0.06)))

            HStack(spacing: 12) {
                // The system paste button reads the clipboard without iOS's
                // "Allow Paste?" prompt that a plain button would trigger.
                PasteButton(payloadType: String.self) { strings in
                    let text = strings.joined(separator: "\n")
                    DispatchQueue.main.async {
                        draft = text
                        if !text.isEmpty { ProductAnalytics.shared.capture(.textPasted) }
                    }
                }
                .labelStyle(.titleAndIcon)
                .buttonBorderShape(.capsule)
                .tint(Theme.accent)
                .accessibilityIdentifier("paste")

                if !draft.isEmpty {
                    Button("Clear", role: .destructive) { draft = "" }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                }
                Spacer()
                Text(wordCount)
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            Button(action: onRead) {
                Label("Read aloud", systemImage: "play.fill")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .controlSize(.large)
            .tint(Theme.accent)
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityIdentifier("readAloud")

            VStack(spacing: 3) {
                let provider = settings.voiceID.hasPrefix("fish:") ? "Fish Audio" : "ElevenLabs"
                Text("Reading aloud sends your text to Tristr Flow and \(provider) and uses your account credits.")
                    .foregroundStyle(.secondary)
                Link("Privacy policy", destination: URL(string: "https://tristr-flow-5iy7.onrender.com/privacy")!)
            }
            .font(.footnote)
            .multilineTextAlignment(.center)
        }
        .padding()
    }

    private var wordCount: String {
        let n = draft.split(whereSeparator: { $0.isWhitespace }).count
        return n == 1 ? "1 word" : "\(n) words"
    }
}
