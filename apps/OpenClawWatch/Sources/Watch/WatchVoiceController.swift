import AVFoundation
import CoreLocation
import Foundation

@MainActor
final class WatchVoiceController: NSObject, ObservableObject {
    @Published private(set) var status: WatchVoiceStatus = .idle
    @Published private(set) var detailText: String?

    private let uploader = WatchVoiceUploadClient()
    private let locationManager = CLLocationManager()
    private var recorder: AVAudioRecorder?
    private var currentAudioURL: URL?
    private var latestLocation: CLLocation?

    var isBusy: Bool {
        if case .sending = status { return true }
        return false
    }

    override init() {
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBest
    }

    func toggleRecording(configuration: BridgeConfiguration) async {
        if status.isListening {
            await stopAndSend(configuration: configuration)
        } else {
            await startRecording()
        }
    }

    private func startRecording() async {
        do {
            try await requestMicrophonePermission()
            requestLocation()
            let url = FileManager.default.temporaryDirectory.appending(path: "jay-bridge-watch-\(UUID().uuidString).m4a")
            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 44_100,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
            ]
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder.prepareToRecord()
            recorder.record()
            self.recorder = recorder
            currentAudioURL = url
            status = .recording
            detailText = "Tap again to send"
        } catch {
            status = .failed(error.localizedDescription)
            detailText = error.localizedDescription
        }
    }

    private func stopAndSend(configuration: BridgeConfiguration) async {
        recorder?.stop()
        recorder = nil
        guard let currentAudioURL else {
            status = .failed("No recording found.")
            detailText = "No recording found."
            return
        }
        status = .sending
        detailText = "Uploading"
        do {
            let location = latestLocation.map(WatchVoiceLocation.init(location:))
            let request = WatchVoiceUploadRequest(
                audioFileURL: currentAudioURL,
                deviceName: "Apple Watch",
                appName: "Jay Bridge",
                location: location
            )
            _ = try await uploader.upload(request, configuration: configuration)
            status = .sent
            detailText = location == nil ? "Sent without location" : "Sent with location"
            try? FileManager.default.removeItem(at: currentAudioURL)
            self.currentAudioURL = nil
        } catch {
            do {
                try WatchRelayController.shared.relayAudioFile(
                    currentAudioURL,
                    deviceName: "Apple Watch",
                    appName: "Jay Bridge",
                    location: latestLocation.map(WatchVoiceLocation.init(location:))
                )
                status = .sent
                detailText = "Relayed through iPhone"
            } catch {
                status = .failed(error.localizedDescription)
                detailText = error.localizedDescription
            }
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

    private func requestLocation() {
        switch locationManager.authorizationStatus {
        case .notDetermined:
            locationManager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse, .authorizedAlways:
            locationManager.requestLocation()
        case .denied, .restricted:
            latestLocation = nil
        @unknown default:
            latestLocation = nil
        }
    }
}

extension WatchVoiceController: CLLocationManagerDelegate {
    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in
            latestLocation = locations.last
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            latestLocation = nil
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
