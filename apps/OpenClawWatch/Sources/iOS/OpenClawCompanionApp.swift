import SwiftUI

@main
struct OpenClawCompanionApp: App {
    @StateObject private var store = BridgeConfigurationStore()

    var body: some Scene {
        WindowGroup {
            CompanionContentView()
                .environmentObject(store)
                .onAppear {
                    CompanionRelayController.shared.start(store: store)
                }
        }
    }
}
