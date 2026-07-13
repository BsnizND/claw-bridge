import Foundation
import XCTest
@testable import OpenClawCompanion

final class BridgeConfigurationStoreTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "BridgeConfigurationStoreTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    func testMigratesLegacyDefaultsCredentialToKeychainAndScrubsPlaintext() throws {
        let legacy = BridgeConfiguration(
            bridgeURL: URL(string: "https://bridge.example.test")!,
            bearerToken: " legacy-secret "
        )
        defaults.set(try JSONEncoder().encode(legacy), forKey: "openclaw.bridge.configuration")
        let credentials = MemoryCredentialStore()

        let store = makeStore(credentials: credentials)

        XCTAssertEqual(store.configuration.bearerToken, "legacy-secret")
        XCTAssertEqual(credentials.token, "legacy-secret")
        XCTAssertEqual(defaults.string(forKey: "openclaw.bridge.url"), "https://bridge.example.test")
        XCTAssertNil(defaults.data(forKey: "openclaw.bridge.configuration"))
        XCTAssertTrue(defaults.bool(forKey: "openclaw.bridge.credentials-migrated-to-keychain"))
    }

    func testMigrationFailureFailsClosedAndKeepsLegacyForRetry() throws {
        let legacy = BridgeConfiguration(
            bridgeURL: URL(string: "https://bridge.example.test")!,
            bearerToken: "legacy-secret"
        )
        let legacyData = try JSONEncoder().encode(legacy)
        defaults.set(legacyData, forKey: "openclaw.bridge.configuration")
        let credentials = MemoryCredentialStore(writeError: .keychainFailure(operation: "save", status: -50))

        let store = makeStore(credentials: credentials)

        XCTAssertFalse(store.configuration.isComplete)
        XCTAssertEqual(store.configuration.bearerToken, "")
        XCTAssertNotNil(store.credentialErrorMessage)
        XCTAssertEqual(defaults.data(forKey: "openclaw.bridge.configuration"), legacyData)
        XCTAssertFalse(defaults.bool(forKey: "openclaw.bridge.credentials-migrated-to-keychain"))
    }

    func testUpdateStoresURLInDefaultsAndCredentialOnlyInKeychain() throws {
        let credentials = MemoryCredentialStore()
        let store = makeStore(credentials: credentials)

        try store.updateConfiguration(
            BridgeConfiguration(
                bridgeURL: URL(string: "https://bridge.example.test")!,
                bearerToken: " new-secret "
            )
        )

        XCTAssertEqual(store.configuration.bearerToken, "new-secret")
        XCTAssertEqual(credentials.token, "new-secret")
        XCTAssertEqual(defaults.string(forKey: "openclaw.bridge.url"), "https://bridge.example.test")
        XCTAssertNil(defaults.data(forKey: "openclaw.bridge.configuration"))
        XCTAssertFalse(defaults.dictionaryRepresentation().values.contains { value in
            String(describing: value).contains("new-secret")
        })
    }

    func testCompletedMigrationDoesNotRestoreADeletedCredentialFromBundle() {
        defaults.set(true, forKey: "openclaw.bridge.credentials-migrated-to-keychain")
        let credentials = MemoryCredentialStore()

        let store = makeStore(credentials: credentials) { key in
            key == "ClawBridgeDefaultBearerToken" ? "bundled-secret" : nil
        }

        XCTAssertFalse(store.configuration.isComplete)
        XCTAssertNil(credentials.token)
    }

    private func makeStore(
        credentials: MemoryCredentialStore,
        bundleValue: @escaping (String) -> String? = { _ in nil }
    ) -> BridgeConfigurationStore {
        BridgeConfigurationStore(
            defaults: defaults,
            credentialStore: credentials,
            legacyBundleValue: bundleValue
        )
    }
}

final class KeychainBridgeCredentialStoreTests: XCTestCase {
    func testKeychainRoundTrip() throws {
        let credentials = KeychainBridgeCredentialStore(
            service: "BridgeConfigurationStoreTests.\(UUID().uuidString)"
        )
        defer { try? credentials.deleteBearerToken() }

        XCTAssertNil(try credentials.readBearerToken())
        try credentials.writeBearerToken(" keychain-secret ")
        XCTAssertEqual(try credentials.readBearerToken(), "keychain-secret")
        try credentials.deleteBearerToken()
        XCTAssertNil(try credentials.readBearerToken())
    }
}

private final class MemoryCredentialStore: BridgeCredentialStoring {
    var token: String?
    let writeError: BridgeCredentialStoreError?

    init(token: String? = nil, writeError: BridgeCredentialStoreError? = nil) {
        self.token = token
        self.writeError = writeError
    }

    func readBearerToken() throws -> String? {
        token
    }

    func writeBearerToken(_ token: String) throws {
        if let writeError {
            throw writeError
        }
        self.token = token
    }

    func deleteBearerToken() throws {
        token = nil
    }
}
