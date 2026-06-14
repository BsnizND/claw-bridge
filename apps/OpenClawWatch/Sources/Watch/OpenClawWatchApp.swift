import SwiftUI

@main
struct OpenClawWatchApp: App {
    @StateObject private var store = BridgeConfigurationStore()

    var body: some Scene {
        WindowGroup {
            WatchContentView()
                .environmentObject(store)
                .onAppear {
                    WatchRelayController.shared.start(store: store)
                }
        }
    }
}
