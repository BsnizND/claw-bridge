import Foundation
import UIKit
import UserNotifications

extension Notification.Name {
    static let clawBridgeOpenResponse = Notification.Name("clawBridgeOpenResponse")
}

@MainActor
final class CompanionPushController {
    static let shared = CompanionPushController()

    private let defaults = UserDefaults.standard
    private let deviceIDKey = "openclaw.bridge.appDeviceID"
    private var deviceToken: String?

    var deviceID: String {
        if let existing = defaults.string(forKey: deviceIDKey), existing.isEmpty == false {
            return existing
        }
        let created = UUID().uuidString
        defaults.set(created, forKey: deviceIDKey)
        return created
    }

    func requestAuthorizationAndRegister(configuration: BridgeConfiguration) async throws -> String {
        let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        guard granted else { return "Denied" }
        UIApplication.shared.registerForRemoteNotifications()
        if let deviceToken {
            try await registerWithBridge(configuration: configuration, token: deviceToken)
            return "Registered"
        }
        return "Allowed"
    }

    func handleDeviceToken(_ data: Data, configuration: BridgeConfiguration?) {
        deviceToken = data.map { String(format: "%02.2hhx", $0) }.joined()
        guard let configuration, configuration.isComplete, let deviceToken else { return }
        Task {
            try? await registerWithBridge(configuration: configuration, token: deviceToken)
        }
    }

    func handleResponseTap(_ responseID: String) {
        NotificationCenter.default.post(name: .clawBridgeOpenResponse, object: responseID)
    }

    private func registerWithBridge(configuration: BridgeConfiguration, token: String) async throws {
        guard configuration.isComplete, let baseURL = configuration.bridgeURL else {
            throw WalkieResponseError.missingConfiguration
        }
        var request = URLRequest(url: baseURL.appending(path: "app/devices/register"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(configuration.bearerToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "id": deviceID,
            "platform": "ios",
            "push_token": token,
            "app_version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
            "device_name": UIDevice.current.name
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw WalkieResponseError.badResponse
        }
        if !(200..<300).contains(http.statusCode) {
            let decoded = try? JSONDecoder().decode(WatchVoiceUploadResponse.self, from: data)
            throw WalkieResponseError.server(decoded?.error ?? "Bridge returned HTTP \(http.statusCode)")
        }
    }
}

final class OpenClawCompanionAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    var configurationProvider: (() -> BridgeConfiguration?)?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in
            CompanionPushController.shared.handleDeviceToken(deviceToken, configuration: configurationProvider?())
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NSLog("Claw Bridge push registration failed: \(error.localizedDescription)")
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard let responseID = response.notification.request.content.userInfo["response_id"] as? String else { return }
        Task { @MainActor in
            CompanionPushController.shared.handleResponseTap(responseID)
        }
    }
}
