import XCTest
@testable import TristrFlow

final class TimelineTests: XCTestCase {
    /// One element per code point, as ElevenLabs sends it, `step` seconds apart.
    private func alignment(_ text: String, from start: Double = 0, step: Double = 0.1) -> Alignment {
        let chars = text.unicodeScalars.map { String($0) }
        let starts = chars.indices.map { start + Double($0) * step }
        return Alignment(characters: chars, characterStartTimesSeconds: starts,
                         characterEndTimesSeconds: starts.map { $0 + step })
    }

    func testWordsAndSentences() {
        let t = Timeline(text: "Hello there. How are you?\nA heading\nNext “line.” Done")
        XCTAssertEqual(t.words.count, 10)
        let ns = t.text as NSString
        XCTAssertEqual(t.sentences.map { ns.substring(with: $0) },
                       ["Hello there.", "How are you?", "A heading", "Next “line.”", "Done"])
        XCTAssertEqual(t.words[5].sentence, 2) // "A"
    }

    func testFindsTheWordBeingSpoken() {
        let text = "Hello there friend"
        let t = Timeline(text: text)
        t.apply(alignment(text), timeOffset: 0)
        XCTAssertNil(t.wordIndex(at: -0.01))
        XCTAssertEqual(t.wordIndex(at: 0.0), 0)
        XCTAssertEqual(t.wordIndex(at: 0.55), 0)  // the space after "Hello"
        XCTAssertEqual(t.wordIndex(at: 0.61), 1)  // "there" starts at code point 6 (0.1 × 6 is a hair over 0.6)
        XCTAssertEqual(t.wordIndex(at: 99), 2)
        XCTAssertEqual(t.startTime(ofWord: 2)!, 1.2, accuracy: 1e-9)
        XCTAssertEqual(t.generatedWordCount, 3)
        XCTAssertEqual(t.lastEnd, 1.8, accuracy: 1e-9)
    }

    func testEmojiCoversTwoUTF16UnitsWithoutShiftingLaterWords() {
        let text = "Hi 👋 there"
        let t = Timeline(text: text)
        t.apply(alignment(text), timeOffset: 0)
        // "there" is code point 5 (0.5 s) but UTF-16 offset 6.
        XCTAssertEqual(t.words[2].range, NSRange(location: 6, length: 5))
        XCTAssertEqual(t.startTime(ofWord: 2)!, 0.5, accuracy: 1e-9)
        XCTAssertEqual(t.cursor, t.utf16Count)
    }

    func testChunksArriveIncrementally() {
        let text = "Hello there friend"
        let t = Timeline(text: text)
        let full = alignment(text)
        func part(_ r: Range<Int>) -> Alignment {
            Alignment(characters: Array(full.characters[r]),
                      characterStartTimesSeconds: Array(full.characterStartTimesSeconds[r]),
                      characterEndTimesSeconds: Array(full.characterEndTimesSeconds[r]))
        }
        t.apply(part(0..<8), timeOffset: 0) // "Hello th"
        XCTAssertEqual(t.generatedWordCount, 1)
        XCTAssertNotNil(t.startTime(ofWord: 1), "a word is seekable once its first letter is timed")
        XCTAssertNil(t.startTime(ofWord: 2))
        t.apply(part(8..<18), timeOffset: 0)
        XCTAssertEqual(t.generatedWordCount, 3)
    }

    func testSecondRequestIsOffsetByTheFirstOnesAudio() {
        let text = "One two. Three four."
        let t = Timeline(text: text)
        t.beginSegment(at: 0)
        t.apply(alignment("One two. "), timeOffset: 0)
        t.beginSegment(at: 9)
        t.apply(alignment("Three four."), timeOffset: 5)
        XCTAssertEqual(t.startTime(ofWord: 2)!, 5.0, accuracy: 1e-9)
        XCTAssertEqual(t.wordIndex(at: 5.05), 2)
        XCTAssertEqual(t.generatedWordCount, 4)
    }

    func testToleratesADroppedCarriageReturn() {
        let t = Timeline(text: "first\r\nsecond")
        t.apply(alignment("first\nsecond"), timeOffset: 0)
        XCTAssertEqual(t.startTime(ofWord: 1)!, 0.6, accuracy: 1e-9)
        XCTAssertEqual(t.cursor, t.utf16Count)
    }

    func testSkipsAnElementThatIsNotInTheText() {
        let text = "alpha beta"
        let t = Timeline(text: text)
        var a = alignment("alpha Xbeta")
        t.apply(a, timeOffset: 0)
        XCTAssertEqual(t.startTime(ofWord: 1)!, 0.7, accuracy: 1e-9, "'b' is element 7")
        XCTAssertEqual(t.generatedWordCount, 2)
        a = alignment("")
        XCTAssertFalse(t.apply(a, timeOffset: 0))
    }

    func testStartsStaySortedForTheBinarySearch() {
        let t = Timeline(text: "a b c")
        t.apply(Alignment(characters: ["a", " ", "b", " ", "c"],
                          characterStartTimesSeconds: [0, 0.1, 0.5, 0.6, 0.4], // "c" reported early
                          characterEndTimesSeconds: [0.1, 0.2, 0.6, 0.7, 0.8]), timeOffset: 0)
        XCTAssertEqual(t.timedStarts, t.timedStarts.sorted())
        XCTAssertEqual(t.wordIndex(at: 0.55), 2)
    }

    func testTapBetweenWordsPicksTheNearestWord() {
        let t = Timeline(text: "one    two")
        XCTAssertEqual(t.nearestWord(toUTF16: 1), 0)
        XCTAssertEqual(t.nearestWord(toUTF16: 4), 0)
        XCTAssertEqual(t.nearestWord(toUTF16: 6), 1)
        XCTAssertEqual(t.nearestWord(toUTF16: 999), 1)
    }
}
