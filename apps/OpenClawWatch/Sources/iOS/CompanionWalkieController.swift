import AVFoundation
import Foundation
import UserNotifications

@MainActor
final class CompanionWalkieController: ObservableObject {
    @Published var messageText = ""
    @Published private(set) var statusText = "Ready"
    @Published private(set) var detailText: String?
    @Published private(set) var isBusy = false
    @Published private(set) var lastResponseID: String?
    @Published private(set) var notificationStatus = "Not requested"

    private let responseClient = WalkieResponseClient()
    private let audioPlayer = WalkieAudioPlayer()

    func requestNotificationPermission() async {
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            notificationStatus = granted ? "Allowed" : "Denied"
        } catch {
            notificationStatus = error.localizedDescription
        }
    }

    func send(configuration: BridgeConfiguration) async {
        let text = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            detailText = "Message is required."
            return
        }
        guard configuration.isComplete, let baseURL = configuration.bridgeURL else {
            detailText = "Bridge configuration required."
            return
        }
        guard baseURL.scheme == "http" || baseURL.scheme == "https" else {
            detailText = "Bridge URL must be HTTP(S)."
            return
        }

        isBusy = true
        statusText = "Sending"
        detailText = nil
        defer { isBusy = false }

        do {
            var request = URLRequest(url: baseURL.appending(path: "shortcuts/message"))
            request.httpMethod = "POST"
            request.setValue("Bearer \(configuration.bearerToken)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "message": text,
                "source": "siri_iphone",
                "device_name": "iPhone",
                "shortcut_name": "Claw Bridge Walkie",
                "response_mode": "voice",
                "walkie_mode": true
            ])
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw WalkieResponseError.badResponse
            }
            let decoded = try? JSONDecoder().decode(WatchVoiceUploadResponse.self, from: data)
            guard (200..<300).contains(http.statusCode), decoded?.ok == true else {
                throw WalkieResponseError.server(decoded?.error ?? "Bridge returned HTTP \(http.statusCode)")
            }
            guard let responseID = decoded?.response_id else {
                throw WalkieResponseError.server("Bridge did not return a voice response id.")
            }
            messageText = ""
            lastResponseID = responseID
            statusText = "Waiting"
            detailText = "Waiting for Jay"
            await play(responseID: responseID, configuration: configuration)
        } catch {
            statusText = "Error"
            detailText = error.localizedDescription
        }
    }

    func replay(configuration: BridgeConfiguration) async {
        guard let lastResponseID else { return }
        await play(responseID: lastResponseID, configuration: configuration)
    }

    private func play(responseID: String, configuration: BridgeConfiguration) async {
        do {
            _ = try await responseClient.waitForReady(id: responseID, configuration: configuration)
            statusText = "Playing"
            detailText = "Playing Jay"
            let audioURL = try await responseClient.downloadAudio(id: responseID, configuration: configuration)
            try audioPlayer.play(url: audioURL)
            statusText = "Reply ready"
            detailText = "Jay replied"
        } catch {
            statusText = "Error"
            detailText = error.localizedDescription
        }
    }
}
