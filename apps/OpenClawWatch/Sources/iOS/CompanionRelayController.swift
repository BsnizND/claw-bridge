import Foundation
import WatchConnectivity

@MainActor
final class CompanionRelayController: NSObject, ObservableObject {
    static let shared = CompanionRelayController()

    private let uploader = WatchVoiceUploadClient()
    private var store: BridgeConfigurationStore?

    var isSupported: Bool { WCSession.isSupported() }

    func start(store: BridgeConfigurationStore) {
        self.store = store
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
        sendConfiguration(store.configuration)
    }

    func sendConfiguration(_ configuration: BridgeConfiguration) {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated else { return }
        var context: [String: Any] = [
            "bearerToken": configuration.bearerToken
        ]
        if let bridgeURL = configuration.bridgeURL?.absoluteString {
            context["bridgeURL"] = bridgeURL
        }
        try? WCSession.default.updateApplicationContext(context)
    }

    private func relay(fileURL: URL, metadata: [String: String]) async {
        guard let store else { return }
        let location = WatchVoiceLocation(metadata: metadata)
        let request = WatchVoiceUploadRequest(
            audioFileURL: fileURL,
            deviceName: metadata["device_name"] ?? "Apple Watch",
            appName: metadata["app_name"] ?? "Jay Bridge",
            capturedAt: Date(),
            location: location
        )
        do {
            _ = try await uploader.upload(request, configuration: store.configuration)
        } catch {
            // Relay failures stay local to the companion; the Watch shows the
            // original direct-upload failure and can retry.
            NSLog("Jay Bridge relay failed: \(error.localizedDescription)")
        }
    }
}

extension CompanionRelayController: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {}

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    nonisolated func session(_ session: WCSession, didReceive file: WCSessionFile) {
        let fileURL = file.fileURL
        let metadata = (file.metadata ?? [:]).compactMapValues { $0 as? String }
        Task { @MainActor in
            await relay(fileURL: fileURL, metadata: metadata)
        }
    }
}

private extension WatchVoiceLocation {
    init?(metadata: [String: String]) {
        guard let latitudeText = metadata["latitude"],
              let longitudeText = metadata["longitude"],
              let latitude = Double(latitudeText),
              let longitude = Double(longitudeText) else {
            return nil
        }
        self.latitude = latitude
        self.longitude = longitude
        altitude = metadata["altitude"].flatMap(Double.init)
        horizontalAccuracy = metadata["horizontal_accuracy"].flatMap(Double.init)
        verticalAccuracy = metadata["vertical_accuracy"].flatMap(Double.init)
        mapsURL = metadata["maps_url"]
    }
}
