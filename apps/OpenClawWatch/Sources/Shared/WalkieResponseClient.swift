import AVFoundation
import Foundation

public struct WalkieResponseEnvelope: Decodable, Sendable {
    public var ok: Bool
    public var response: WalkieResponse?
    public var error: String?
}

public struct WalkieResponse: Decodable, Equatable, Sendable {
    public var id: String
    public var request_id: String
    public var mode: String
    public var status: String
    public var created_at: String
    public var updated_at: String
    public var expires_at: String
    public var source: String
    public var assistant: String
    public var device_name: String?
    public var reply_text: String?
    public var audio_mime_type: String?
    public var audio_size_bytes: Int?
    public var audio_url: String?
    public var error: String?
}

public enum WalkieResponseError: LocalizedError {
    case missingConfiguration
    case invalidEndpoint
    case server(String)
    case timedOut
    case notReady(String)
    case badResponse

    public var errorDescription: String? {
        switch self {
        case .missingConfiguration: "Bridge URL and token are required."
        case .invalidEndpoint: "Bridge URL must be a valid HTTP(S) URL."
        case .server(let message): message
        case .timedOut: "Jay's voice reply timed out."
        case .notReady(let status): "Voice reply is \(status)."
        case .badResponse: "Bridge returned an unreadable response."
        }
    }
}

public final class WalkieResponseClient: Sendable {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func response(id: String, configuration: BridgeConfiguration) async throws -> WalkieResponse {
        guard configuration.isComplete, let baseURL = configuration.bridgeURL else {
            throw WalkieResponseError.missingConfiguration
        }
        guard baseURL.scheme == "http" || baseURL.scheme == "https" else {
            throw WalkieResponseError.invalidEndpoint
        }
        var request = URLRequest(url: baseURL.appending(path: "app/responses/\(id)"))
        request.setValue("Bearer \(configuration.bearerToken)", forHTTPHeaderField: "Authorization")
        let (data, urlResponse) = try await session.data(for: request)
        guard let http = urlResponse as? HTTPURLResponse else {
            throw WalkieResponseError.badResponse
        }
        let decoded = try? JSONDecoder().decode(WalkieResponseEnvelope.self, from: data)
        if !(200..<300).contains(http.statusCode) {
            throw WalkieResponseError.server(decoded?.error ?? "Bridge returned HTTP \(http.statusCode)")
        }
        guard let response = decoded?.response else {
            throw WalkieResponseError.badResponse
        }
        return response
    }

    public func waitForReady(
        id: String,
        configuration: BridgeConfiguration,
        attempts: Int = 30,
        delaySeconds: UInt64 = 2
    ) async throws -> WalkieResponse {
        for attempt in 0..<attempts {
            let response = try await response(id: id, configuration: configuration)
            switch response.status {
            case "ready":
                return response
            case "failed", "expired":
                throw WalkieResponseError.server(response.error ?? "Voice reply \(response.status).")
            default:
                if attempt < attempts - 1 {
                    try await Task.sleep(for: .seconds(delaySeconds))
                }
            }
        }
        throw WalkieResponseError.timedOut
    }

    public func downloadAudio(id: String, configuration: BridgeConfiguration) async throws -> URL {
        guard configuration.isComplete, let baseURL = configuration.bridgeURL else {
            throw WalkieResponseError.missingConfiguration
        }
        guard baseURL.scheme == "http" || baseURL.scheme == "https" else {
            throw WalkieResponseError.invalidEndpoint
        }
        var request = URLRequest(url: baseURL.appending(path: "app/responses/\(id)/audio"))
        request.setValue("Bearer \(configuration.bearerToken)", forHTTPHeaderField: "Authorization")
        let (temporaryURL, urlResponse) = try await session.download(for: request)
        guard let http = urlResponse as? HTTPURLResponse else {
            throw WalkieResponseError.badResponse
        }
        if !(200..<300).contains(http.statusCode) {
            throw WalkieResponseError.server("Bridge returned HTTP \(http.statusCode)")
        }
        let destination = FileManager.default.temporaryDirectory.appending(path: "claw-bridge-reply-\(id).mp3")
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: temporaryURL, to: destination)
        return destination
    }
}

@MainActor
public final class WalkieAudioPlayer: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published public private(set) var isPlaying = false

    private var player: AVAudioPlayer?

    public func play(url: URL) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .spokenAudio)
        try session.setActive(true)
        let player = try AVAudioPlayer(contentsOf: url)
        player.delegate = self
        player.prepareToPlay()
        guard player.play() else {
            throw WalkieResponseError.server("Audio playback failed.")
        }
        self.player = player
        isPlaying = true
    }

    public func stop() {
        player?.stop()
        player = nil
        isPlaying = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    nonisolated public func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.isPlaying = false
            self.player = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }
}
