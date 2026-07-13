import Foundation

enum BridgeCredentialWatchCommand: Equatable, Sendable {
    case update(bridgeURL: URL?, bearerToken: String)
    case clear(bridgeURL: URL?)
    case none
}

struct BridgeCredentialWatchContext {
    static let protocolVersionKey = "bridgeCredentialProtocolVersion"
    static let credentialStateKey = "bridgeCredentialState"
    static let bridgeURLKey = "bridgeURL"
    static let bearerTokenKey = "bearerToken"

    static func configurationFields(
        configuration: BridgeConfiguration,
        syncState: BridgeCredentialSyncState
    ) -> [String: Any]? {
        var fields: [String: Any] = [protocolVersionKey: 2]
        if let bridgeURL = configuration.bridgeURL?.absoluteString {
            fields[bridgeURLKey] = bridgeURL
        }

        switch syncState {
        case .present:
            let token = configuration.bearerToken.trimmingCharacters(in: .whitespacesAndNewlines)
            guard token.isEmpty == false else { return nil }
            fields[credentialStateKey] = BridgeCredentialSyncState.present.rawValue
            fields[bearerTokenKey] = token
        case .explicitlyCleared:
            fields[credentialStateKey] = BridgeCredentialSyncState.explicitlyCleared.rawValue
            // Older Watch builds require the empty legacy field to perform the clear.
            fields[bearerTokenKey] = ""
        case .missing:
            // Do not send even a URL-only context. Older Watch builds interpret a
            // missing bearerToken field as an empty token and persist that erasure.
            return nil
        }
        return fields
    }

    static func command(from applicationContext: [String: Any]) -> BridgeCredentialWatchCommand {
        let bridgeURL = (applicationContext[bridgeURLKey] as? String).flatMap(URL.init(string:))
        let credentialState = applicationContext[credentialStateKey] as? String

        if credentialState == BridgeCredentialSyncState.explicitlyCleared.rawValue {
            return .clear(bridgeURL: bridgeURL)
        }

        guard let token = applicationContext[bearerTokenKey] as? String else {
            return .none
        }
        let normalizedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalizedToken.isEmpty == false else {
            // Empty tokens from older or partially upgraded companions are not
            // authoritative clears. Protocol v2 uses credentialState=cleared.
            return .none
        }
        return .update(bridgeURL: bridgeURL, bearerToken: normalizedToken)
    }
}
