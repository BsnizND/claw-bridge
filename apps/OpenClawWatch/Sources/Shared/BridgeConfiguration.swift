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

public final class BridgeConfigurationStore: ObservableObject {
    @Published public var configuration: BridgeConfiguration {
        didSet { save() }
    }

    private let defaults: UserDefaults
    private let key = "openclaw.bridge.configuration"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let bundled = Self.bundleDefaultConfiguration()
        if bundled.isComplete {
            configuration = bundled
            return
        }
        if let data = defaults.data(forKey: key),
           let decoded = try? JSONDecoder().decode(BridgeConfiguration.self, from: data) {
            configuration = decoded.isComplete ? decoded : bundled
        } else {
            configuration = bundled
        }
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(configuration) else { return }
        defaults.set(data, forKey: key)
    }

    private static func bundleDefaultConfiguration() -> BridgeConfiguration {
        let baseURLText = sanitizedBundleString("ClawBridgeDefaultBaseURL")
        let token = sanitizedBundleString("ClawBridgeDefaultBearerToken")
        return BridgeConfiguration(
            bridgeURL: baseURLText.flatMap(URL.init(string:)),
            bearerToken: token ?? ""
        )
    }

    private static func sanitizedBundleString(_ key: String) -> String? {
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
