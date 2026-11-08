import Foundation

struct Voice: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let detail: String
    var tag: String?

    /// Built-in reading voices supported by the hosted service.
    static let curated: [Voice] = [
        Voice(id: "zGjIP4SZlMnY9m93k97r", name: "Hope, Clear, Relatable & Charismatic",
              detail: "The podcaster. Warm, conversational, easy to listen to.", tag: "Default"),
        Voice(id: "uYXf8XasLslADfZ2MB4u", name: "Hope, Your Conversational Bestie",
              detail: "Bubbly, gossipy, genuine best-friend energy."),
        Voice(id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah, Mature & Reassuring", detail: "Confident, calm, trustworthy."),
        Voice(id: "cgSgspJ2msm6clMCkdW9", name: "Jessica, Playful, Bright, Warm", detail: "Friendly and upbeat."),
        Voice(id: "FGY2WhTYpPnrIDTdsKH5", name: "Laura, Enthusiast, Quirky", detail: "Lively with attitude."),
        Voice(id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel, Calm Narration", detail: "Classic ElevenLabs voice."),
        Voice(id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily, Velvety", detail: "Smooth, expressive."),
    ]

    static let fallback = curated[0]
}
