import SwiftUI

struct SettingsView: View {
    @Environment(AppSettings.self) private var settings
    @Environment(ReadingSession.self) private var session
    @Environment(AccountSession.self) private var account
    @Environment(\.dismiss) private var dismiss

    @State private var catalogueFailed = false
    @State private var accountVoices: [Voice] = []
    @State private var previewer = VoicePreviewer()

    var body: some View {
        @Bindable var settings = settings
        NavigationStack {
            Form {
                Section("Account") {
                    if let email = account.email { LabeledContent("Signed in as", value: email) }
                    Button("Sign out") {
                        previewer.stop()
                        session.stop()
                        account.signOut()
                        dismiss()
                    }
                    .accessibilityIdentifier("signOut")
                }

                if !settings.voiceID.hasPrefix("fish:") {
                    Section("Delivery") {
                        Picker("Delivery", selection: $settings.stability) {
                            ForEach(AppSettings.stabilities, id: \.value) { Text($0.label).tag($0.value) }
                        }
                        .pickerStyle(.segmented)
                    }
                }
                Section("Reading") {
                    VStack(alignment: .leading) {
                        HStack {
                            Text("Text size")
                            Spacer()
                            Text("\(Int(settings.fontSize)) pt").foregroundStyle(.secondary).monospacedDigit()
                        }
                        Slider(value: $settings.fontSize, in: 15...32, step: 1,
                               onEditingChanged: settings.fontSizeEditingChanged)
                    }
                }
                Section {
                    ForEach(voices) { voice in
                        VoiceRow(voice: voice,
                                 selected: voice.id == settings.voiceID,
                                 loading: previewer.loadingID == voice.id,
                                 playing: previewer.playingID == voice.id) {
                            settings.voiceID = voice.id
                            settings.voiceName = voice.name
                        } onPreview: {
                            guard let token = account.token else { return }
                            if session.phase == .preparing { session.togglePlay() } else { session.pause() }
                            previewer.toggle(voice, token: token, analytics: settings.analytics) { account.invalidate(token: $0) }
                        }
                    }
                } header: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Voice")
                        Text("Voice previews use your account credits.")
                            .font(.footnote)
                            .textCase(nil)
                    }
                } footer: {
                    if let error = previewer.error { Text(error).foregroundStyle(.red) }
                    if catalogueFailed { Text("Other voices could not be loaded. Reopen Settings to try again.") }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.accessibilityIdentifier("done")
                }
            }
            .task(id: account.token) { await loadVoices() }
            .onDisappear {
                previewer.stop()
                settings.fontSizeEditingChanged(false)
            }
        }
    }

    private func loadVoices() async {
        accountVoices = []
        catalogueFailed = false
        guard let token = account.token else { return }
        do {
            let result = try await ServiceClient().voices(token: token)
            guard !Task.isCancelled, account.token == token else {
                settings.analytics.capture(.voiceList(.cancelled, count: 0))
                return
            }
            accountVoices = result
            settings.analytics.capture(.voiceList(.success, count: voices.count))
        } catch {
            guard !Task.isCancelled, account.token == token else {
                settings.analytics.capture(.voiceList(.cancelled, count: 0))
                return
            }
            settings.analytics.capture(.voiceList(.failed, count: 0))
            if let serviceError = error as? ServiceError, case .unauthorized = serviceError {
                account.invalidate(token: token)
            } else {
                catalogueFailed = true
            }
        }
    }

    /// Combine built-in reading voices with the catalogue available to this account.
    private var voices: [Voice] {
        let curated = Set(Voice.curated.map(\.id))
        var list = Voice.curated + accountVoices.filter { !curated.contains($0.id) }
        // A voice picked earlier that isn't in either list still shows (and stays selected).
        if !list.contains(where: { $0.id == settings.voiceID }) {
            list.insert(Voice(id: settings.voiceID, name: settings.voiceName, detail: ""), at: 0)
        }
        return list
    }
}

private struct VoiceRow: View {
    let voice: Voice
    let selected: Bool
    let loading: Bool
    let playing: Bool
    let onSelect: () -> Void
    let onPreview: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(selected ? Theme.accent : .secondary)
                .font(.title3)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(voice.name).font(.body.weight(.medium)).lineLimit(1)
                    if let tag = voice.tag {
                        Text(tag.uppercased())
                            .font(.caption2.weight(.bold))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Capsule().fill(Theme.accent))
                            .foregroundStyle(.white)
                    }
                }
                if !voice.detail.isEmpty {
                    Text(voice.detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            Button(action: onPreview) {
                Group {
                    if loading { ProgressView() } else { Image(systemName: playing ? "stop.fill" : "play.fill") }
                }
                .frame(width: 32, height: 32)
                .background(Circle().fill(Color(.secondarySystemFill)))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(playing ? "Stop preview" : "Preview \(voice.name)")
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: onSelect)
    }
}
