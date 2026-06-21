import Foundation
import Combine
import WatchConnectivity

@MainActor
final class CompanionRelayController: NSObject, ObservableObject {
    static let shared = CompanionRelayController()

    @Published private(set) var pendingRelayCount = 0
    @Published private(set) var relayStatusText = "No queued Watch uploads"

    private let uploader = WatchVoiceUploadClient()
    private let outbox = CompanionRelayOutbox()
    private var store: BridgeConfigurationStore?
    private var isDraining = false
    private var drainRequestedWhileRunning = false
    private var retryTask: Task<Void, Never>?
    private var latestRelaySnapshot: WatchRelayBridgeSnapshot?

    var isSupported: Bool { WCSession.isSupported() }

    func start(store: BridgeConfigurationStore) {
        self.store = store
        refreshOutboxStatus()
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
        NSLog("Claw Bridge companion WCSession activating; configComplete=\(store.configuration.isComplete)")
        sendConfiguration(store.configuration)
        drainPending(reason: "startup")
    }

    func sendConfiguration(_ configuration: BridgeConfiguration) {
        sendApplicationContext(configuration: configuration, relaySnapshot: latestRelaySnapshot)
        drainPending(reason: "configuration")
    }

    func drainPending(reason: String = "manual") {
        guard !isDraining else {
            drainRequestedWhileRunning = true
            return
        }
        Task { @MainActor in
            await drainOutbox(reason: reason)
        }
    }

    private func enqueue(fileURL: URL, metadata: [String: String]) {
        do {
            let item = try outbox.enqueue(fileURL: fileURL, metadata: metadata)
            refreshOutboxStatus()
            publishRelaySnapshot(
                WatchRelayBridgeSnapshot(
                    state: .queuedOnPhone,
                    relayID: relayID(for: item),
                    pendingCount: pendingRelayCount,
                    detail: pendingRelayCount <= 1 ? "Waiting for bridge upload" : "\(pendingRelayCount) Watch uploads queued"
                )
            )
            NSLog("Claw Bridge relay queued Watch file in durable outbox; id=\(item.id); pending=\(pendingRelayCount)")
            drainPending(reason: "watch-file")
        } catch {
            relayStatusText = "Watch relay failed: \(error.localizedDescription)"
            publishRelaySnapshot(
                WatchRelayBridgeSnapshot(
                    state: .failed,
                    relayID: metadata["relay_id"],
                    pendingCount: pendingRelayCount,
                    detail: error.localizedDescription
                )
            )
            NSLog("Claw Bridge relay enqueue failed: \(error.localizedDescription)")
        }
    }

    private func drainOutbox(reason: String) async {
        guard !isDraining else {
            drainRequestedWhileRunning = true
            return
        }
        isDraining = true
        defer {
            isDraining = false
            if drainRequestedWhileRunning {
                drainRequestedWhileRunning = false
                drainPending(reason: "coalesced")
            }
        }

        let items = outbox.items()
        guard !items.isEmpty else {
            refreshOutboxStatus()
            return
        }
        guard let store else {
            relayStatusText = "Queued \(items.count); iPhone app is starting"
            NSLog("Claw Bridge relay drain skipped: configuration store unavailable")
            return
        }
        guard store.configuration.isComplete else {
            pendingRelayCount = items.count
            relayStatusText = "Queued \(items.count); bridge configuration required"
            publishRelaySnapshot(
                WatchRelayBridgeSnapshot(
                    state: .queuedOnPhone,
                    relayID: relayID(for: items[0]),
                    pendingCount: items.count,
                    detail: "Bridge configuration required"
                )
            )
            NSLog("Claw Bridge relay drain skipped: bridge configuration incomplete")
            return
        }

        relayStatusText = items.count == 1 ? "Uploading queued Watch message" : "Uploading \(items.count) queued Watch messages"
        NSLog("Claw Bridge relay drain starting; pending=\(items.count); reason=\(reason)")

        for item in items {
            let fileURL = outbox.audioURL(for: item)
            guard FileManager.default.fileExists(atPath: fileURL.path) else {
                try? outbox.remove(id: item.id)
                refreshOutboxStatus()
                NSLog("Claw Bridge relay discarded outbox item with missing audio; id=\(item.id)")
                continue
            }
            let metadata = item.metadata
            let location = WatchVoiceLocation(metadata: metadata)
            let capturedAt = metadata["captured_at"].flatMap { ISO8601DateFormatter().date(from: $0) } ?? item.createdAt
            let wantsVoiceReply = metadata["response_mode"] == "voice" || metadata["walkie_mode"] == "true"
            let relayID = relayID(for: item)
            let request = WatchVoiceUploadRequest(
                audioFileURL: fileURL,
                deviceName: metadata["device_name"] ?? "Apple Watch",
                appName: metadata["app_name"] ?? "Claw Bridge",
                capturedAt: capturedAt,
                location: location,
                noLocationReason: metadata["no_location_reason"],
                wantsVoiceReply: wantsVoiceReply,
                appDeviceID: CompanionPushController.shared.deviceID,
                appPlatform: "ios"
            )
            do {
                let currentPendingCount = outbox.items().count
                NSLog("Claw Bridge relay upload starting; id=\(item.id); configComplete=\(store.configuration.isComplete)")
                publishRelaySnapshot(
                    WatchRelayBridgeSnapshot(
                        state: .uploadingToBridge,
                        relayID: relayID,
                        pendingCount: currentPendingCount,
                        detail: currentPendingCount <= 1 ? "iPhone is uploading it" : "iPhone is uploading \(currentPendingCount) files"
                    )
                )
                let response = try await uploader.upload(request, configuration: store.configuration)
                try outbox.remove(id: item.id)
                refreshOutboxStatus()
                publishRelaySnapshot(
                    WatchRelayBridgeSnapshot(
                        state: .sentToBridge,
                        relayID: relayID,
                        pendingCount: pendingRelayCount,
                        detail: response.queued == true ? "Bridge queued it" : "Bridge accepted it"
                    )
                )
                NSLog("Claw Bridge relay upload succeeded; id=\(item.id); pending=\(pendingRelayCount)")
            } catch {
                let message = error.localizedDescription
                try? outbox.markFailed(id: item.id, error: message)
                refreshOutboxStatus(failure: message)
                publishRelaySnapshot(
                    WatchRelayBridgeSnapshot(
                        state: .retryingBridge,
                        relayID: relayID,
                        pendingCount: pendingRelayCount,
                        detail: pendingRelayCount <= 1 ? "Bridge unreachable; retrying" : "\(pendingRelayCount) queued; retrying"
                    )
                )
                scheduleRetry()
                NSLog("Claw Bridge relay upload failed; id=\(item.id); error=\(message)")
                return
            }
        }
        refreshOutboxStatus()
    }

