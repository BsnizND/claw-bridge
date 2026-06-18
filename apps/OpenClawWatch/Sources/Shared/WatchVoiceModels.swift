import CoreLocation
import Foundation

public struct WatchVoiceLocation: Codable, Equatable, Sendable {
    public var latitude: Double
    public var longitude: Double
    public var altitude: Double?
    public var horizontalAccuracy: Double?
    public var verticalAccuracy: Double?
    public var mapsURL: String?

    public init(location: CLLocation) {
        latitude = location.coordinate.latitude
        longitude = location.coordinate.longitude
        altitude = location.altitude.isFinite ? location.altitude : nil
        horizontalAccuracy = location.horizontalAccuracy.isFinite ? location.horizontalAccuracy : nil
        verticalAccuracy = location.verticalAccuracy.isFinite ? location.verticalAccuracy : nil
        mapsURL = "https://maps.apple.com/?ll=\(latitude),\(longitude)"
    }
}

public enum WatchVoiceStatus: Equatable, Sendable {
    case idle
    case recording
    case sending
    case queued
    case sent
    case waitingForReply
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
        case .queued: "Queued"
        case .sent: "Sent"
        case .waitingForReply: "Waiting"
        case .replyReady: "Reply"
        case .failed: "Error"
        }
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
