import Foundation
import OSLog

/// The serial queue owns the journal, the outstanding request, and the retry timer.
final class AnalyticsDelivery: @unchecked Sendable {
    private struct Journal: Codable {
        var installation = UUID()
        var events: [AnalyticsRecord] = []
    }

    private struct Batch: Encodable {
        let api_key: String
        let batch: [Item]

        struct Item: Encodable {
            let distinct_id: UUID
            let uuid: UUID
            let timestamp: String
            let event: String
            let properties: [String: AnalyticsValue]
        }
    }

    private static let capacity = 100
    private static let log = Logger(subsystem: "ai.pazi.tristrflow", category: "ProductAnalytics")
    private let worker = DispatchQueue(label: "ai.pazi.tristrflow.analytics", qos: .utility)
    private let file: URL
    private let endpoint: URL
    private let projectToken: String
    private let session: URLSession
    private let automatic: Bool
    private var journal: Journal?
    private var incoming: [AnalyticsRecord] = []
    private var dirty = false
    private var sending = false
    private var timer: DispatchWorkItem?
    private var retryDelay: TimeInterval = 2
    private var completions: [CheckedContinuation<Void, Never>] = []

    init(file: URL, endpoint: URL, projectToken: String, session: URLSession? = nil, automatic: Bool = true) {
        self.file = file
        self.endpoint = endpoint
        self.projectToken = projectToken
        self.automatic = automatic
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.httpShouldSetCookies = false
            config.httpCookieStorage = nil
            config.urlCredentialStorage = nil
            config.urlCache = nil
            config.timeoutIntervalForRequest = 12
            config.timeoutIntervalForResource = 20
            self.session = URLSession(configuration: config)
        }
        if automatic { worker.async { self.send() } }
    }

    func enqueue(_ event: AnalyticsRecord) {
        worker.async {
            self.incoming.append(event)
            Self.trim(&self.incoming)
            if self.persistChanges() {
                self.schedule(after: 0.25)
            } else {
                self.retry()
            }
        }
    }

    /// Completes after the queue drains or an attempt fails temporarily.
    func flush() async {
        await withCheckedContinuation { continuation in
            worker.async {
                self.completions.append(continuation)
                self.timer?.cancel()
                self.timer = nil
                self.send()
            }
        }
    }

    private static func trim(_ events: inout [AnalyticsRecord]) {
        if events.count > Self.capacity { events.removeFirst(events.count - Self.capacity) }
    }

    private func persistChanges() -> Bool {
        do {
            if journal == nil {
                do {
                    journal = try JSONDecoder().decode(Journal.self, from: Data(contentsOf: file))
                } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
                    journal = Journal()
                } catch is DecodingError {
                    // Recover from an unreadable encoding. A locked or temporarily
                    // inaccessible file is left untouched and retried after unlock.
                    journal = Journal()
                    dirty = true
                }
            }

            guard var current = journal else { return false }
            if !incoming.isEmpty {
                current.events.append(contentsOf: incoming)
                Self.trim(&current.events)
                incoming.removeAll()
                journal = current
                dirty = true
            }
            if dirty {
                var directory = file.deletingLastPathComponent()
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                var settings = URLResourceValues()
                settings.isExcludedFromBackup = true
                try directory.setResourceValues(settings)
                let data = try JSONEncoder().encode(current)
                try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                dirty = false
            }
            return true
        } catch {
            return false
        }
    }

    private func send() {
        guard !sending else { return }
        guard persistChanges() else { retry(); return }
        guard let current = journal, !current.events.isEmpty else { finishAttempt(); return }
        let events = current.events
        let batch = events.map {
            Batch.Item(distinct_id: current.installation, uuid: $0.uuid, timestamp: $0.timestamp,
                       event: $0.event, properties: $0.properties)
        }
        var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = "POST"
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("TristrFlow-iOS", forHTTPHeaderField: "User-Agent")
        guard let body = try? JSONEncoder().encode(Batch(api_key: projectToken, batch: batch)) else {
            acknowledge(events)
            return
        }
        request.httpBody = body
        sending = true
        Task {
            do {
                let (_, response) = try await session.data(for: request, delegate: ServiceRedirectPolicy.shared)
                let http = response as? HTTPURLResponse
                let status = http?.statusCode ?? 0
                let retryAfter = http?.value(forHTTPHeaderField: "Retry-After").flatMap(TimeInterval.init)
                worker.async {
                    self.sending = false
                    if (200..<300).contains(status) {
                        Self.log.info("Analytics batch acknowledged: count=\(events.count, privacy: .public) status=\(status, privacy: .public)")
                    } else {
                        Self.log.info("Analytics delivery failed: status=\(status, privacy: .public)")
                    }
                    if status == 0 || [408, 425, 429].contains(status) || (500..<600).contains(status) {
                        self.retry(after: retryAfter)
                    } else {
                        // Acknowledged 2xx or a permanent rejection (including redirects).
                        self.acknowledge(events)
                    }
                }
            } catch {
                worker.async {
                    self.sending = false
                    Self.log.info("Analytics delivery failed: status=0")
                    self.retry()
                }
            }
        }
    }

    private func acknowledge(_ events: [AnalyticsRecord]) {
        let delivered = Set(events.map(\.uuid))
        journal?.events.removeAll { delivered.contains($0.uuid) }
        dirty = true
        retryDelay = 2
        send()
    }

    private func schedule(after delay: TimeInterval) {
        guard automatic, timer == nil, !sending else { return }
        let work = DispatchWorkItem { [weak self] in
            self?.timer = nil
            self?.send()
        }
        timer = work
        worker.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func retry(after hint: TimeInterval? = nil) {
        let delay = min(max(retryDelay, hint ?? 0), 3_600)
        retryDelay = min(retryDelay * 2, 300)
        schedule(after: delay)
        finishAttempt()
    }

    private func finishAttempt() {
        let waiting = completions
        completions.removeAll()
        for completion in waiting { completion.resume() }
    }
}
