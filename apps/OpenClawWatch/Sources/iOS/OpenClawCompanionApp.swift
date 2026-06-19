import SwiftUI
import UIKit

@main
struct OpenClawCompanionApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @UIApplicationDelegateAdaptor(OpenClawCompanionAppDelegate.self) private var appDelegate
    @StateObject private var store = BridgeConfigurationStore()

    init() {
        CompanionRelayController.shared.start(store: store)
    }

    var body: some Scene {
        WindowGroup {
            CompanionContentView()
                .environmentObject(store)
                .onAppear {
                    appDelegate.configurationProvider = { store.configuration }
                    CompanionRelayController.shared.start(store: store)
                }
                .onChange(of: scenePhase) { phase in
                    if phase == .active {
                        CompanionRelayController.shared.drainPending(reason: "foreground")
                    }
                }
        }
    }
}
