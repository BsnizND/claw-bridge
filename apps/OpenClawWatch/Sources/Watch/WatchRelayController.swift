import Foundation
import WatchConnectivity

@MainActor
final class WatchRelayController: NSObject, ObservableObject {
    static let shared = WatchRelayController()

    private var store: BridgeConfigurationStore?

    var canRelay: Bool {
        WCSession.isSupported() && WCSession.default.activationState == .activated
    }

    func start(store: BridgeConfigurationStore) {
        self.store = store
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
        NSLog("Jay Watch relay WCSession activating; configComplete=\(store.configuration.isComplete)")
    }

    func relayAudioFile(
        _ fileURL: URL,
        deviceName: String,
        appName: String,
        location: WatchVoiceLocation?
    ) throws {
        guard canRelay else {
            throw WatchRelayError.unavailable
        }
        var metadata: [String: String] = [
            "source": "watch_app",
            "device_name": deviceName,
            "app_name": appName
        ]
        if let location {
            metadata["latitude"] = String(location.latitude)
            metadata["longitude"] = String(location.longitude)
            metadata["altitude"] = location.altitude.map { String($0) }
            metadata["horizontal_accuracy"] = location.horizontalAccuracy.map { String($0) }
            metadata["vertical_accuracy"] = location.verticalAccuracy.map { String($0) }
            metadata["maps_url"] = location.mapsURL
        }
        WCSession.default.transferFile(fileURL, metadata: metadata)
        NSLog("Jay Watch queued audio file for iPhone relay")
    }
}

extension WatchRelayController: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        NSLog("Jay Watch relay WCSession activation completed; state=\(activationState.rawValue); error=\(error?.localizedDescription ?? "none")")
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        let bridgeURLText = applicationContext["bridgeURL"] as? String
        let bearerToken = applicationContext["bearerToken"] as? String ?? ""
        Task { @MainActor in
            guard let store else { return }
            let bridgeURL = bridgeURLText.flatMap(URL.init(string:))
            store.configuration = BridgeConfiguration(bridgeURL: bridgeURL, bearerToken: bearerToken)
            NSLog("Jay Watch received bridge configuration; configComplete=\(store.configuration.isComplete)")
        }
    }
}

enum WatchRelayError: LocalizedError {
    case unavailable

    var errorDescription: String? {
        switch self {
        case .unavailable: "iPhone relay is unavailable."
        }
    }
}
