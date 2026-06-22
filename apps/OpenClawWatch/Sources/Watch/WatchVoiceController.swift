import AVFoundation
import CoreLocation
import Foundation
import WatchKit

@MainActor
final class WatchVoiceController: NSObject, ObservableObject {
    @Published private(set) var status: WatchVoiceStatus = .idle
    @Published private(set) var detailText: String?
    @Published private(set) var lastResponseID: String?
    @Published private(set) var isAwaitingReply = false
    @Published private(set) var locationReadiness: WatchLocationReadiness = .unknown

    private let uploader = WatchVoiceUploadClient()
    private let responseClient = WalkieResponseClient()
    private let audioPlayer = WalkieAudioPlayer()
    private let locationManager = CLLocationManager()
    private let minimumRecordingByteCount: UInt64 = 4_096
    private let minimumRecordingDuration: TimeInterval = 1.5
    private let maximumRecordingDuration: TimeInterval = 120
    private let maximumRecordingDurationGrace: TimeInterval = 1
    private let maximumLocationAge: TimeInterval = 120
    private let locationUploadTimeoutNanoseconds: UInt64 = 4_000_000_000
    private let requiredLocationUploadTimeoutNanoseconds: UInt64 = 15_000_000_000
    private let locationAuthorizationPollNanoseconds: UInt64 = 250_000_000
    private var recorder: AVAudioRecorder?
    private var currentAudioURL: URL?
    private var recordingStartedAt: Date?
    private var latestLocation: CLLocation?
    private var pendingLocationContinuation: CheckedContinuation<WatchVoiceLocationReceipt, Never>?
    private var locationTimeoutTask: Task<Void, Never>?
    private var responsePlaybackTask: Task<Void, Never>?
    private var responsePlaybackToken: UUID?

    var isBusy: Bool {
        isRecordControlBusy || isReplyPlaying
    }

    var isRecordControlBusy: Bool {
        if isReplyPlaying { return false }
        if case .sending = status { return true }
        if case .relayPending = status { return true }
        if case .waitingForReply = status { return true }
        if isAwaitingReply { return true }
        return false
    }

    var isReplyPlaying: Bool {
        if case .playing = status { return true }
        return false
    }

    override init() {
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBest
        refreshLocationReadiness()
    }

    func toggleRecording(
        configuration: BridgeConfiguration,
        wantsVoiceReply: Bool = false,
        sourceContext: WatchVoiceSourceContext? = nil
    ) async {
        if status.isListening {
            guard canStopCurrentRecording else {
                detailText = "Keep talking"
                return
            }
            await stopAndSend(
                configuration: configuration,
                wantsVoiceReply: wantsVoiceReply,
                sourceContext: sourceContext
            )
        } else {
            cancelResponsePlayback()
            await startRecording()
        }
    }

    func startRecordingFromComplication() async {
        guard !status.isListening else { return }
        if case .sending = status { return }
        cancelResponsePlayback()
        await startRecording()
    }

    func warmLocationForGolfMode() {
        requestLocationPermissionIfNeeded()
    }

