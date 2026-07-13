import Combine
import Foundation
import WatchConnectivity

@MainActor
final class CompanionRelayController: NSObject, ObservableObject {
    static let shared = CompanionRelayController()

    @Published private(set) var pendingRelayCount = 0
    @Published private(set) var relayStatusText = "No queued Watch uploads"
    @Published private(set) var isRelayOutboxBlocked = false

    private let uploader: WatchVoiceUploadClient
    private let outbox: CompanionRelayOutbox
    private var store: BridgeConfigurationStore?
    private var isDraining = false
    private var drainRequestedWhileRunning = false
    private var retryTask: Task<Void, Never>?
    private var latestRelaySnapshot: WatchRelayBridgeSnapshot?

    init(
        uploader: WatchVoiceUploadClient = WatchVoiceUploadClient(),
        outbox: CompanionRelayOutbox = CompanionRelayOutbox(),
        store: BridgeConfigurationStore? = nil
    ) {
        self.uploader = uploader
        self.outbox = outbox
        self.store = store
        super.init()
    }

    var isSupported: Bool { WCSession.isSupported() }

    func start(store: BridgeConfigurationStore) {
        self.store = store
        refreshOutboxStatus()
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
        NSLog("Claw Bridge companion WCSession activating; configComplete=\(store.configuration.isComplete)")
        sendConfiguration(store)
        drainPending(reason: "startup")
    }

