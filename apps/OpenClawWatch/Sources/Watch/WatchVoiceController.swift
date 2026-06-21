import AVFoundation
import CoreLocation
import Foundation

@MainActor
final class WatchVoiceController: NSObject, ObservableObject {
    @Published private(set) var status: WatchVoiceStatus = .idle
    @Published private(set) var detailText: String?
    @Published private(set) var lastResponseID: String?
    @Published private(set) var isAwaitingReply = false

    private let uploader = WatchVoiceUploadClient()
    private let responseClient = WalkieResponseClient()
    private let audioPlayer = WalkieAudioPlayer()
    private let locationManager = CLLocationManager()
    private let minimumRecordingByteCount: UInt64 = 4_096
    private let minimumRecordingDuration: TimeInterval = 0.8
    private let maximumLocationAge: TimeInterval = 120
    private let locationUploadTimeoutNanoseconds: UInt64 = 4_000_000_000
    private var recorder: AVAudioRecorder?
    private var currentAudioURL: URL?
    private var recordingStartedAt: Date?
    private var latestLocation: CLLocation?
    private var pendingLocationContinuation: CheckedContinuation<WatchVoiceLocationReceipt, Never>?
    private var locationTimeoutTask: Task<Void, Never>?
    private var responsePlaybackTask: Task<Void, Never>?
    private var responsePlaybackToken: UUID?

    var isBusy: Bool {
        if case .sending = status { return true }
        if case .playing = status { return true }
        if isAwaitingReply { return true }
        return false
    }

    override init() {
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBest
    }

    func toggleRecording(configuration: BridgeConfiguration, wantsVoiceReply: Bool = false) async {
        if status.isListening {
            guard canStopCurrentRecording else {
                detailText = "Keep talking"
                return
            }
            await stopAndSend(configuration: configuration, wantsVoiceReply: wantsVoiceReply)
        } else {
            await startRecording()
        }
    }

    func startRecordingFromComplication() async {
        guard !status.isListening else { return }
        if case .sending = status { return }
        cancelResponsePlayback()
        await startRecording()
    }

