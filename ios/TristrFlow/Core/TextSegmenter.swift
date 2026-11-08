import Foundation

/// Splits long text into request-sized pieces.
///
/// ElevenLabs caps a streamed request at 5,000 characters, so pieces stay under
/// `maxLength` UTF-16 units, cut at a sentence end where one falls in the back
/// half of the window, else at a space. The pieces always re-join to exactly the
/// input: the timeline indexes characters by position, so a lost or added
/// character would slide the highlight for the rest of the read.
enum TextSegmenter {
    static let defaultMaxLength = 4_500

    static func segments(of text: String, maxLength: Int = defaultMaxLength) -> [NSRange] {
        let ns = text as NSString
        let n = ns.length
        guard n > 0 else { return [] }
        guard n > maxLength else { return [NSRange(location: 0, length: n)] }

        var out: [NSRange] = []
        var i = 0
        while i < n {
            var end = min(i + maxLength, n)
            if end < n {
                let window = ns.substring(with: NSRange(location: i, length: end - i)) as NSString
                var cut = -1
                for separator in [". ", "! ", "? ", "… ", "\n"] {
                    let r = window.range(of: separator, options: .backwards)
                    if r.location != NSNotFound { cut = max(cut, r.location + r.length) }
                }
                if cut < maxLength / 2 {
                    let space = window.range(of: " ", options: .backwards)
                    cut = space.location != NSNotFound && space.location + 1 > maxLength / 2
                        ? space.location + 1
                        : window.length
                }
                end = i + cut
                // Never cut between the halves of a surrogate pair (an emoji, say).
                if end > i, end < n, (0xD800...0xDBFF).contains(ns.character(at: end - 1)) {
                    end += end - i > 1 ? -1 : 1
                }
            }
            out.append(NSRange(location: i, length: end - i))
            i = end
        }
        return out
    }
}
