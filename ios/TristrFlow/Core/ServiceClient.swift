import Foundation

struct ServiceLogin: Decodable, Sendable {
    let email: String
    let apiToken: String
}

struct ServiceAccount: Decodable, Sendable {
    let email: String
    let minutesLeft: Int
    let plan: String
}

struct SpeechRequest: Sendable {
    var text: String
    var voiceID: String
    var stability: Double
    var token: String
    var format: StreamFormat = .mp3(sampleRate: 44_100, kbps: 128)
}

struct SpeechChunk: Sendable {
    var samples: [Int16]
    var alignment: Alignment?
}

enum ServiceError: LocalizedError, Equatable {
    case unauthorized, invalidCredentials, insufficientCredits, badResponse, undecodableAudio
    case server(String)

    var errorDescription: String? {
        switch self {
        case .unauthorized: return "Please sign in to Tristr Flow again."
        case .invalidCredentials: return "The email or password is incorrect."
        case .insufficientCredits: return "You have no narration credit available for this read."
        case .badResponse: return "The service returned an incomplete or unexpected response. Please try again."
        case .undecodableAudio: return "The audio could not be decoded. Please try again."
        case .server(let message): return message
        }
    }
}

/// A redirect can replay a POST containing a password or private reading text.
final class ServiceRedirectPolicy: NSObject, URLSessionTaskDelegate {
    static let shared = ServiceRedirectPolicy()

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct ServiceClient: Sendable {
    private let session: URLSession
    private static let serviceURL: URL = {
        #if DEBUG && targetEnvironment(simulator)
        if let override = ProcessInfo.processInfo.environment["TRISTR_TEST_SERVICE_URL"],
           let url = URL(string: override), url.scheme == "http", url.host == "127.0.0.1",
           url.port != nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
           url.path.isEmpty || url.path == "/" { return url }
        #endif
        return URL(string: "https://tristr-flow-5iy7.onrender.com")!
    }()

    private static let defaultSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = 90
        return URLSession(configuration: config, delegate: ServiceRedirectPolicy.shared, delegateQueue: nil)
    }()

    init(session: URLSession? = nil) {
        self.session = session ?? Self.defaultSession
    }

    func login(email: String, password: String) async throws -> ServiceLogin {
        var request = try Self.request("/api/auth/login", method: "POST")
        request.httpBody = try JSONEncoder().encode(["email": email, "password": password])
        let response: ServiceLogin = try await json(request, login: true)
        guard !response.apiToken.isEmpty, !response.email.isEmpty else { throw ServiceError.badResponse }
        return response
    }

    func me(token: String) async throws -> ServiceAccount {
        try await json(Self.request("/api/me", token: token))
    }

    func voices(token: String) async throws -> [Voice] {
        struct Catalogue: Decodable {
            struct Item: Decodable {
                let voice_id: String
                let name: String
                let description: String?
            }
            let voices: [Item]
        }
        let catalogue: Catalogue = try await json(Self.request("/api/voices", token: token))
        return catalogue.voices.map { Voice(id: $0.voice_id, name: $0.name, detail: $0.description ?? "") }
    }

    private static func request(_ path: String, method: String = "GET", token: String? = nil) throws -> URLRequest {
        var request = URLRequest(url: serviceURL.appendingPathComponent(path))
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 90
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if method == "POST" { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let token {
            guard !token.isEmpty else { throw ServiceError.unauthorized }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func json<T: Decodable>(_ request: URLRequest, login: Bool = false) async throws -> T {
        let (data, response) = try await session.data(for: request, delegate: ServiceRedirectPolicy.shared)
        guard let http = response as? HTTPURLResponse else { throw ServiceError.badResponse }
        guard (200..<300).contains(http.statusCode) else { throw Self.httpError(http.statusCode, login: login) }
        guard let value = try? JSONDecoder().decode(T.self, from: data) else { throw ServiceError.badResponse }
        return value
    }

    private static func httpError(_ status: Int, login: Bool = false) -> ServiceError {
        switch status {
        case 401: return login ? .invalidCredentials : .unauthorized
        case 402: return .insufficientCredits
        case 429: return .server("Too many requests. Please try again shortly.")
        default: return .server("Tristr Flow could not complete this request (HTTP \(status)). Please try again.")
        }
    }

    func stream(_ request: SpeechRequest) -> AsyncThrowingStream<SpeechChunk, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var pcm = PCM16Decoder()
                    let mp3: MP3StreamDecoder?
                    switch request.format {
                    case .mp3: mp3 = MP3StreamDecoder(sampleRate: request.format.sampleRate)
                    case .pcm: mp3 = nil
                    }
                    var producedSamples = false
                    try await readSpeech(request) { data, alignment in
                        let samples = data.map { mp3?.decode($0) ?? pcm.decode($0) } ?? []
                        if !samples.isEmpty { producedSamples = true }
                        if !samples.isEmpty || alignment != nil {
                            continuation.yield(SpeechChunk(samples: samples, alignment: alignment))
                        }
                    }
                    if let mp3 {
                        let tail = mp3.finish()
                        guard !mp3.failed else { throw ServiceError.undecodableAudio }
                        if !tail.isEmpty {
                            producedSamples = true
                            continuation.yield(SpeechChunk(samples: tail, alignment: nil))
                        }
                    }
                    guard producedSamples else { throw ServiceError.undecodableAudio }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func sample(voiceID: String, token: String) async throws -> Data {
        let request = SpeechRequest(text: "Hello. This is how I sound when I read your text.",
                                    voiceID: voiceID, stability: 0.5, token: token)
        var audio = Data()
        try await readSpeech(request) { data, _ in
            if let data { audio.append(data) }
        }
        guard !audio.isEmpty else { throw ServiceError.undecodableAudio }
        return audio
    }

    private func readSpeech(_ speech: SpeechRequest, receive: (Data?, Alignment?) -> Void) async throws {
        struct Body: Encodable {
            let text: String
            let voiceId: String
            let stability: Double
        }
        var request = try Self.request("/api/tts", method: "POST", token: speech.token)
        request.setValue("application/x-ndjson", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(Body(text: speech.text, voiceId: speech.voiceID, stability: speech.stability))
        let (bytes, response) = try await session.bytes(for: request, delegate: ServiceRedirectPolicy.shared)
        defer { bytes.task.cancel() }
        guard let http = response as? HTTPURLResponse else { throw ServiceError.badResponse }
        guard (200..<300).contains(http.statusCode) else { throw Self.httpError(http.statusCode) }
        var splitter = NDJSONLineSplitter()

        func handle(_ line: Data) throws -> Bool {
            let frame = try StreamLine.decode(line, fish: speech.voiceID.hasPrefix("fish:"))
            switch frame.type {
            case "done": return true
            case "error":
                if frame.message == "insufficient_credits" { throw ServiceError.insufficientCredits }
                throw ServiceError.server("Speech generation failed. Please try again.")
            case "segment": return false
            case nil:
                var audio: Data?
                if let encoded = frame.audioBase64, !encoded.isEmpty {
                    guard let data = Data(base64Encoded: encoded) else { throw ServiceError.undecodableAudio }
                    audio = data
                }
                receive(audio, frame.alignment)
                return false
            default: throw ServiceError.badResponse
            }
        }

        for try await byte in bytes {
            if let line = splitter.push(byte), try handle(line) { return }
        }
        if let tail = splitter.finish(), try handle(tail) { return }
        throw ServiceError.badResponse
    }
}