    private func refreshOutboxStatus(failure: String? = nil) {
        let items = outbox.items()
        let count = items.count
        pendingRelayCount = count
        if count == 0 {
            relayStatusText = "No queued Watch uploads"
        } else if let failure {
            relayStatusText = "Queued \(count); retrying when bridge is reachable"
            latestRelaySnapshot = outboxSnapshot(for: items, failure: failure)
            NSLog("Claw Bridge relay pending after failure; pending=\(count); error=\(failure)")
        } else {
            relayStatusText = "Queued \(count) Watch upload\(count == 1 ? "" : "s")"
            latestRelaySnapshot = outboxSnapshot(for: items)
        }
    }

    private func relayID(for item: CompanionRelayOutboxItem) -> String {
        item.metadata["relay_id"] ?? item.id
    }

    private func outboxSnapshot(
        for items: [CompanionRelayOutboxItem],
        failure: String? = nil
    ) -> WatchRelayBridgeSnapshot? {
        guard let item = items.first else { return nil }
        let message = failure ?? item.lastError
        if message != nil {
            return WatchRelayBridgeSnapshot(
                state: .retryingBridge,
                relayID: relayID(for: item),
                pendingCount: items.count,
                detail: items.count <= 1 ? "Bridge unreachable; retrying" : "\(items.count) queued; retrying"
            )
        }
        return WatchRelayBridgeSnapshot(
            state: .queuedOnPhone,
            relayID: relayID(for: item),
            pendingCount: items.count,
            detail: items.count <= 1 ? "Waiting for bridge upload" : "\(items.count) Watch uploads queued"
        )
    }

    private func sendApplicationContext(
        configuration: BridgeConfiguration,
        relaySnapshot: WatchRelayBridgeSnapshot?
    ) {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated else {
            NSLog("Claw Bridge companion application context send skipped; activationState=\(WCSession.default.activationState.rawValue)")
            return
        }
        var context: [String: Any] = [
            "bearerToken": configuration.bearerToken
        ]
        if let bridgeURL = configuration.bridgeURL?.absoluteString {
            context["bridgeURL"] = bridgeURL
        }
        if let relaySnapshot {
            relaySnapshot.applicationContextFields.forEach { context[$0.key] = $0.value }
        }
        do {
            try WCSession.default.updateApplicationContext(context)
            NSLog("Claw Bridge companion application context sent to Watch; configComplete=\(configuration.isComplete); relayState=\(relaySnapshot?.state.rawValue ?? "none")")
        } catch {
            NSLog("Claw Bridge companion application context send failed: \(error.localizedDescription)")
        }
    }

    private func publishRelaySnapshot(_ snapshot: WatchRelayBridgeSnapshot) {
        latestRelaySnapshot = snapshot
        guard let configuration = store?.configuration else {
            NSLog("Claw Bridge relay snapshot held until configuration is available; state=\(snapshot.state.rawValue)")
            return
        }
        sendApplicationContext(configuration: configuration, relaySnapshot: snapshot)
    }

    private func scheduleRetry() {
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: 30_000_000_000)
            } catch {
                return
            }
            await self?.drainPending(reason: "retry")
        }
    }
}

extension CompanionRelayController: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        NSLog("Claw Bridge companion WCSession activation completed; state=\(activationState.rawValue); error=\(error?.localizedDescription ?? "none")")
        Task { @MainActor in
            guard let store else { return }
            sendConfiguration(store.configuration)
            drainPending(reason: "watch-connectivity-activation")
        }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    nonisolated func session(_ session: WCSession, didReceive file: WCSessionFile) {
        let fileURL = file.fileURL
        let metadata = (file.metadata ?? [:]).compactMapValues { $0 as? String }
        NSLog("Claw Bridge relay received Watch file; metadataKeys=\(metadata.keys.sorted().joined(separator: ","))")
        let relayURL = FileManager.default.temporaryDirectory
            .appending(path: "claw-bridge-relay-\(UUID().uuidString).m4a")
        do {
            try FileManager.default.copyItem(at: fileURL, to: relayURL)
            NSLog("Claw Bridge relay copied Watch file")
        } catch {
            NSLog("Claw Bridge relay copy failed: \(error.localizedDescription)")
            return
        }
        Task { @MainActor in
            enqueue(fileURL: relayURL, metadata: metadata)
            try? FileManager.default.removeItem(at: relayURL)
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
        locationTimestamp = metadata["location_timestamp"]
        locationAgeSeconds = metadata["location_age_seconds"].flatMap(Double.init)
        mapsURL = metadata["maps_url"]
    }
}
