import XCTest
@testable import TristrFlow

/// Runs the real AVAudioEngine (in the simulator). Fed silence, so the suite is quiet.
@MainActor
final class StreamingPlayerTests: XCTestCase {
    private func silence(seconds: Double) -> [Int16] { [Int16](repeating: 0, count: Int(seconds * 24_000)) }

    func testPlaysSeeksAndPauses() async throws {
        let player = StreamingPlayer()
        player.append(silence(seconds: 4))
        player.play()
        try await Task.sleep(for: .milliseconds(1200))
        XCTAssertGreaterThan(player.currentTime, 0.6)
        XCTAssertLessThan(player.currentTime, 1.4)

        player.seek(toSeconds: 2.5)
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertGreaterThan(player.currentTime, 2.4)
        XCTAssertLessThan(player.currentTime, 3.1)

        player.pause()
        let held = player.currentTime
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(player.currentTime, held, accuracy: 0.001, "paused position holds")

        player.play()
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertGreaterThan(player.currentTime, held + 0.15, "resumes from where it paused")
        player.reset()
    }

    func testRunningDryWaitsAtTheEdgeAndResumesThere() async throws {
        let player = StreamingPlayer()
        player.append(silence(seconds: 0.25))
        player.play()
        try await Task.sleep(for: .milliseconds(900)) // network "stalls"
        XCTAssertTrue(player.isStarved)
        XCTAssertLessThanOrEqual(player.currentTime, 0.2501, "never reports audio that hasn't arrived")

        player.append(silence(seconds: 1))
        try await Task.sleep(for: .milliseconds(500))
        // Picks up from 0.25 s, not from wherever the node's clock wandered during the stall.
        XCTAssertGreaterThan(player.currentTime, 0.35)
        XCTAssertLessThan(player.currentTime, 0.9)
        player.reset()
    }

    func testSpeedChangesContentTime() async throws {
        let player = StreamingPlayer()
        player.append(silence(seconds: 8))
        player.rate = 2
        player.play()
        try await Task.sleep(for: .milliseconds(1500))
        XCTAssertGreaterThan(player.currentTime, 2.0, "about 3 s of audio in 1.5 s at 2×")
        player.reset()
    }

    func testSeekClampsToWhatHasArrived() {
        let player = StreamingPlayer()
        player.append(silence(seconds: 1))
        player.seek(toSeconds: 30)
        XCTAssertEqual(player.currentTime, 1, accuracy: 0.001)
        player.seek(toSeconds: -5)
        XCTAssertEqual(player.currentTime, 0)
    }
}
