import AudioToolbox
import AVFoundation

/// Decodes an MP3 stream that arrives in arbitrary slices into 16-bit PCM.
///
/// AudioFileStream finds frame boundaries (a network chunk can end mid-frame and
/// the remainder is held until the next chunk), skips the ID3 tag and the Info
/// header frame, and hands over whole packets; AVAudioConverter turns those
/// into samples. Playback, the timeline and seeking
/// work with plain samples.
///
/// MP3 does add the encoder's priming delay at the start of each request, and
/// these streams carry no LAME tag to trim it by. Measured, it is about 1,100
/// samples: the highlight leads the voice by ~25 ms at 44.1 kHz and ~50 ms at
/// 22 kHz. A spoken word lasts 250–400 ms, so it isn't visible, and it doesn't
/// accumulate across requests because each one's offset is a decoded sample count.
final class MP3StreamDecoder {
    let sampleRate: Double

    private var stream: AudioFileStreamID?
    private var converter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?
    private let outputFormat: AVAudioFormat
    private var decoded: [Int16] = []
    private var unparsed = Data()
    private var lastInput: AVAudioCompressedBuffer?
    private(set) var failed = false

    init(sampleRate: Double) {
        self.sampleRate = sampleRate
        outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true)!
        let context = Unmanaged.passUnretained(self).toOpaque()
        if AudioFileStreamOpen(context, mp3PropertyListener, mp3PacketsListener, kAudioFileMP3Type, &stream) != noErr {
            failed = true
        }
    }

    deinit {
        if let stream { AudioFileStreamClose(stream) }
    }

    /// Feeds the next slice of the stream; returns the samples it completes.
    func decode(_ data: Data) -> [Int16] {
        guard !data.isEmpty, !failed else { return [] }
        unparsed.append(data)
        // AudioFileStream silently stops producing packets if it is handed 1- or
        // 2-byte slices (measured: one packet out of 691, no error status). Feed
        // it only sizeable slices, and hold a few bytes back so even the final
        // flush is never that small. Network chunks are kilobytes, so this adds
        // no delay in practice.
        guard unparsed.count >= Self.minimumSlice + Self.holdBack else { return [] }
        let cut = unparsed.count - Self.holdBack
        let slice = unparsed.prefix(cut)
        unparsed = Data(unparsed[cut...])
        return parse(slice)
    }

    /// Decodes whatever is still held once the stream has ended.
    func finish() -> [Int16] {
        var out = unparsed.isEmpty ? [] : parse(unparsed)
        unparsed.removeAll()
        guard let converter else { return out }
        decoded.removeAll(keepingCapacity: true)
        run(converter) { _, status in
            status.pointee = .endOfStream
            return nil
        }
        out += decoded
        return out
    }

    private static let minimumSlice = 1_024
    private static let holdBack = 16

    private func parse(_ data: Data) -> [Int16] {
        guard let stream else { return [] }
        decoded.removeAll(keepingCapacity: true)
        let status = data.withUnsafeBytes { raw in
            AudioFileStreamParseBytes(stream, UInt32(raw.count), raw.baseAddress, [])
        }
        if status != noErr { failed = true }
        return decoded
    }

    // MARK: - AudioFileStream callbacks

    fileprivate func property(_ id: AudioFileStreamPropertyID, of stream: AudioFileStreamID) {
        guard id == kAudioFileStreamProperty_ReadyToProducePackets else { return }
        var description = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        guard AudioFileStreamGetProperty(stream, kAudioFileStreamProperty_DataFormat, &size, &description) == noErr,
              let input = AVAudioFormat(streamDescription: &description),
              let converter = AVAudioConverter(from: input, to: outputFormat) else {
            failed = true
            return
        }
        inputFormat = input
        self.converter = converter
    }

    fileprivate func packets(_ byteCount: UInt32, _ packetCount: UInt32, _ data: UnsafeRawPointer,
                             _ descriptions: UnsafeMutablePointer<AudioStreamPacketDescription>?) {
        guard let converter, let inputFormat, packetCount > 0, byteCount > 0 else { return }
        let count = Int(packetCount)

        // Copy packet by packet into a tightly packed buffer with rewritten
        // offsets. The block AudioFileStream hands over can contain bytes that
        // aren't packets (it skips the Info header frame in place), so copying
        // it wholesale into a buffer sized from the packet sizes overruns it.
        var largest = 0
        if let descriptions {
            for i in 0..<count { largest = max(largest, Int(descriptions[i].mDataByteSize)) }
        } else {
            largest = (Int(byteCount) + count - 1) / count
        }
        let compressed = AVAudioCompressedBuffer(format: inputFormat, packetCapacity: packetCount,
                                                 maximumPacketSize: max(largest, 1))
        var offset = 0
        if let descriptions, let target = compressed.packetDescriptions {
            for i in 0..<count {
                let d = descriptions[i]
                let size = Int(d.mDataByteSize)
                compressed.data.advanced(by: offset).copyMemory(from: data.advanced(by: Int(d.mStartOffset)), byteCount: size)
                target[i] = AudioStreamPacketDescription(mStartOffset: Int64(offset),
                                                         mVariableFramesInPacket: d.mVariableFramesInPacket,
                                                         mDataByteSize: d.mDataByteSize)
                offset += size
            }
        } else {
            offset = min(Int(byteCount), count * largest)
            compressed.data.copyMemory(from: data, byteCount: offset)
        }
        compressed.byteLength = UInt32(offset)
        compressed.packetCount = packetCount
        // The converter can keep reading a buffer after convert() returns
        // (.noDataNow mid-buffer), so keep it alive until the next one replaces it.
        lastInput = compressed

        var handedOver = false
        run(converter) { _, status in
            if handedOver {
                status.pointee = .noDataNow // more arrives with the next network chunk
                return nil
            }
            handedOver = true
            status.pointee = .haveData
            return compressed
        }
    }

    /// Pulls everything the converter can produce from what it has been given.
    private func run(_ converter: AVAudioConverter, input: @escaping AVAudioConverterInputBlock) {
        let framesPerPacket = max(1152, Int(inputFormat?.streamDescription.pointee.mFramesPerPacket ?? 1152))
        let ratio = outputFormat.sampleRate / (inputFormat?.sampleRate ?? outputFormat.sampleRate)
        let capacity = AVAudioFrameCount(Double(framesPerPacket * 16) * max(ratio, 1) + 64)
        while true {
            guard let out = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }
            var error: NSError?
            let status = converter.convert(to: out, error: &error, withInputFrom: input)
            if out.frameLength > 0, let samples = out.int16ChannelData?[0] {
                decoded.append(contentsOf: UnsafeBufferPointer(start: samples, count: Int(out.frameLength)))
            }
            if status == .error { failed = true }
            // .haveData means the buffer filled and there is more to pull.
            if status != .haveData { return }
        }
    }
}

private let mp3PropertyListener: AudioFileStream_PropertyListenerProc = { context, stream, id, _ in
    Unmanaged<MP3StreamDecoder>.fromOpaque(context).takeUnretainedValue().property(id, of: stream)
}

private let mp3PacketsListener: AudioFileStream_PacketsProc = { context, bytes, packets, data, descriptions in
    Unmanaged<MP3StreamDecoder>.fromOpaque(context).takeUnretainedValue().packets(bytes, packets, data, descriptions)
}