    func sendConfiguration(_ store: BridgeConfigurationStore) {
        sendApplicationContext(
            configuration: store.configuration,
            credentialSyncState: store.credentialSyncState,
            relaySnapshot: latestRelaySnapshot
        )
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
            guard refreshOutboxStatus() != nil else { return }
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
            surfaceOutboxBlocked(error: error, detail: "iPhone relay queue unavailable; retry blocked")
            publishRelaySnapshot(
                WatchRelayBridgeSnapshot(
                    state: .retryingBridge,
                    relayID: metadata["relay_id"],
                    pendingCount: pendingRelayCount,
                    detail: "iPhone relay queue unavailable; retry blocked"
                )
            )
            NSLog("Claw Bridge relay enqueue failed: \(error.localizedDescription)")
        }
    }

    func drainOutbox(reason: String) async {
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

        guard let items = refreshOutboxStatus() else { return }
        guard !items.isEmpty else {
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
                let message = "Recorded audio file is missing; relay is blocked until the file is recovered."
                guard markOutboxItemFailed(id: item.id, message: message) else { return }
                guard refreshOutboxStatus(failure: message, blocked: true) != nil else { return }
                publishRelaySnapshot(
                    WatchRelayBridgeSnapshot(
                        state: .retryingBridge,
                        relayID: relayID(for: item),
                        pendingCount: pendingRelayCount,
                        detail: "Audio missing on iPhone; relay blocked"
                    )
                )
                NSLog("Claw Bridge relay retained blocked outbox item with missing audio; id=\(item.id)")
                return
            }
            let metadata = item.metadata
            let location = WatchVoiceLocation(metadata: metadata)
            let capturedAt = metadata["captured_at"].flatMap { ISO8601DateFormatter().date(from: $0) } ?? item.createdAt
            let wantsVoiceReply = metadata["response_mode"] == "voice" || metadata["walkie_mode"] == "true"
            let sourceContext = metadata["source_context"].flatMap(WatchVoiceSourceContext.init(rawValue:))
            let relayID = relayID(for: item)
            let request = WatchVoiceUploadRequest(
                requestID: metadata["request_id"] ?? relayID,
                audioFileURL: fileURL,
                deviceName: metadata["device_name"] ?? "Apple Watch",
                appName: metadata["app_name"] ?? "Claw Bridge",
                capturedAt: capturedAt,
                durationSeconds: metadata["recording_duration_seconds"].flatMap(Double.init),
                location: location,
                noLocationReason: metadata["no_location_reason"],
                wantsVoiceReply: wantsVoiceReply,
                appDeviceID: CompanionPushController.shared.deviceID,
                appPlatform: "ios",
                sourceContext: sourceContext
            )
            do {
                let currentPendingCount: Int
                do {
                    currentPendingCount = try outbox.items().count
                } catch {
                    surfaceOutboxBlocked(error: error, detail: "iPhone relay queue unreadable; retry blocked")
                    return
                }
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
                guard refreshOutboxStatus() != nil else { return }
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
                guard markOutboxItemFailed(id: item.id, message: message) else { return }
                guard refreshOutboxStatus(failure: message) != nil else { return }
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

    @discardableResult
    func refreshOutboxStatus(
        failure: String? = nil,
        blocked: Bool = false
    ) -> [CompanionRelayOutboxItem]? {
        let items: [CompanionRelayOutboxItem]
        do {
            items = try outbox.items()
        } catch {
            surfaceOutboxBlocked(error: error, detail: "iPhone relay queue unreadable; retry blocked")
            return nil
        }
        let count = items.count
        pendingRelayCount = count
        isRelayOutboxBlocked = blocked
        if count == 0 {
            relayStatusText = "No queued Watch uploads"
        } else if blocked {
            relayStatusText = "Queued \(count); Watch relay blocked"
            latestRelaySnapshot = outboxSnapshot(for: items, failure: failure, blocked: true)
        } else if let failure {
            relayStatusText = "Queued \(count); retrying when bridge is reachable"
            latestRelaySnapshot = outboxSnapshot(for: items, failure: failure)
            NSLog("Claw Bridge relay pending after failure; pending=\(count); error=\(failure)")
        } else {
            relayStatusText = "Queued \(count) Watch upload\(count == 1 ? "" : "s")"
            latestRelaySnapshot = outboxSnapshot(for: items)
        }
        return items
    }

    private func relayID(for item: CompanionRelayOutboxItem) -> String {
        item.metadata["relay_id"] ?? item.id
    }

    private func outboxSnapshot(
        for items: [CompanionRelayOutboxItem],
        failure: String? = nil,
        blocked: Bool = false
    ) -> WatchRelayBridgeSnapshot? {
        guard let item = items.first else { return nil }
        let message = failure ?? item.lastError
        if message != nil {
            return WatchRelayBridgeSnapshot(
                state: .retryingBridge,
                relayID: relayID(for: item),
                pendingCount: items.count,
                detail: blocked
                    ? "iPhone relay queue blocked"
                    : (items.count <= 1 ? "Bridge unreachable; retrying" : "\(items.count) queued; retrying")
            )
        }
        return WatchRelayBridgeSnapshot(
            state: .queuedOnPhone,
            relayID: relayID(for: item),
            pendingCount: items.count,
            detail: items.count <= 1 ? "Waiting for bridge upload" : "\(items.count) Watch uploads queued"
        )
    }

    private func markOutboxItemFailed(id: String, message: String) -> Bool {
        do {
            try outbox.markFailed(id: id, error: message)
            return true
        } catch {
            surfaceOutboxBlocked(error: error, detail: "iPhone relay queue unreadable; retry blocked")
            return false
        }
    }

    private func surfaceOutboxBlocked(error: Error, detail: String) {
        // An unreadable manifest is actionable pending state with an unknown
        // item count. Keep the existing UI out of its empty/checkmark state.
        pendingRelayCount = max(pendingRelayCount, 1)
        isRelayOutboxBlocked = true
        relayStatusText = "Watch relay blocked; queued uploads need recovery"
        publishRelaySnapshot(
            WatchRelayBridgeSnapshot(
                state: .retryingBridge,
                pendingCount: pendingRelayCount,
                detail: detail
            )
        )
        NSLog("Claw Bridge relay outbox blocked; detail=\(detail); error=\(error.localizedDescription)")
    }

    private func sendApplicationContext(
        configuration: BridgeConfiguration,
        credentialSyncState: BridgeCredentialSyncState,
        relaySnapshot: WatchRelayBridgeSnapshot?
    ) {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated else {
            NSLog("Claw Bridge companion application context send skipped; activationState=\(WCSession.default.activationState.rawValue)")
            return
        }
        guard var context = BridgeCredentialWatchContext.configurationFields(
            configuration: configuration,
            syncState: credentialSyncState
        ) else {
            NSLog("Claw Bridge companion application context held; credential state is not authoritative")
            return
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
        guard let store else {
            NSLog("Claw Bridge relay snapshot held until configuration is available; state=\(snapshot.state.rawValue)")
            return
        }
        sendApplicationContext(
            configuration: store.configuration,
            credentialSyncState: store.credentialSyncState,
            relaySnapshot: snapshot
        )
    }

    private func scheduleRetry() {
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: 30_000_000_000)
            } catch {
                return
            }
            self?.drainPending(reason: "retry")
        }
    }
}

extension CompanionRelayController: WCSessionDelegate {
    nonisolated func session(
        _: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        NSLog("Claw Bridge companion WCSession activation completed; state=\(activationState.rawValue); error=\(error?.localizedDescription ?? "none")")
        Task { @MainActor in
            guard let store else { return }
            sendConfiguration(store)
            drainPending(reason: "watch-connectivity-activation")
        }
    }

    nonisolated func sessionDidBecomeInactive(_: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    nonisolated func session(_: WCSession, didReceive file: WCSessionFile) {
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
              let longitude = Double(longitudeText)
        else {
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
