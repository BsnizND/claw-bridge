import Foundation

public struct WatchVoiceUploadRequest: Sendable {
    public var audioFileURL: URL
    public var deviceName: String
    public var appName: String
    public var capturedAt: Date
    public var location: WatchVoiceLocation?
    public var wantsVoiceReply: Bool
    public var appDeviceID: String?
    public var appPlatform: String?

    public init(
        audioFileURL: URL,
        deviceName: String,
        appName: String,
        capturedAt: Date = Date(),
        location: WatchVoiceLocation? = nil,
        wantsVoiceReply: Bool = false,
        appDeviceID: String? = nil,
        appPlatform: String? = nil
    ) {
        self.audioFileURL = audioFileURL
        self.deviceName = deviceName
        self.appName = appName
        self.capturedAt = capturedAt
        self.location = location
        self.wantsVoiceReply = wantsVoiceReply
        self.appDeviceID = appDeviceID
        self.appPlatform = appPlatform
    }
}

public struct WatchVoiceUploadResponse: Decodable, Equatable, Sendable {
    public var ok: Bool
    public var queued: Bool?
    public var id: String?
    public var response_id: String?
    public var response_status_url: String?
    public var response_audio_url: String?
    public var error: String?
}

public enum WatchVoiceUploadError: LocalizedError, Equatable {
    case missingConfiguration
    case invalidEndpoint
    case missingAudioFile
    case server(String)
    case badResponse

    public var errorDescription: String? {
        switch self {
        case .missingConfiguration: "Bridge URL and token are required."
        case .invalidEndpoint: "Bridge URL must be a valid HTTP(S) URL."
        case .missingAudioFile: "Recorded audio file is missing."
        case .server(let message): message
        case .badResponse: "Bridge returned an unreadable response."
        }
    }
}

public final class WatchVoiceUploadClient: Sendable {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func upload(
        _ request: WatchVoiceUploadRequest,
        configuration: BridgeConfiguration
    ) async throws -> WatchVoiceUploadResponse {
        guard configuration.isComplete, let baseURL = configuration.bridgeURL else {
            throw WatchVoiceUploadError.missingConfiguration
        }
        guard baseURL.scheme == "http" || baseURL.scheme == "https" else {
            throw WatchVoiceUploadError.invalidEndpoint
        }
        guard FileManager.default.fileExists(atPath: request.audioFileURL.path) else {
            throw WatchVoiceUploadError.missingAudioFile
        }

        let endpoint = baseURL.appending(path: "watch/voice")
        let boundary = "OpenClawWatch-\(UUID().uuidString)"
        var urlRequest = URLRequest(url: endpoint)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("Bearer \(configuration.bearerToken)", forHTTPHeaderField: "Authorization")
        urlRequest.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try multipartBody(for: request, boundary: boundary)

        let (data, response) = try await session.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse else {
            throw WatchVoiceUploadError.badResponse
        }
        let decoded = try? JSONDecoder().decode(WatchVoiceUploadResponse.self, from: data)
        if !(200..<300).contains(http.statusCode) {
            throw WatchVoiceUploadError.server(decoded?.error ?? "Bridge returned HTTP \(http.statusCode)")
        }
        guard let decoded else {
            throw WatchVoiceUploadError.badResponse
        }
        if decoded.ok == false {
            throw WatchVoiceUploadError.server(decoded.error ?? "Bridge rejected the upload.")
        }
        return decoded
    }

    private func multipartBody(for request: WatchVoiceUploadRequest, boundary: String) throws -> Data {
        var body = Data()
        body.appendFormField("source", value: "watch_app", boundary: boundary)
        body.appendFormField("device_name", value: request.deviceName, boundary: boundary)
        body.appendFormField("app_name", value: request.appName, boundary: boundary)
        body.appendFormField("captured_at", value: ISO8601DateFormatter().string(from: request.capturedAt), boundary: boundary)
        if request.wantsVoiceReply {
            body.appendFormField("response_mode", value: "voice", boundary: boundary)
            body.appendFormField("walkie_mode", value: "true", boundary: boundary)
            if let appDeviceID = request.appDeviceID, appDeviceID.isEmpty == false {
                body.appendFormField("app_device_id", value: appDeviceID, boundary: boundary)
            }
            if let appPlatform = request.appPlatform, appPlatform.isEmpty == false {
                body.appendFormField("app_platform", value: appPlatform, boundary: boundary)
            }
        }
        if let location = request.location {
            body.appendFormField("latitude", value: String(location.latitude), boundary: boundary)
            body.appendFormField("longitude", value: String(location.longitude), boundary: boundary)
            if let altitude = location.altitude {
                body.appendFormField("altitude", value: String(altitude), boundary: boundary)
            }
            if let horizontalAccuracy = location.horizontalAccuracy {
                body.appendFormField("horizontal_accuracy", value: String(horizontalAccuracy), boundary: boundary)
            }
            if let verticalAccuracy = location.verticalAccuracy {
                body.appendFormField("vertical_accuracy", value: String(verticalAccuracy), boundary: boundary)
            }
            if let mapsURL = location.mapsURL {
                body.appendFormField("maps_url", value: mapsURL, boundary: boundary)
            }
        }
        let audio = try Data(contentsOf: request.audioFileURL)
        body.appendFileField(
            "audio",
            filename: request.audioFileURL.lastPathComponent,
            mimeType: "audio/mp4",
            data: audio,
            boundary: boundary
        )
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        return body
    }
}

private extension Data {
    mutating func appendFormField(_ name: String, value: String, boundary: String) {
        append("--\(boundary)\r\n".data(using: .utf8)!)
        append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8)!)
        append("\(value)\r\n".data(using: .utf8)!)
    }

    mutating func appendFileField(_ name: String, filename: String, mimeType: String, data: Data, boundary: String) {
        append("--\(boundary)\r\n".data(using: .utf8)!)
        append("Content-Disposition: form-data; name=\"\(name)\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        append(data)
        append("\r\n".data(using: .utf8)!)
    }
}
