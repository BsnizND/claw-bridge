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
        XCTAssertEqual(store.credentialSyncState, .present)
    }

    func testMigratesLegacyBundleOnlyCredentialDuringPhaseOneBuild() {
        let credentials = MemoryCredentialStore()

        let store = makeStore(credentials: credentials) { key in
            switch key {
            case "ClawBridgeDefaultBaseURL":
                "https://bridge.example.test"
            case "ClawBridgeLegacyMigrationBearerToken":
                " legacy-bundle-secret "
            default:
                nil
            }
        }

        XCTAssertEqual(store.configuration.bridgeURL?.absoluteString, "https://bridge.example.test")
        XCTAssertEqual(store.configuration.bearerToken, "legacy-bundle-secret")
        XCTAssertEqual(credentials.token, "legacy-bundle-secret")
        XCTAssertEqual(store.credentialSyncState, .present)
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
        XCTAssertEqual(store.credentialSyncState, .missing)
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
        XCTAssertEqual(store.credentialSyncState, .present)
    }

    func testUpdateFailurePreservesPriorLiveConfiguration() {
        defaults.set("https://bridge.example.test", forKey: "openclaw.bridge.url")
        let credentials = MemoryCredentialStore(token: "current-secret")
        let store = makeStore(credentials: credentials)
        credentials.writeError = .keychainFailure(operation: "update", status: -50)

        XCTAssertThrowsError(
            try store.updateConfiguration(
                BridgeConfiguration(
                    bridgeURL: URL(string: "https://replacement.example.test")!,
                    bearerToken: "replacement-secret"
                )
            )
        )

        XCTAssertEqual(store.configuration.bridgeURL?.absoluteString, "https://bridge.example.test")
        XCTAssertEqual(store.configuration.bearerToken, "current-secret")
        XCTAssertEqual(store.credentialSyncState, .present)
        XCTAssertEqual(credentials.token, "current-secret")
        XCTAssertNotNil(store.credentialErrorMessage)
    }

    func testExplicitClearPersistsDeprovisionStateAcrossRestart() throws {
        defaults.set("https://bridge.example.test", forKey: "openclaw.bridge.url")
        let credentials = MemoryCredentialStore(token: "current-secret")
        let store = makeStore(credentials: credentials)

        try store.clearCredential()

        XCTAssertNil(credentials.token)
        XCTAssertEqual(store.configuration.bearerToken, "")
        XCTAssertEqual(store.credentialSyncState, .explicitlyCleared)

        let restartedStore = makeStore(credentials: credentials)
        XCTAssertEqual(restartedStore.credentialSyncState, .explicitlyCleared)
        XCTAssertEqual(restartedStore.configuration.bearerToken, "")
    }

    func testClearFailureRestoresPriorConfigurationAndSyncState() {
        defaults.set("https://bridge.example.test", forKey: "openclaw.bridge.url")
        let credentials = MemoryCredentialStore(
            token: "current-secret",
            deleteError: .keychainFailure(operation: "delete", status: -50)
        )
        let store = makeStore(credentials: credentials)

        XCTAssertThrowsError(try store.clearCredential())

        XCTAssertEqual(credentials.token, "current-secret")
        XCTAssertEqual(store.configuration.bearerToken, "current-secret")
        XCTAssertEqual(store.credentialSyncState, .present)
        XCTAssertEqual(
            defaults.string(forKey: "openclaw.bridge.credential-sync-state"),
            BridgeCredentialSyncState.present.rawValue
        )
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

final class BridgeCredentialWatchContextTests: XCTestCase {
    private let configured = BridgeConfiguration(
        bridgeURL: URL(string: "https://bridge.example.test")!,
        bearerToken: "current-secret"
    )

    func testMissingCredentialProducesNoApplicationContext() {
        XCTAssertNil(
            BridgeCredentialWatchContext.configurationFields(
                configuration: BridgeConfiguration(
                    bridgeURL: configured.bridgeURL,
                    bearerToken: ""
                ),
                syncState: .missing
            )
        )
    }

    func testPresentCredentialProducesLegacyCompatibleContext() {
        let fields = BridgeCredentialWatchContext.configurationFields(
            configuration: configured,
            syncState: .present
        )

        XCTAssertEqual(fields?[BridgeCredentialWatchContext.bearerTokenKey] as? String, "current-secret")
        XCTAssertEqual(fields?[BridgeCredentialWatchContext.credentialStateKey] as? String, "present")
        XCTAssertEqual(fields?[BridgeCredentialWatchContext.protocolVersionKey] as? Int, 2)
    }

    func testExplicitClearProducesLegacyAndVersionedClearSignals() {
        let fields = BridgeCredentialWatchContext.configurationFields(
            configuration: BridgeConfiguration(bridgeURL: configured.bridgeURL, bearerToken: ""),
            syncState: .explicitlyCleared
        )!

        XCTAssertEqual(fields[BridgeCredentialWatchContext.bearerTokenKey] as? String, "")
        XCTAssertEqual(fields[BridgeCredentialWatchContext.credentialStateKey] as? String, "cleared")
        XCTAssertEqual(
            BridgeCredentialWatchContext.command(from: fields),
            .clear(bridgeURL: configured.bridgeURL)
        )
    }

    func testURLOnlyAndLegacyEmptyContextsDoNotEraseCredential() {
        XCTAssertEqual(
            BridgeCredentialWatchContext.command(from: [
                BridgeCredentialWatchContext.bridgeURLKey: "https://replacement.example.test"
            ]),
            .none
        )
        XCTAssertEqual(
            BridgeCredentialWatchContext.command(from: [
                BridgeCredentialWatchContext.bridgeURLKey: "https://replacement.example.test",
                BridgeCredentialWatchContext.bearerTokenKey: ""
            ]),
            .none
        )
    }

    func testLegacyNonemptyContextStillUpdatesCredential() {
        XCTAssertEqual(
            BridgeCredentialWatchContext.command(from: [
                BridgeCredentialWatchContext.bridgeURLKey: "https://replacement.example.test",
                BridgeCredentialWatchContext.bearerTokenKey: " replacement-secret "
            ]),
            .update(
                bridgeURL: URL(string: "https://replacement.example.test")!,
                bearerToken: "replacement-secret"
            )
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
    var writeError: BridgeCredentialStoreError?
    var deleteError: BridgeCredentialStoreError?

    init(
        token: String? = nil,
        writeError: BridgeCredentialStoreError? = nil,
        deleteError: BridgeCredentialStoreError? = nil
    ) {
        self.token = token
        self.writeError = writeError
        self.deleteError = deleteError
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
        if let deleteError {
            throw deleteError
        }
        token = nil
    }
}
