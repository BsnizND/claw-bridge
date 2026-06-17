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
        NSLog("Jay Bridge companion WCSession activating; configComplete=\(store.configuration.isComplete)")
        sendConfiguration(store.configuration)
    }

    func sendConfiguration(_ configuration: BridgeConfiguration) {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated else {
            NSLog("Jay Bridge companion configuration send skipped; activationState=\(WCSession.default.activationState.rawValue)")
            return
        }
        var context: [String: Any] = [
            "bearerToken": configuration.bearerToken
        ]
        if let bridgeURL = configuration.bridgeURL?.absoluteString {
            context["bridgeURL"] = bridgeURL
        }
        do {
            try WCSession.default.updateApplicationContext(context)
            NSLog("Jay Bridge companion configuration sent to Watch; configComplete=\(configuration.isComplete)")
        } catch {
            NSLog("Jay Bridge companion configuration send failed: \(error.localizedDescription)")
        }
    }

    private func relay(fileURL: URL, metadata: [String: String]) async {
        guard let store else {
            NSLog("Jay Bridge relay skipped: configuration store unavailable")
            return
        }
        defer { try? FileManager.default.removeItem(at: fileURL) }
        let location = WatchVoiceLocation(metadata: metadata)
        let request = WatchVoiceUploadRequest(
            audioFileURL: fileURL,
            deviceName: metadata["device_name"] ?? "Apple Watch",
            appName: metadata["app_name"] ?? "Jay Bridge",
            capturedAt: Date(),
            location: location
        )
        do {
            NSLog("Jay Bridge relay upload starting; configComplete=\(store.configuration.isComplete)")
            _ = try await uploader.upload(request, configuration: store.configuration)
            NSLog("Jay Bridge relay upload succeeded")
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
    ) {
        NSLog("Jay Bridge companion WCSession activation completed; state=\(activationState.rawValue); error=\(error?.localizedDescription ?? "none")")
        Task { @MainActor in
            guard let store else { return }
            sendConfiguration(store.configuration)
        }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    nonisolated func session(_ session: WCSession, didReceive file: WCSessionFile) {
        let fileURL = file.fileURL
        let metadata = (file.metadata ?? [:]).compactMapValues { $0 as? String }
        NSLog("Jay Bridge relay received Watch file; metadataKeys=\(metadata.keys.sorted().joined(separator: ","))")
        let relayURL = FileManager.default.temporaryDirectory
            .appending(path: "jay-bridge-relay-\(UUID().uuidString).m4a")
        do {
            try FileManager.default.copyItem(at: fileURL, to: relayURL)
            NSLog("Jay Bridge relay copied Watch file")
        } catch {
            NSLog("Jay Bridge relay copy failed: \(error.localizedDescription)")
            return
        }
        Task { @MainActor in
            await relay(fileURL: relayURL, metadata: metadata)
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
