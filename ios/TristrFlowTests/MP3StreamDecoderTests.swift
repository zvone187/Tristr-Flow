import XCTest
@testable import TristrFlow

/// Runs on real ElevenLabs output (Fixtures/), so it needs no key or network.
final class MP3StreamDecoderTests: XCTestCase {
    private let fixtures = [("mp3_44100_64", 44_100.0), ("mp3_22050_32", 22_050.0)] // MPEG-1 and MPEG-2 frames

    // Fixtures are the original captured provider output, before the backend
    // rewrites audio_base64 as audio.
    private struct RecordedLine: Decodable {
        let audio_base64: String?
        let alignment: Alignment?
    }

    private func load(_ name: String) throws -> (chunks: [Data], timingsEnd: Double) {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: "ndjson"), "missing fixture \(name)")
        var chunks: [Data] = []
        var end = 0.0
        for line in try String(contentsOf: url, encoding: .utf8).split(separator: "\n") {
            let parsed = try JSONDecoder().decode(RecordedLine.self, from: Data(line.utf8))
            if let b64 = parsed.audio_base64, let data = Data(base64Encoded: b64) { chunks.append(data) }
            if let a = parsed.alignment { end = max(end, a.characterEndTimesSeconds.last ?? 0) }
        }
        return (chunks, end)
    }

    private func decode(_ data: Data, sampleRate: Double, slices: [Int]) -> [Int16] {
        let decoder = MP3StreamDecoder(sampleRate: sampleRate)
        var out: [Int16] = []
        var i = 0
        var k = 0
        while i < data.count {
            let size = slices[k % slices.count]
            out += decoder.decode(data.subdata(in: i..<min(i + size, data.count)))
            i += size
            k += 1
        }
        out += decoder.finish()
        XCTAssertFalse(decoder.failed)
        return out
    }

    func testSameSamplesHoweverTheStreamIsSliced() throws {
        for (name, rate) in fixtures {
            let (chunks, _) = try load(name)
            let decoder = MP3StreamDecoder(sampleRate: rate)
            var delivered: [Int16] = []
            for chunk in chunks { delivered += decoder.decode(chunk) } // as ElevenLabs sent it
            delivered += decoder.finish()
            XCTAssertGreaterThan(delivered.count, Int(rate), "\(name): over a second of audio")

            let whole = chunks.reduce(Data(), +)
            // Left alone, AudioFileStream stalls on 1–2 byte slices after one packet.
            XCTAssertEqual(decode(whole, sampleRate: rate, slices: [1]), delivered, "\(name): 1-byte slices")
            XCTAssertEqual(decode(whole, sampleRate: rate, slices: [7, 333, 1, 4096, 2, 89]), delivered, "\(name): odd slices")
        }
    }

    func testDecodedLengthIsTheTimingsPlusMP3Priming() throws {
        for (name, rate) in fixtures {
            let (chunks, end) = try load(name)
            let seconds = Double(decode(chunks.reduce(Data(), +), sampleRate: rate, slices: [4_096]).count) / rate
            // MP3 adds the encoder's priming (~1,100 samples) plus end padding: a few
            // tens of milliseconds over the speech, never under it.
            XCTAssertGreaterThanOrEqual(seconds, end, name)
            XCTAssertLessThan(seconds - end, 0.12, name)
        }
    }

    func testJunkInputDoesNotCrash() {
        let decoder = MP3StreamDecoder(sampleRate: 44_100)
        var junk = Data(count: 50_000)
        for i in junk.indices { junk[i] = UInt8(truncatingIfNeeded: i &* 7_919) }
        _ = decoder.decode(junk)
        _ = decoder.finish()
    }
}
