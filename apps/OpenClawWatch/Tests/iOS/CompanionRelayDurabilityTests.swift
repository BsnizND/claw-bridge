import Foundation
@testable import OpenClawCompanion
import XCTest

@MainActor
final class CompanionRelayOutboxTests: XCTestCase {
    func testCorruptManifestThrowsAndControllerSurfacesBlockedState() throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("{not-json".utf8).write(to: root.appending(path: "manifest.json"))
        let outbox = CompanionRelayOutbox(directory: root)

        XCTAssertThrowsError(try outbox.items())

        let controller = CompanionRelayController(outbox: outbox)
        XCTAssertNil(controller.refreshOutboxStatus())
        XCTAssertTrue(controller.isRelayOutboxBlocked)
        XCTAssertGreaterThan(controller.pendingRelayCount, 0)
        XCTAssertEqual(controller.relayStatusText, "Watch relay blocked; queued uploads need recovery")
    }

    func testRemoveCommitsManifestBeforeBestEffortAudioDeletion() throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appending(path: "source.m4a")
        try Data("audio".utf8).write(to: source)
        let outboxDirectory = root.appending(path: "outbox", directoryHint: .isDirectory)
        var enqueuedID = ""
        var deletionObservedCommittedManifest = false
        let outbox = CompanionRelayOutbox(
            directory: outboxDirectory,
            removeAudioFile: { _ in
                let data = try Data(contentsOf: outboxDirectory.appending(path: "manifest.json"))
                let remaining = try JSONDecoder().decode([CompanionRelayOutboxItem].self, from: data)
                deletionObservedCommittedManifest = remaining.contains { $0.id == enqueuedID } == false
                throw RelayTestError.intentionalAudioDeletionFailure
            }
        )
        let item = try outbox.enqueue(fileURL: source, metadata: [:])
        enqueuedID = item.id
        let copiedAudioURL = outbox.audioURL(for: item)

        XCTAssertNoThrow(try outbox.remove(id: item.id))
        XCTAssertTrue(deletionObservedCommittedManifest)
        XCTAssertTrue(FileManager.default.fileExists(atPath: copiedAudioURL.path))
        XCTAssertFalse(try outbox.items().contains { $0.id == item.id })
    }

    func testMissingAudioRemainsInManifestAndSurfacesBlockedState() async throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appending(path: "source.m4a")
        try Data("audio".utf8).write(to: source)
        let outbox = CompanionRelayOutbox(directory: root.appending(path: "outbox", directoryHint: .isDirectory))
        let item = try outbox.enqueue(
            fileURL: source,
            metadata: [
                "request_id": "missing-audio-request",
                "relay_id": "missing-audio-relay",
            ]
        )
        try FileManager.default.removeItem(at: outbox.audioURL(for: item))
        let store = makeConfiguredStore()
        let controller = CompanionRelayController(outbox: outbox, store: store)

        await controller.drainOutbox(reason: "test-missing-audio")

        let remaining = try outbox.items()
        XCTAssertEqual(remaining.count, 1)
        XCTAssertEqual(remaining[0].id, item.id)
        XCTAssertEqual(remaining[0].attemptCount, 1)
        XCTAssertTrue(remaining[0].lastError?.contains("missing") == true)
        XCTAssertTrue(controller.isRelayOutboxBlocked)
        XCTAssertEqual(controller.pendingRelayCount, 1)
        XCTAssertEqual(controller.relayStatusText, "Queued 1; Watch relay blocked")
    }

    private func makeTemporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "CompanionRelayOutboxTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func makeConfiguredStore() -> BridgeConfigurationStore {
        let suiteName = "CompanionRelayOutboxTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.set("https://bridge.example.test", forKey: "openclaw.bridge.url")
        return BridgeConfigurationStore(
            defaults: defaults,
            credentialStore: RelayTestCredentialStore(token: "test-token"),
            legacyBundleValue: { _ in nil }
        )
    }
}

final class WatchVoiceUploadClientReceiptTests: XCTestCase {
    func testAcceptsOnlyExactDurableQueueReceipt() async throws {
        let fixture = try makeUploadFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        RelayStubURLProtocol.setResponse(
            statusCode: 202,
            body: #"{"ok":true,"queued":true,"id":"request-123"}"#
        )

        let response = try await fixture.client.upload(fixture.request, configuration: fixture.configuration)

        XCTAssertTrue(response.ok)
        XCTAssertEqual(response.queued, true)
        XCTAssertEqual(response.id, fixture.request.requestID)
    }

