import Foundation

public struct BridgeConfiguration: Codable, Equatable, Sendable {
    public var bridgeURL: URL?
    public var bearerToken: String

    public init(bridgeURL: URL? = nil, bearerToken: String = "") {
        self.bridgeURL = bridgeURL
        self.bearerToken = bearerToken
    }

    public var isComplete: Bool {
        bridgeURL != nil && bearerToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }
}

enum BridgeCredentialSyncState: String, Equatable, Sendable {
    case present
    case missing
    case explicitlyCleared = "cleared"
}

public final class BridgeConfigurationStore: ObservableObject {
    @Published public private(set) var configuration: BridgeConfiguration
    @Published public private(set) var credentialErrorMessage: String?
    @Published private(set) var credentialSyncState: BridgeCredentialSyncState

    private let defaults: UserDefaults
    private let credentialStore: BridgeCredentialStoring
    private let legacyConfigurationKey = "openclaw.bridge.configuration"
    private let bridgeURLKey = "openclaw.bridge.url"
    private let migrationCompleteKey = "openclaw.bridge.credentials-migrated-to-keychain"
    private let credentialSyncStateKey = "openclaw.bridge.credential-sync-state"

    public convenience init(defaults: UserDefaults = .standard) {
        self.init(
            defaults: defaults,
            credentialStore: KeychainBridgeCredentialStore(),
            legacyBundleValue: Self.sanitizedMainBundleString
        )
    }

    init(
        defaults: UserDefaults,
        credentialStore: BridgeCredentialStoring,
        legacyBundleValue: @escaping (String) -> String?
    ) {
        self.defaults = defaults
        self.credentialStore = credentialStore

        let legacy = Self.decodeLegacyConfiguration(defaults: defaults, key: legacyConfigurationKey)
        let bridgeURL = Self.savedBridgeURL(defaults: defaults, key: bridgeURLKey)
            ?? legacy?.bridgeURL
            ?? legacyBundleValue("ClawBridgeDefaultBaseURL").flatMap(URL.init(string:))

        if let bridgeURL {
            defaults.set(bridgeURL.absoluteString, forKey: bridgeURLKey)
        }

        do {
            let storedToken = try credentialStore.readBearerToken()
            let token = try Self.migrateLegacyCredentialIfNeeded(
                storedToken: storedToken,
                legacy: legacy,
                defaults: defaults,
                migrationCompleteKey: migrationCompleteKey,
                credentialStore: credentialStore,
                legacyBundleValue: legacyBundleValue
            )
            configuration = BridgeConfiguration(bridgeURL: bridgeURL, bearerToken: token ?? "")
            credentialErrorMessage = nil
            if token != nil {
                credentialSyncState = .present
                defaults.set(BridgeCredentialSyncState.present.rawValue, forKey: credentialSyncStateKey)
            } else if defaults.string(forKey: credentialSyncStateKey) == BridgeCredentialSyncState.explicitlyCleared.rawValue {
                credentialSyncState = .explicitlyCleared
            } else {
                credentialSyncState = .missing
            }
            if token != nil || defaults.bool(forKey: migrationCompleteKey) {
                defaults.removeObject(forKey: legacyConfigurationKey)
            } else if legacy?.bearerToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false {
                defaults.removeObject(forKey: legacyConfigurationKey)
            }
        } catch {
            configuration = BridgeConfiguration(bridgeURL: bridgeURL, bearerToken: "")
            credentialErrorMessage = error.localizedDescription
            credentialSyncState = .missing
        }
    }

    public func updateConfiguration(_ proposed: BridgeConfiguration) throws {
        let token = proposed.bearerToken.trimmingCharacters(in: .whitespacesAndNewlines)
        let bridgeURL = proposed.bridgeURL
        let previousConfiguration = configuration
        let previousSyncState = credentialSyncState
        let previousPersistedSyncState = defaults.string(forKey: credentialSyncStateKey)

        do {
            if token.isEmpty {
                // Persist the clear intent first. If the process exits immediately
                // after Keychain deletion, the next launch can still deprovision
                // the paired Watch. A failed deletion restores the prior marker.
                defaults.set(BridgeCredentialSyncState.explicitlyCleared.rawValue, forKey: credentialSyncStateKey)
                try credentialStore.deleteBearerToken()
            } else {
                try credentialStore.writeBearerToken(token)
            }
            if let bridgeURL {
                defaults.set(bridgeURL.absoluteString, forKey: bridgeURLKey)
            } else {
                defaults.removeObject(forKey: bridgeURLKey)
            }
            defaults.set(true, forKey: migrationCompleteKey)
            defaults.removeObject(forKey: legacyConfigurationKey)
            configuration = BridgeConfiguration(bridgeURL: bridgeURL, bearerToken: token)
            credentialSyncState = token.isEmpty ? .explicitlyCleared : .present
            if token.isEmpty == false {
                defaults.set(credentialSyncState.rawValue, forKey: credentialSyncStateKey)
            }
            credentialErrorMessage = nil
        } catch {
            if let previousPersistedSyncState {
                defaults.set(previousPersistedSyncState, forKey: credentialSyncStateKey)
            } else {
                defaults.removeObject(forKey: credentialSyncStateKey)
            }
            configuration = previousConfiguration
            credentialSyncState = previousSyncState
            credentialErrorMessage = error.localizedDescription
            throw error
        }
    }

    public func clearCredential() throws {
        try updateConfiguration(
            BridgeConfiguration(
                bridgeURL: configuration.bridgeURL,
                bearerToken: ""
            )
        )
    }

    private static func migrateLegacyCredentialIfNeeded(
        storedToken: String?,
        legacy: BridgeConfiguration?,
        defaults: UserDefaults,
        migrationCompleteKey: String,
        credentialStore: BridgeCredentialStoring,
        legacyBundleValue: (String) -> String?
    ) throws -> String? {
        if let storedToken {
            defaults.set(true, forKey: migrationCompleteKey)
            return storedToken
        }
        guard defaults.bool(forKey: migrationCompleteKey) == false else {
            return nil
        }

        let legacyDefaultsToken = legacy?.bearerToken.trimmingCharacters(in: .whitespacesAndNewlines)
        let legacyBundleToken = (
            legacyBundleValue("ClawBridgeLegacyMigrationBearerToken")
                ?? legacyBundleValue("ClawBridgeDefaultBearerToken")
        )?.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidate = legacyDefaultsToken?.isEmpty == false ? legacyDefaultsToken : legacyBundleToken
        guard let candidate, candidate.isEmpty == false else {
            return nil
        }

        try credentialStore.writeBearerToken(candidate)
        defaults.set(true, forKey: migrationCompleteKey)
        return candidate
    }

    private static func decodeLegacyConfiguration(defaults: UserDefaults, key: String) -> BridgeConfiguration? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(BridgeConfiguration.self, from: data)
    }

    private static func savedBridgeURL(defaults: UserDefaults, key: String) -> URL? {
        guard let value = defaults.string(forKey: key) else { return nil }
        return URL(string: value)
    }

    private static func sanitizedMainBundleString(_ key: String) -> String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains("$(") else {
            return nil
        }
        return trimmed
    }
}