    private func startRecording() async {
        do {
            try await requestMicrophonePermission()
            try configureAudioSessionForRecording()
            requestLocationPermissionIfNeeded()
            let url = FileManager.default.temporaryDirectory.appending(path: "claw-bridge-watch-\(UUID().uuidString).m4a")
            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 44_100,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
            ]
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder.prepareToRecord()
            guard recorder.record() else {
                recorder.deleteRecording()
                try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                throw WatchVoiceRecordingError.failedToStart
            }
            self.recorder = recorder
            currentAudioURL = url
            recordingStartedAt = Date()
            status = .recording
            detailText = "Tap again to send"
        } catch {
            status = .failed(error.localizedDescription)
            detailText = error.localizedDescription
        }
    }

    private func stopAndSend(configuration: BridgeConfiguration, wantsVoiceReply: Bool) async {
        let recordingDuration = recorder?.currentTime ?? recordingElapsedTime
        recorder?.stop()
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        guard let currentAudioURL else {
            status = .failed("No recording found.")
            detailText = "No recording found."
            return
        }
        do {
            try validateRecording(at: currentAudioURL, duration: recordingDuration)
        } catch {
            status = .idle
            detailText = error.localizedDescription
            try? FileManager.default.removeItem(at: currentAudioURL)
            self.currentAudioURL = nil
            recordingStartedAt = nil
            return
        }
        status = .sending
        detailText = "Getting location"
        let locationReceipt = await locationForUpload()
        let location = locationReceipt.location
        detailText = location == nil ? "Uploading without location" : "Uploading"
        do {
            let request = WatchVoiceUploadRequest(
                audioFileURL: currentAudioURL,
                deviceName: "Apple Watch",
                appName: "Claw Bridge",
                location: location,
                noLocationReason: locationReceipt.noLocationReason,
                wantsVoiceReply: wantsVoiceReply
            )
            let response = try await uploader.upload(request, configuration: configuration)
            try? FileManager.default.removeItem(at: currentAudioURL)
            self.currentAudioURL = nil
            recordingStartedAt = nil
            if wantsVoiceReply, let responseID = response.response_id {
                lastResponseID = responseID
                status = .sent
                detailText = "Sent. Waiting for Jay"
                beginResponsePlayback(responseID, configuration: configuration, preserveSentStatus: true)
            } else {
                status = .sent
                detailText = location == nil ? "Sent without location" : "Sent with location"
            }
        } catch {
            NSLog("Claw Bridge Watch direct upload failed: \(error.localizedDescription)")
            do {
                _ = try WatchRelayController.shared.relayAudioFile(
                    currentAudioURL,
                    deviceName: "Apple Watch",
                    appName: "Claw Bridge",
                    location: location,
                    noLocationReason: locationReceipt.noLocationReason,
                    wantsVoiceReply: wantsVoiceReply
                )
                status = .relayPending
                detailText = "Transferring to iPhone"
            } catch {
                status = .failed(error.localizedDescription)
                detailText = error.localizedDescription
            }
        }
    }

    func replayLastResponse(configuration: BridgeConfiguration) async {
        guard let lastResponseID else { return }
        beginResponsePlayback(lastResponseID, configuration: configuration, preserveSentStatus: false)
    }

    private func cancelResponsePlayback() {
        responsePlaybackTask?.cancel()
        responsePlaybackTask = nil
        responsePlaybackToken = nil
        isAwaitingReply = false
        audioPlayer.stop()
        switch status {
        case .waitingForReply, .playing, .replyReady, .failed:
            status = .idle
            detailText = nil
        default:
            break
        }
    }

    private func beginResponsePlayback(
        _ responseID: String,
        configuration: BridgeConfiguration,
        preserveSentStatus: Bool
    ) {
        responsePlaybackTask?.cancel()
        let token = UUID()
        responsePlaybackToken = token
        isAwaitingReply = true
        if !preserveSentStatus {
            status = .waitingForReply
        }
        detailText = "Waiting for Jay"
        responsePlaybackTask = Task { [weak self] in
            await self?.waitForAndPlayResponse(
                responseID,
                configuration: configuration,
                preserveSentStatus: preserveSentStatus,
                token: token
            )
        }
    }

    private func waitForAndPlayResponse(
        _ responseID: String,
        configuration: BridgeConfiguration,
        preserveSentStatus: Bool,
        token: UUID
    ) async {
        defer {
            if responsePlaybackToken == token {
                isAwaitingReply = false
                responsePlaybackTask = nil
                responsePlaybackToken = nil
            }
        }
        do {
            if !preserveSentStatus {
                status = .waitingForReply
                detailText = "Waiting for Jay"
            }
            _ = try await responseClient.waitForReady(id: responseID, configuration: configuration)
            guard !Task.isCancelled else { return }
            status = .playing
            detailText = "Playing Jay"
            let audioURL = try await responseClient.downloadAudio(id: responseID, configuration: configuration)
            guard !Task.isCancelled else { return }
            let finished = try await audioPlayer.play(url: audioURL)
            guard !Task.isCancelled else { return }
            status = .replyReady
            detailText = finished ? "Jay replied" : "Playback stopped"
        } catch {
            guard !Task.isCancelled else { return }
            status = .failed(error.localizedDescription)
            detailText = error.localizedDescription
        }
    }

    private func configureAudioSessionForRecording() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .spokenAudio)
        try session.setActive(true)
    }

    private var recordingElapsedTime: TimeInterval {
        guard let recordingStartedAt else { return 0 }
        return Date().timeIntervalSince(recordingStartedAt)
    }

    private var canStopCurrentRecording: Bool {
        recordingElapsedTime >= minimumRecordingDuration
    }

    private func validateRecording(at url: URL, duration: TimeInterval) throws {
        guard duration >= minimumRecordingDuration else {
            throw WatchVoiceRecordingError.tooShort
        }
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let byteCount = attributes[.size] as? UInt64 ?? 0
        guard byteCount >= minimumRecordingByteCount else {
            throw WatchVoiceRecordingError.emptyRecording
        }
    }

    private func requestMicrophonePermission() async throws {
        let granted = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
        if !granted {
            throw WatchVoicePermissionError.microphoneDenied
        }
    }

    private func requestLocationPermissionIfNeeded() {
        switch locationManager.authorizationStatus {
        case .notDetermined:
            detailText = "Allow location to attach it"
            locationManager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse, .authorizedAlways:
            locationManager.requestLocation()
        case .denied, .restricted:
            latestLocation = nil
        @unknown default:
            latestLocation = nil
        }
    }

    private func freshLocation() -> CLLocation? {
        guard let latestLocation, abs(latestLocation.timestamp.timeIntervalSinceNow) < maximumLocationAge else {
            return nil
        }
        return latestLocation
    }

    private func locationForUpload() async -> WatchVoiceLocationReceipt {
        let authorizationStatus = locationManager.authorizationStatus
        switch authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            break
        case .notDetermined:
            latestLocation = nil
            return WatchVoiceLocationReceipt(location: nil, noLocationReason: "permission_not_determined")
        case .denied:
            latestLocation = nil
            return WatchVoiceLocationReceipt(location: nil, noLocationReason: "permission_denied")
        case .restricted:
            latestLocation = nil
            return WatchVoiceLocationReceipt(location: nil, noLocationReason: "permission_restricted")
        @unknown default:
            latestLocation = nil
            return WatchVoiceLocationReceipt(location: nil, noLocationReason: "permission_unknown")
        }
        if let latestLocation = freshLocation() {
            return WatchVoiceLocationReceipt(location: WatchVoiceLocation(location: latestLocation))
        }

        pendingLocationContinuation?.resume(
            returning: WatchVoiceLocationReceipt(location: nil, noLocationReason: "superseded_location_request")
        )
        locationTimeoutTask?.cancel()
        locationManager.requestLocation()
        let timeoutNanoseconds = locationUploadTimeoutNanoseconds
        return await withCheckedContinuation { continuation in
            pendingLocationContinuation = continuation
            locationTimeoutTask = Task { [weak self] in
                do {
                    try await Task.sleep(nanoseconds: timeoutNanoseconds)
                } catch {
                    return
                }
                await MainActor.run {
                    self?.resolvePendingLocation(nil, noLocationReason: "location_timeout")
                }
            }
        }
    }

    private func resolvePendingLocation(_ location: CLLocation?, noLocationReason: String? = nil) {
        guard let continuation = pendingLocationContinuation else { return }
        pendingLocationContinuation = nil
        locationTimeoutTask?.cancel()
        locationTimeoutTask = nil
        continuation.resume(
            returning: WatchVoiceLocationReceipt(
                location: location.map(WatchVoiceLocation.init(location:)),
                noLocationReason: location == nil ? noLocationReason ?? "location_unavailable" : nil
            )
        )
    }
}

extension WatchVoiceController: CLLocationManagerDelegate {
    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in
            let location = locations.last
            latestLocation = location
            resolvePendingLocation(location)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            latestLocation = nil
            resolvePendingLocation(nil, noLocationReason: "location_error")
            if status.isListening {
                detailText = "Listening without location"
            }
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let authorizationStatus = manager.authorizationStatus
        Task { @MainActor in
            switch authorizationStatus {
            case .authorizedWhenInUse, .authorizedAlways:
                locationManager.requestLocation()
            default:
                latestLocation = nil
                resolvePendingLocation(nil, noLocationReason: "permission_unavailable")
            }
        }
    }
}

enum WatchVoicePermissionError: LocalizedError {
    case microphoneDenied

    var errorDescription: String? {
        switch self {
        case .microphoneDenied: "Microphone permission is required."
        }
    }
}

enum WatchVoiceRecordingError: LocalizedError {
    case failedToStart
    case emptyRecording
    case tooShort

    var errorDescription: String? {
        switch self {
        case .failedToStart: "Recording could not start."
        case .emptyRecording: "Nothing recorded. Try again."
        case .tooShort: "Message was too short. Try again."
        }
    }
}
