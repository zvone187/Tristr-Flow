import Foundation

/// Cuts a byte stream into newline-delimited lines.
///
/// Splits on the LF byte only. UTF-8 never uses 0x0A inside another character,
/// so a line can't be cut mid-character. `AsyncBytes.lines` also
/// breaks on U+2028, U+2029 and NEL and would split any JSON line whose
/// alignment happened to contain one of them.
struct NDJSONLineSplitter {
    private var buffer: [UInt8] = []

    /// Feeds one byte; returns the finished line when `byte` ends one.
    mutating func push(_ byte: UInt8) -> Data? {
        guard byte == 0x0A else {
            buffer.append(byte)
            return nil
        }
        defer { buffer.removeAll(keepingCapacity: true) }
        return Self.trimmed(buffer)
    }

    /// Feeds a block of bytes; returns every line it completes, in order.
    mutating func append(_ data: Data) -> [Data] {
        var lines: [Data] = []
        for byte in data {
            if let line = push(byte) { lines.append(line) }
        }
        return lines
    }

    /// The last line, when the stream ended without a trailing newline.
    mutating func finish() -> Data? {
        defer { buffer.removeAll() }
        return Self.trimmed(buffer)
    }

    private static func isBlank(_ b: UInt8) -> Bool { b == 0x20 || b == 0x09 || b == 0x0D }

    private static func trimmed(_ bytes: [UInt8]) -> Data? {
        var start = 0
        var end = bytes.count
        while start < end, isBlank(bytes[start]) { start += 1 }
        while end > start, isBlank(bytes[end - 1]) { end -= 1 }
        return start < end ? Data(bytes[start..<end]) : nil
    }
}
