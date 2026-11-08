import Foundation

/// Maps ElevenLabs' streamed per-character timings onto the displayed text, and
/// answers "which word is being spoken at time t" and "when does word w start".
///
/// Everything is indexed by UTF-16 code unit, the unit NSRange,
/// NSAttributedString and UITextView use. ElevenLabs reports one alignment
/// element per code point, so an emoji arrives as one element covering two units.
final class Timeline {
    struct Word: Equatable {
        let range: NSRange
        let sentence: Int
    }

    let text: String
    let words: [Word]
    let sentences: [NSRange]

    private let units: [UInt16]
    private let charToWord: [Int32]
    private var wordStart: [Double]

    /// First UTF-16 unit not yet reached by the alignment.
    private(set) var cursor = 0
    /// Start time of each timed word, in order. Words are timed in text order and
    /// starts are clamped non-decreasing, so this is sorted for binary search.
    private(set) var timedStarts: [Double] = []
    private var timedWords: [Int] = []
    /// Counts words the alignment has fully passed and whose audio exists.
    private(set) var generatedWordCount = 0
    /// Latest character end time seen: how much speech has been timed so far.
    private(set) var lastEnd: Double = 0

    private static let lookAhead = 6
    private static let terminals: Set<UInt16> = [0x2E, 0x21, 0x3F, 0x2026] // . ! ? …
    private static let closers: Set<UInt16> = [0x22, 0x27, 0x201D, 0x2019, 0x29, 0x5D] // " ' ” ’ ) ]

    init(text: String) {
        self.text = text
        let units = Array(text.utf16)
        self.units = units
        let n = units.count
        let space = units.map(Self.isSpace)

        var words: [Word] = []
        var sentences: [NSRange] = []
        var c2w = [Int32](repeating: -1, count: n)
        var sentenceStart: Int?
        var i = 0
        while i < n {
            if space[i] { i += 1; continue }
            let start = i
            while i < n, !space[i] { i += 1 }
            for k in start..<i { c2w[k] = Int32(words.count) }
            if sentenceStart == nil { sentenceStart = start }
            words.append(Word(range: NSRange(location: start, length: i - start), sentence: sentences.count))

            // A sentence ends at terminal punctuation, or where the line breaks so
            // an unpunctuated heading doesn't run into the paragraph below it.
            var j = i
            var lineBreak = false
            while j < n, space[j] {
                if Self.isNewline(units[j]) { lineBreak = true }
                j += 1
            }
            if let s = sentenceStart, lineBreak || Self.endsSentence(units, start..<i) {
                sentences.append(NSRange(location: s, length: i - s))
                sentenceStart = nil
            }
        }
        if let s = sentenceStart, let last = words.last {
            sentences.append(NSRange(location: s, length: NSMaxRange(last.range) - s))
        }

        self.words = words
        self.sentences = sentences
        self.charToWord = c2w
        self.wordStart = [Double](repeating: .nan, count: words.count)
    }

    var utf16Count: Int { units.count }

    /// Long text is sent as several requests; each one's alignment starts at the
    /// segment's first character.
    func beginSegment(at offset: Int) {
        cursor = max(cursor, min(offset, units.count))
    }

    /// Records the timings in one alignment chunk. `timeOffset` places a later
    /// segment's request-relative times on the whole read's timeline.
    @discardableResult
    func apply(_ alignment: Alignment, timeOffset: Double) -> Bool {
        let count = min(alignment.characters.count,
                        alignment.characterStartTimesSeconds.count,
                        alignment.characterEndTimesSeconds.count)
        var changed = false
        for k in 0..<count {
            let element = Array(alignment.characters[k].utf16)
            guard !element.isEmpty, let at = locate(element) else { continue }

            var start = alignment.characterStartTimesSeconds[k] + timeOffset
            if let previous = timedStarts.last, start < previous { start = previous }
            for u in at..<(at + element.count) {
                let w = Int(charToWord[u])
                if w >= 0, wordStart[w].isNaN {
                    wordStart[w] = start
                    timedStarts.append(start)
                    timedWords.append(w)
                }
            }
            cursor = at + element.count
            lastEnd = max(lastEnd, alignment.characterEndTimesSeconds[k] + timeOffset)
            changed = true
        }
        while generatedWordCount < words.count, NSMaxRange(words[generatedWordCount].range) <= cursor {
            generatedWordCount += 1
        }
        return changed
    }

    /// Where `element` sits at or just after the cursor. ElevenLabs echoes the
    /// request text verbatim, so this is nearly always the cursor itself. The
    /// short look-ahead absorbs a dropped character (the CR of a CRLF, a
    /// zero-width space) without letting one mismatch drag the cursor down the
    /// page. Elements that are too far away are skipped.
    private func locate(_ element: [UInt16]) -> Int? {
        let last = units.count - element.count
        guard last >= cursor else { return nil }
        for at in cursor...min(cursor + Self.lookAhead, last) {
            var match = true
            for (o, u) in element.enumerated() where units[at + o] != u {
                match = false
                break
            }
            if match { return at }
        }
        return nil
    }

    // MARK: - Queries

    /// The word being spoken at `time`: the last word whose start is at or before it.
    func wordIndex(at time: Double) -> Int? {
        var lo = 0
        var hi = timedStarts.count - 1
        var found = -1
        while lo <= hi {
            let mid = (lo + hi) >> 1
            if timedStarts[mid] <= time {
                found = mid
                lo = mid + 1
            } else {
                hi = mid - 1
            }
        }
        return found >= 0 ? timedWords[found] : nil
    }

    func wordIndex(atUTF16 index: Int) -> Int? {
        guard index >= 0, index < charToWord.count else { return nil }
        let w = Int(charToWord[index])
        return w >= 0 ? w : nil
    }

    /// The word under `index`, or the closest one when a tap lands between words.
    func nearestWord(toUTF16 index: Int) -> Int? {
        if let w = wordIndex(atUTF16: index) { return w }
        guard !words.isEmpty else { return nil }
        var lo = 0
        var hi = words.count
        while lo < hi {
            let mid = (lo + hi) >> 1
            if words[mid].range.location <= index { lo = mid + 1 } else { hi = mid }
        }
        let after = lo < words.count ? lo : nil
        let before = lo > 0 ? lo - 1 : nil
        switch (before, after) {
        case let (b?, a?):
            return index - NSMaxRange(words[b].range) <= words[a].range.location - index ? b : a
        case let (b?, nil): return b
        case let (nil, a?): return a
        default: return nil
        }
    }

    func startTime(ofWord w: Int) -> Double? {
        guard wordStart.indices.contains(w) else { return nil }
        let s = wordStart[w]
        return s.isNaN ? nil : s
    }

    // MARK: - Character classes

    static func isSpace(_ u: UInt16) -> Bool {
        switch u {
        case 0x09...0x0D, 0x20, 0x85, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000:
            return true
        default:
            return false
        }
    }

    static func isNewline(_ u: UInt16) -> Bool {
        u == 0x0A || u == 0x0D || u == 0x85 || u == 0x2028 || u == 0x2029
    }

    /// Same rule as the desktop reader: a terminal . ! ? … optionally followed
    /// by one closing quote or bracket.
    static func endsSentence(_ units: [UInt16], _ r: Range<Int>) -> Bool {
        guard let last = r.last else { return false }
        if terminals.contains(units[last]) { return true }
        return closers.contains(units[last]) && last > r.lowerBound && terminals.contains(units[last - 1])
    }
}
