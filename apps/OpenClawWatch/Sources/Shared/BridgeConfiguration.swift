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
        if let data = defaults.data(forKey: key),
           let decoded = try? JSONDecoder().decode(BridgeConfiguration.self, from: data) {
            configuration = decoded
        } else {
            configuration = BridgeConfiguration()
        }
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(configuration) else { return }
        defaults.set(data, forKey: key)
    }
}