    func testRejectsNon2xxEvenWithOtherwiseValidReceipt() async throws {
        let fixture = try makeUploadFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        RelayStubURLProtocol.setResponse(
            statusCode: 503,
            body: #"{"ok":true,"queued":true,"id":"request-123","error":"unavailable"}"#
        )

        await assertUploadFails(
            fixture,
            expected: .server("unavailable")
        )
    }

    func testRejectsOkFalseReceipt() async throws {
        let fixture = try makeUploadFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        RelayStubURLProtocol.setResponse(
            statusCode: 200,
            body: #"{"ok":false,"queued":true,"id":"request-123","error":"rejected"}"#
        )

        await assertUploadFails(fixture, expected: .server("rejected"))
    }

    func testRejectsReceiptWithoutQueuedTrue() async throws {
        let fixture = try makeUploadFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        RelayStubURLProtocol.setResponse(
            statusCode: 200,
            body: #"{"ok":true,"queued":false,"id":"request-123"}"#
        )

        await assertUploadFails(
            fixture,
            expected: .invalidReceipt("Bridge did not confirm the upload was durably queued.")
        )
    }

    func testRejectsReceiptWithoutNonemptyID() async throws {
        let fixture = try makeUploadFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        RelayStubURLProtocol.setResponse(
            statusCode: 200,
            body: #"{"ok":true,"queued":true,"id":""}"#
        )

        await assertUploadFails(
            fixture,
            expected: .invalidReceipt("Bridge receipt is missing a request ID.")
        )
    }

    func testRejectsReceiptWithMismatchedID() async throws {
        let fixture = try makeUploadFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        RelayStubURLProtocol.setResponse(
            statusCode: 200,
            body: #"{"ok":true,"queued":true,"id":"different-request"}"#
        )

        await assertUploadFails(
            fixture,
            expected: .invalidReceipt("Bridge receipt request ID does not match the upload.")
        )
    }

    private func assertUploadFails(
        _ fixture: UploadFixture,
        expected: WatchVoiceUploadError,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        do {
            _ = try await fixture.client.upload(fixture.request, configuration: fixture.configuration)
            XCTFail("Expected upload to fail", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? WatchVoiceUploadError, expected, file: file, line: line)
        }
    }

    private func makeUploadFixture() throws -> UploadFixture {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "WatchVoiceUploadClientTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let audioURL = directory.appending(path: "capture.m4a")
        try Data("audio".utf8).write(to: audioURL)
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.protocolClasses = [RelayStubURLProtocol.self]
        return UploadFixture(
            directory: directory,
            client: WatchVoiceUploadClient(session: URLSession(configuration: sessionConfiguration)),
            request: WatchVoiceUploadRequest(
                requestID: "request-123",
                audioFileURL: audioURL,
                deviceName: "Test Watch",
                appName: "Claw Bridge"
            ),
            configuration: BridgeConfiguration(
                bridgeURL: URL(string: "https://bridge.example.test")!,
                bearerToken: "test-token"
            )
        )
    }
}

private struct UploadFixture {
    var directory: URL
    var client: WatchVoiceUploadClient
    var request: WatchVoiceUploadRequest
    var configuration: BridgeConfiguration
}

private enum RelayTestError: Error {
    case intentionalAudioDeletionFailure
}

private final class RelayTestCredentialStore: BridgeCredentialStoring {
    var token: String?

    init(token: String?) {
        self.token = token
    }

    func readBearerToken() throws -> String? { token }
    func writeBearerToken(_ token: String) throws { self.token = token }
    func deleteBearerToken() throws { token = nil }
}

private final class RelayStubURLProtocol: URLProtocol, @unchecked Sendable {
    private struct StubResponse: Sendable {
        var statusCode: Int
        var data: Data
    }

    private static let lock = NSLock()
    private nonisolated(unsafe) static var stubResponse: StubResponse?

    static func setResponse(statusCode: Int, body: String) {
        lock.lock()
        stubResponse = StubResponse(statusCode: statusCode, data: Data(body.utf8))
        lock.unlock()
    }

    override class func canInit(with _: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        let response = Self.stubResponse
        Self.lock.unlock()
        guard let response,
              let url = request.url,
              let httpResponse = HTTPURLResponse(
                  url: url,
                  statusCode: response.statusCode,
                  httpVersion: "HTTP/1.1",
                  headerFields: ["Content-Type": "application/json"]
              )
        else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        client?.urlProtocol(self, didReceive: httpResponse, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: response.data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
