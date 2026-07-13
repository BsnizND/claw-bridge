import Foundation
import Combine
import WatchConnectivity

struct WatchRelayHandoff: Equatable, Sendable {
    var id: String
}

enum WatchRelayHandoffState: Equatable, Sendable {
    case idle
    case pending(id: String?, outstandingCount: Int)
    case transferred(id: String)
    case queuedOnPhone(id: String?, pendingCount: Int, detail: String?)
    case uploadingToBridge(id: String?, pendingCount: Int, detail: String?)
    case retryingBridge(id: String?, pendingCount: Int, detail: String?)
    case sentToBridge(id: String?)
    case failed(id: String?, message: String)

    var title: String? {
        switch self {
        case .idle:
            nil
        case .pending:
            "Relay Pending"
        case .transferred:
            "On iPhone"
        case .queuedOnPhone:
            "Queued on iPhone"
        case .uploadingToBridge:
            "Uploading"
        case .retryingBridge:
            "Retrying"
        case .sentToBridge:
            "Sent"
        case .failed:
            "Relay Failed"
        }
    }

    var detailText: String? {
        switch self {
        case .idle:
            nil
        case .pending(_, let outstandingCount):
            outstandingCount == 1
                ? "Transferring to iPhone"
                : "Transferring \(outstandingCount) files to iPhone"
        case .transferred:
            "iPhone received it"
        case .queuedOnPhone(_, let pendingCount, let detail):
            detail ?? Self.pendingCountText(pendingCount)
        case .uploadingToBridge(_, let pendingCount, let detail):
            detail ?? (pendingCount <= 1 ? "iPhone is uploading it" : "iPhone is uploading \(pendingCount) files")
        case .retryingBridge(_, let pendingCount, let detail):
            detail ?? (pendingCount <= 1 ? "Bridge unreachable; retrying" : "\(pendingCount) queued; retrying")
        case .sentToBridge:
            "Bridge accepted it"
        case .failed(_, let message):
            message
        }
    }

    var isActive: Bool {
        if case .idle = self { return false }
        return true
    }

    private static func pendingCountText(_ pendingCount: Int) -> String {
        pendingCount <= 1 ? "Waiting for bridge upload" : "\(pendingCount) Watch uploads queued"
    }
}

@MainActor
final class WatchRelayController: NSObject, ObservableObject {
    static let shared = WatchRelayController()