    func stopPlayback() {
        cancelResponsePlayback()
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
            recorder.delegate = self
            recorder.prepareToRecord()
            guard recorder.record(forDuration: maximumRecordingDuration) else {
                recorder.deleteRecording()
                try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                throw WatchVoiceRecordingError.failedToStart
            }
            self.recorder = recorder
            currentAudioURL = url
            recordingStartedAt = Date()
            status = .recording
            detailText = "Tap again to send"
            WKInterfaceDevice.current().play(.start)
        } catch {
            status = .failed(error.localizedDescription)
            detailText = error.localizedDescription
            WKInterfaceDevice.current().play(.failure)
        }
    }

    private func stopAndSend(
        configuration: BridgeConfiguration,
        wantsVoiceReply: Bool,
        sourceContext: WatchVoiceSourceContext?
    ) async {
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
            WKInterfaceDevice.current().play(.failure)
            return
        }
        status = .sending
        let requiresLocation = sourceContext == .golfMode
        detailText = requiresLocation ? "Getting GPS" : "Getting location"
        let locationReceipt = await locationForUpload(requireLocation: requiresLocation)
        let location = locationReceipt.location
        detailText = location == nil ? "Uploading without location" : "Uploading"
        do {
            let request = WatchVoiceUploadRequest(
                audioFileURL: currentAudioURL,
                deviceName: "Apple Watch",
                appName: "Claw Bridge",
                durationSeconds: recordingDuration,
                location: location,
                noLocationReason: locationReceipt.noLocationReason,
                wantsVoiceReply: wantsVoiceReply,
                sourceContext: sourceContext
            )
            let response = try await uploader.upload(request, configuration: configuration)
            try? FileManager.default.removeItem(at: currentAudioURL)
            self.currentAudioURL = nil
            recordingStartedAt = nil
            if wantsVoiceReply, let responseID = response.response_id {
                lastResponseID = responseID
                status = .sent
                detailText = "Sent. Waiting for Jay"
                WKInterfaceDevice.current().play(.success)
                beginResponsePlayback(responseID, configuration: configuration, preserveSentStatus: true)
            } else {
                status = .sent
                detailText = location == nil ? "Sent without location" : "Sent with location"
                WKInterfaceDevice.current().play(.success)
            }
        } catch {
            NSLog("Claw Bridge Watch direct upload failed: \(error.localizedDescription)")
            do {
                _ = try WatchRelayController.shared.relayAudioFile(
                    currentAudioURL,
                    deviceName: "Apple Watch",
                    appName: "Claw Bridge",
                    durationSeconds: recordingDuration,
                    location: location,
                    noLocationReason: locationReceipt.noLocationReason,
                    wantsVoiceReply: wantsVoiceReply,
                    sourceContext: sourceContext
                )
                status = .relayPending
                detailText = "Transferring to iPhone"
                WKInterfaceDevice.current().play(.notification)
            } catch {
                status = .failed(error.localizedDescription)
                detailText = error.localizedDescription
                WKInterfaceDevice.current().play(.failure)
            }
        }
    }

    func replayLastResponse(configuration: BridgeConfiguration) async {
        guard let lastResponseID else { return }
        beginResponsePlayback(lastResponseID, configuration: configuration, preserveSentStatus: false)
    }

    func pauseLastResponse() {
        cancelResponsePlayback()
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
            WKInterfaceDevice.current().play(.failure)
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
        guard duration <= maximumRecordingDuration + maximumRecordingDurationGrace else {
            throw WatchVoiceRecordingError.tooLong(maximumRecordingDuration)
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
            locationReadiness = .waiting
            detailText = "Allow location to attach it"
            locationManager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse, .authorizedAlways:
            locationReadiness = freshLocation() == nil ? .waiting : .ready
            locationManager.requestLocation()
        case .denied, .restricted:
            latestLocation = nil
            locationReadiness = .denied
        @unknown default:
            latestLocation = nil
            locationReadiness = .unknown
        }
    }

    private func freshLocation() -> CLLocation? {
        guard let latestLocation, abs(latestLocation.timestamp.timeIntervalSinceNow) < maximumLocationAge else {
            return nil
        }
        return latestLocation
    }

    private func locationForUpload(requireLocation: Bool = false) async -> WatchVoiceLocationReceipt {
        var authorizationStatus = locationManager.authorizationStatus
        if authorizationStatus == .notDetermined, requireLocation {
            locationReadiness = .waiting
            detailText = "Allow location"
            locationManager.requestWhenInUseAuthorization()
            authorizationStatus = await waitForLocationAuthorization(timeoutNanoseconds: requiredLocationUploadTimeoutNanoseconds)
        }

        switch authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            break
        case .notDetermined:
            latestLocation = nil
            locationReadiness = requireLocation ? .unavailable : .unknown
            return WatchVoiceLocationReceipt(location: nil, noLocationReason: "permission_not_determined")
        case .denied:
            latestLocation = nil
            locationReadiness = .denied
            return WatchVoiceLocationReceipt(location: nil, noLocationReason: "permission_denied")
        case .restricted:
            latestLocation = nil
            locationReadiness = .denied
            return WatchVoiceLocationReceipt(location: nil, noLocationReason: "permission_restricted")
        @unknown default:
            latestLocation = nil
            locationReadiness = .unknown
            return WatchVoiceLocationReceipt(location: nil, noLocationReason: "permission_unknown")
        }
        if let latestLocation = freshLocation() {
            locationReadiness = .ready
            return WatchVoiceLocationReceipt(location: WatchVoiceLocation(location: latestLocation))
        }

        pendingLocationContinuation?.resume(
            returning: WatchVoiceLocationReceipt(location: nil, noLocationReason: "superseded_location_request")
        )
        locationTimeoutTask?.cancel()
        locationReadiness = .waiting
        locationManager.requestLocation()
        let timeoutNanoseconds = requireLocation ? requiredLocationUploadTimeoutNanoseconds : locationUploadTimeoutNanoseconds
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

    private func waitForLocationAuthorization(timeoutNanoseconds: UInt64) async -> CLAuthorizationStatus {
        let deadline = Date().addingTimeInterval(TimeInterval(timeoutNanoseconds) / 1_000_000_000)
        while Date() < deadline {
            let status = locationManager.authorizationStatus
            if status != .notDetermined {
                return status
            }
            do {
                try await Task.sleep(nanoseconds: locationAuthorizationPollNanoseconds)
            } catch {
                return locationManager.authorizationStatus
            }
        }
        return locationManager.authorizationStatus
    }

    private func resolvePendingLocation(_ location: CLLocation?, noLocationReason: String? = nil) {
        guard let continuation = pendingLocationContinuation else { return }
        pendingLocationContinuation = nil
        locationTimeoutTask?.cancel()
        locationTimeoutTask = nil
        locationReadiness = location == nil ? .unavailable : .ready
        continuation.resume(
            returning: WatchVoiceLocationReceipt(
                location: location.map(WatchVoiceLocation.init(location:)),
                noLocationReason: location == nil ? noLocationReason ?? "location_unavailable" : nil
            )
        )
    }

    private func refreshLocationReadiness() {
        switch locationManager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            locationReadiness = freshLocation() == nil ? .waiting : .ready
        case .denied, .restricted:
            locationReadiness = .denied
        case .notDetermined:
            locationReadiness = .unknown
        @unknown default:
            locationReadiness = .unknown
        }
    }
}

