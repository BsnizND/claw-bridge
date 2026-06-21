import CoreLocation
import Foundation

public struct WatchVoiceLocation: Codable, Equatable, Sendable {
    public var latitude: Double
    public var longitude: Double
    public var altitude: Double?
    public var horizontalAccuracy: Double?
    public var verticalAccuracy: Double?
    public var locationTimestamp: String?
    public var locationAgeSeconds: Double?
    public var mapsURL: String?

    public init(location: CLLocation) {
        let capturedAt = Date()
        latitude = location.coordinate.latitude
        longitude = location.coordinate.longitude
        altitude = location.altitude.isFinite ? location.altitude : nil
        horizontalAccuracy = location.horizontalAccuracy.isFinite ? location.horizontalAccuracy : nil
        verticalAccuracy = location.verticalAccuracy.isFinite ? location.verticalAccuracy : nil
        locationTimestamp = ISO8601DateFormatter().string(from: location.timestamp)
        let age = capturedAt.timeIntervalSince(location.timestamp)
        locationAgeSeconds = age.isFinite ? max(0, age) : nil
        mapsURL = "https://maps.apple.com/?ll=\(latitude),\(longitude)"
    }
}

public struct WatchVoiceLocationReceipt: Equatable, Sendable {
    public var location: WatchVoiceLocation?
    public var noLocationReason: String?

    public init(location: WatchVoiceLocation?, noLocationReason: String? = nil) {
        self.location = location
        self.noLocationReason = noLocationReason
    }
}

public enum WatchVoiceStatus: Equatable, Sendable {
    case idle
    case recording
    case sending
    case relayPending
    case sent
    case waitingForReply
    case playing
    case replyReady
    case failed(String)

    public var isListening: Bool {
        if case .recording = self { return true }
        return false
    }

    public var title: String {
        switch self {
        case .idle: "Ready"
        case .recording: "Listening"
        case .sending: "Sending"
        case .relayPending: "Relay Pending"
        case .sent: "Sent"
        case .waitingForReply: "Waiting"
        case .playing: "Playing"
        case .replyReady: "Reply"
        case .failed: "Error"
        }
    }
}

public enum WatchRelayBridgeState: String, Equatable, Sendable {
    case receivedByPhone = "received_by_phone"
    case queuedOnPhone = "queued_on_phone"
    case uploadingToBridge = "uploading_to_bridge"
    case retryingBridge = "retrying_bridge"
    case sentToBridge = "sent_to_bridge"
    case failed = "failed"
}

public struct WatchRelayBridgeSnapshot: Equatable, Sendable {
    public static let stateKey = "watch_relay_state"
    public static let relayIDKey = "watch_relay_id"
    public static let pendingCountKey = "watch_relay_pending_count"
    public static let detailKey = "watch_relay_detail"

    public var state: WatchRelayBridgeState
    public var relayID: String?
    public var pendingCount: Int
    public var detail: String?

    public init(
        state: WatchRelayBridgeState,
        relayID: String? = nil,
        pendingCount: Int = 0,
        detail: String? = nil
    ) {
        self.state = state
        self.relayID = relayID
        self.pendingCount = pendingCount
        self.detail = detail
    }

    public init?(applicationContext: [String: Any]) {
        guard let rawState = applicationContext[Self.stateKey] as? String,
              let state = WatchRelayBridgeState(rawValue: rawState) else {
            return nil
        }
        self.state = state
        relayID = applicationContext[Self.relayIDKey] as? String
        if let count = applicationContext[Self.pendingCountKey] as? Int {
            pendingCount = count
        } else if let count = applicationContext[Self.pendingCountKey] as? NSNumber {
            pendingCount = count.intValue
        } else {
            pendingCount = 0
        }
        detail = applicationContext[Self.detailKey] as? String
    }

    public var applicationContextFields: [String: Any] {
        var context: [String: Any] = [
            Self.stateKey: state.rawValue,
            Self.pendingCountKey: pendingCount
        ]
        if let relayID, relayID.isEmpty == false {
            context[Self.relayIDKey] = relayID
        }
        if let detail, detail.isEmpty == false {
            context[Self.detailKey] = detail
        }
        return context
    }
}

public struct AssistantPortraitCrop: Equatable, Sendable {
    public var focusX: Double
    public var focusY: Double

    public init(focusX: Double = 0.5, focusY: Double = 0.25) {
        self.focusX = focusX
        self.focusY = focusY
    }
}
