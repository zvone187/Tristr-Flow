import Foundation

/// Per-character timing sent alongside speech audio. One element per
/// Unicode code point of the request text, with times in seconds from the start
/// of that request's audio.
struct Alignment: Decodable, Equatable, Sendable {
    let characters: [String]
    let characterStartTimesSeconds: [Double]
    let characterEndTimesSeconds: [Double]

    enum CodingKeys: String, CodingKey {
        case characters
        case characterStartTimesSeconds = "character_start_times_seconds"
        case characterEndTimesSeconds = "character_end_times_seconds"
    }
}

/// An NDJSON frame from the authenticated speech service.
struct StreamLine: Decodable {
    let type: String?
    let message: String?
    let audioBase64: String?
    let alignment: Alignment?

    enum CodingKeys: String, CodingKey {
        case type, message, alignment
        case audioBase64 = "audio"
    }

    static func decode(_ data: Data, fish: Bool) throws -> Self {
        let decoder = JSONDecoder()
        if let frame = try? decoder.decode(Self.self, from: data) { return frame }
        // The Fish catalogue reports one timing per UTF-16 unit. Its two JSON
        // strings for an emoji may each contain a single surrogate. Join them,
        // leaving an empty slot so every following character keeps its timing.
        if fish, let text = String(data: data, encoding: .utf8) {
            let joined = text.replacingOccurrences(
                of: #""(\\u[dD][89aAbB][0-9a-fA-F]{2})"\s*,\s*"(\\u[dD][c-fC-F][0-9a-fA-F]{2})""#,
                with: #""$1$2","""#, options: .regularExpression)
            if joined != text, let frame = try? decoder.decode(Self.self, from: Data(joined.utf8)) { return frame }
        }
        throw ServiceError.badResponse
    }
}