extension WatchVoiceController: AVAudioRecorderDelegate {
    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        Task { @MainActor in
            guard self.recorder === recorder, self.status.isListening else { return }
            if flag && recorder.currentTime >= self.maximumRecordingDuration - 0.25 {
                self.detailText = "Max length reached. Tap to send."
                WKInterfaceDevice.current().play(.notification)
            }
        }
    }
}

extension WatchVoiceController: CLLocationManagerDelegate {
    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in
            let location = locations.last
            latestLocation = location
            locationReadiness = location == nil ? .unavailable : .ready
            resolvePendingLocation(location)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            latestLocation = nil
            locationReadiness = .unavailable
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
                locationReadiness = freshLocation() == nil ? .waiting : .ready
                locationManager.requestLocation()
            case .denied, .restricted:
                locationReadiness = .denied
                latestLocation = nil
                resolvePendingLocation(nil, noLocationReason: "permission_unavailable")
            default:
                locationReadiness = .unknown
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
    case tooLong(TimeInterval)

    var errorDescription: String? {
        switch self {
        case .failedToStart: "Recording could not start."
        case .emptyRecording: "Nothing recorded. Try again."
        case .tooShort: "Message was too short. Try again."
        case .tooLong(let seconds): "Message is too long. Keep Watch messages under \(Int(seconds)) seconds."
        }
    }
}
