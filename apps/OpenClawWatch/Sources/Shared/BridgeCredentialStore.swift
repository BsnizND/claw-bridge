import Foundation
import Security

protocol BridgeCredentialStoring {
    func readBearerToken() throws -> String?
    func writeBearerToken(_ token: String) throws
    func deleteBearerToken() throws
}

enum BridgeCredentialStoreError: LocalizedError, Equatable {
    case invalidStoredCredential
    case keychainFailure(operation: String, status: OSStatus)

    var errorDescription: String? {
        switch self {
        case .invalidStoredCredential:
            return "The saved bridge credential is unreadable. Enter it again."
        case let .keychainFailure(operation, status):
            return "Could not \(operation) the bridge credential in Keychain (\(status))."
        }
    }
}

struct KeychainBridgeCredentialStore: BridgeCredentialStoring {
    private let service: String
    private let account: String

    init(
        service: String = Bundle.main.bundleIdentifier ?? "ai.openclaw.ClawBridge",
        account: String = "bridge-bearer-token"
    ) {
        self.service = service
        self.account = account
    }

    func readBearerToken() throws -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw BridgeCredentialStoreError.keychainFailure(operation: "read", status: status)
        }
        guard let data = item as? Data,
              let token = String(data: data, encoding: .utf8),
              normalized(token).isEmpty == false else {
            throw BridgeCredentialStoreError.invalidStoredCredential
        }
        return normalized(token)
    }

    func writeBearerToken(_ token: String) throws {
        let token = normalized(token)
        guard token.isEmpty == false, let data = token.data(using: .utf8) else {
            throw BridgeCredentialStoreError.invalidStoredCredential
        }

        let updateAttributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, updateAttributes as CFDictionary)
        if updateStatus == errSecSuccess {
            return
        }
        guard updateStatus == errSecItemNotFound else {
            throw BridgeCredentialStoreError.keychainFailure(operation: "update", status: updateStatus)
        }

        var addQuery = baseQuery
        updateAttributes.forEach { addQuery[$0.key] = $0.value }
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw BridgeCredentialStoreError.keychainFailure(operation: "save", status: addStatus)
        }
    }

    func deleteBearerToken() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw BridgeCredentialStoreError.keychainFailure(operation: "delete", status: status)
        }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private func normalized(_ token: String) -> String {
        token.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
