import Foundation

/// Turns little-endian signed 16-bit PCM bytes into samples.
///
/// A sample can straddle two network chunks, so an odd trailing byte is carried
/// into the next call. Dropping it would shift every later
/// sample by a byte and turn the rest of the read into noise.
struct PCM16Decoder {
    private var carry: UInt8?

    var hasDanglingByte: Bool { carry != nil }

    mutating func decode(_ data: Data) -> [Int16] {
        guard !data.isEmpty else { return [] }
        var bytes = [UInt8]()
        bytes.reserveCapacity(data.count + 1)
        if let carry {
            bytes.append(carry)
            self.carry = nil
        }
        bytes.append(contentsOf: data)

        let count = bytes.count / 2
        if bytes.count % 2 == 1 { carry = bytes[bytes.count - 1] }

        var out = [Int16](repeating: 0, count: count)
        for i in 0..<count {
            out[i] = Int16(bitPattern: UInt16(bytes[2 * i]) | UInt16(bytes[2 * i + 1]) << 8)
        }
        return out
    }
}
