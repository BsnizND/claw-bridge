import SwiftUI
import UIKit

@main
struct OpenClawCompanionApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @UIApplicationDelegateAdaptor(OpenClawCompanionAppDelegate.self) private var appDelegate
    @StateObject private var store = BridgeConfigurationStore()

    var body: some Scene {
        WindowGroup {
            CompanionContentView()
                .environmentObject(store)
                .onAppear {
                    appDelegate.configurationProvider = { store.configuration }
                    CompanionRelayController.shared.start(store: store)
                }
                .onChange(of: scenePhase) {
                    if scenePhase == .active {
                        CompanionRelayController.shared.sendConfiguration(store)
                    }
                }
        }
    }
}