    @Published private(set) var handoffState: WatchRelayHandoffState = .idle

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
        refreshOutstandingTransfers(session: session)
        NSLog("Claw Bridge Watch relay WCSession activating; configComplete=\(store.configuration.isComplete)")
    }

    func refreshOutstandingTransfers() {
        guard WCSession.isSupported() else { return }
        refreshOutstandingTransfers(session: WCSession.default)
    }

    func relayAudioFile(
        _ fileURL: URL,
        requestID: String,
        deviceName: String,
        appName: String,
        capturedAt: Date,
        durationSeconds: TimeInterval?,
        location: WatchVoiceLocation?,
        noLocationReason: String? = nil,
        wantsVoiceReply: Bool = false,
        sourceContext: WatchVoiceSourceContext? = nil
    ) throws -> WatchRelayHandoff {
        guard canRelay else {
            throw WatchRelayError.unavailable
        }
        let relayID = UUID().uuidString
        var metadata: [String: String] = [
            "relay_id": relayID,
            "request_id": requestID,
            "source": "watch_app",
            "device_name": deviceName,
            "app_name": appName,
            "captured_at": ISO8601DateFormatter().string(from: capturedAt)
        ]
        if let durationSeconds, durationSeconds.isFinite {
            metadata["recording_duration_seconds"] = String(durationSeconds)
        }
        if wantsVoiceReply {
            metadata["response_mode"] = "voice"
            metadata["walkie_mode"] = "true"
        }
        if let sourceContext {
            metadata["source_context"] = sourceContext.rawValue
        }
        if let location {
            metadata["latitude"] = String(location.latitude)
            metadata["longitude"] = String(location.longitude)
            metadata["altitude"] = location.altitude.map { String($0) }
            metadata["horizontal_accuracy"] = location.horizontalAccuracy.map { String($0) }
            metadata["vertical_accuracy"] = location.verticalAccuracy.map { String($0) }
            metadata["location_timestamp"] = location.locationTimestamp
            metadata["location_age_seconds"] = location.locationAgeSeconds.map { String($0) }
            metadata["maps_url"] = location.mapsURL
        } else if let noLocationReason, noLocationReason.isEmpty == false {
            metadata["no_location_reason"] = noLocationReason
        }
        let transfer = WCSession.default.transferFile(fileURL, metadata: metadata)
        handoffState = .pending(id: relayID, outstandingCount: WCSession.default.outstandingFileTransfers.count)
        NSLog("Claw Bridge Watch started iPhone relay transfer; relayID=\(relayID); transferring=\(transfer.isTransferring)")
        return WatchRelayHandoff(id: relayID)
    }

    private func refreshOutstandingTransfers(session: WCSession) {
        let transfers = session.outstandingFileTransfers
        guard !transfers.isEmpty else {
            if case .pending = handoffState {
                handoffState = .idle
            }
            return
        }
        var latestRelayID: String?
        for transfer in transfers {
            if let id = relayID(from: transfer) {
                latestRelayID = id
            }
        }
        handoffState = .pending(id: latestRelayID, outstandingCount: transfers.count)
    }

    private func relayID(from transfer: WCSessionFileTransfer) -> String? {
        transfer.file.metadata?["relay_id"] as? String
    }

    private func markFinished(relayID: String?, errorMessage: String?) {
        if let errorMessage {
            handoffState = .failed(id: relayID, message: errorMessage)
            NSLog("Claw Bridge Watch iPhone relay transfer failed; relayID=\(relayID ?? "unknown"); error=\(errorMessage)")
            return
        }
        if let relayID {
            handoffState = .transferred(id: relayID)
        } else {
            handoffState = .transferred(id: "unknown")
        }
        NSLog("Claw Bridge Watch iPhone relay transfer finished; relayID=\(relayID ?? "unknown")")
    }

    private func applyBridgeSnapshot(_ snapshot: WatchRelayBridgeSnapshot) {
        guard shouldApplyBridgeSnapshot(snapshot) else { return }
        switch snapshot.state {
        case .receivedByPhone:
            handoffState = .transferred(id: snapshot.relayID ?? "unknown")
        case .queuedOnPhone:
            handoffState = .queuedOnPhone(
                id: snapshot.relayID,
                pendingCount: snapshot.pendingCount,
                detail: snapshot.detail
            )
        case .uploadingToBridge:
            handoffState = .uploadingToBridge(
                id: snapshot.relayID,
                pendingCount: snapshot.pendingCount,
                detail: snapshot.detail
            )
        case .retryingBridge:
            handoffState = .retryingBridge(
                id: snapshot.relayID,
                pendingCount: snapshot.pendingCount,
                detail: snapshot.detail
            )
        case .sentToBridge:
            handoffState = .sentToBridge(id: snapshot.relayID)
        case .failed:
            handoffState = .failed(id: snapshot.relayID, message: snapshot.detail ?? "Relay failed")
        }
        NSLog("Claw Bridge Watch relay bridge state updated; state=\(snapshot.state.rawValue); relayID=\(snapshot.relayID ?? "unknown"); pending=\(snapshot.pendingCount)")
    }

    private func shouldApplyBridgeSnapshot(_ snapshot: WatchRelayBridgeSnapshot) -> Bool {
        guard let snapshotRelayID = snapshot.relayID else { return true }
        switch handoffState {
        case .pending(let currentRelayID, _) where currentRelayID != nil && currentRelayID != snapshotRelayID:
            return false
        default:
            return true
        }
    }
}

extension WatchRelayController: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        NSLog("Claw Bridge Watch relay WCSession activation completed; state=\(activationState.rawValue); error=\(error?.localizedDescription ?? "none")")
        Task { @MainActor in
            refreshOutstandingTransfers()
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        let credentialCommand = BridgeCredentialWatchContext.command(from: applicationContext)
        let relaySnapshot = WatchRelayBridgeSnapshot(applicationContext: applicationContext)
        Task { @MainActor in
            guard let store else { return }
            switch credentialCommand {
            case let .update(bridgeURL, bearerToken):
                do {
                    try store.updateConfiguration(
                        BridgeConfiguration(
                            bridgeURL: bridgeURL ?? store.configuration.bridgeURL,
                            bearerToken: bearerToken
                        )
                    )
                } catch {
                    NSLog("Claw Bridge Watch configuration Keychain save failed: \(error.localizedDescription)")
                }
            case let .clear(bridgeURL):
                do {
                    try store.updateConfiguration(
                        BridgeConfiguration(
                            bridgeURL: bridgeURL ?? store.configuration.bridgeURL,
                            bearerToken: ""
                        )
                    )
                } catch {
                    NSLog("Claw Bridge Watch credential clear failed: \(error.localizedDescription)")
                }
            case .none:
                break
            }
            if let relaySnapshot {
                applyBridgeSnapshot(relaySnapshot)
            }
            NSLog("Claw Bridge Watch received bridge configuration; configComplete=\(store.configuration.isComplete)")
        }
    }

    nonisolated func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
        let relayID = fileTransfer.file.metadata?["relay_id"] as? String
        let errorMessage = error?.localizedDescription
        Task { @MainActor in
            markFinished(relayID: relayID, errorMessage: errorMessage)
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
