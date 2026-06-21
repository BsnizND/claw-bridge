import SwiftUI

struct WatchContentView: View {
    @EnvironmentObject private var store: BridgeConfigurationStore
    @StateObject private var controller = WatchVoiceController()
    @ObservedObject private var relay = WatchRelayController.shared
    @AppStorage("clawBridgeWalkieMode") private var walkieMode = false
    @AppStorage("clawBridgeGolfMode") private var golfMode = false

    var body: some View {
        VStack(spacing: 10) {
            AssistantPortraitView(status: controller.status)
                .frame(maxWidth: 116)

            Text(displayedStatusTitle)
                .font(.headline)
                .lineLimit(1)

            Toggle(isOn: $walkieMode) {
                Image(systemName: walkieMode ? "waveform.circle.fill" : "paperplane.circle")
            }
            .labelsHidden()
            .tint(.green)
            .accessibilityLabel("Walkie mode")

            Toggle(isOn: $golfMode) {
                Image(systemName: golfMode ? "flag.checkered.circle.fill" : "flag.circle")
            }
            .labelsHidden()
            .tint(.orange)
            .accessibilityLabel("Golf mode")

            Button {
                Task {
                    await controller.toggleRecording(
                        configuration: store.configuration,
                        wantsVoiceReply: walkieMode,
                        sourceContext: golfMode ? .golfMode : nil
                    )
                }
            } label: {
                Image(systemName: controller.status.isListening ? "stop.fill" : "mic.fill")
                    .font(.title2.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .frame(height: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(controller.status.isListening ? .red : .blue)
            .disabled(controller.isBusy)
            .accessibilityLabel(controller.status.isListening ? "Stop recording" : "Start recording")

            if controller.lastResponseID != nil {
                Button {
                    Task {
                        await controller.replayLastResponse(configuration: store.configuration)
                    }
                } label: {
                    Image(systemName: "play.fill")
                        .frame(maxWidth: .infinity)
                        .frame(height: 32)
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("Replay Jay")
            }

            if let detail = displayedDetailText {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
            }
        }
        .padding(.horizontal, 10)
        .onAppear {
            relay.refreshOutstandingTransfers()
        }
        .onOpenURL { url in
            guard url.scheme == "clawbridge",
                  url.host == "record" || url.path == "/record" else {
                return
            }
            Task {
                await controller.startRecordingFromComplication()
            }
        }
    }

    private var displayedStatusTitle: String {
        if shouldShowRelayState {
            return relay.handoffState.title ?? "Relay Unknown"
        }
        return controller.status.title
    }

    private var displayedDetailText: String? {
        if shouldShowRelayState {
            return relay.handoffState.detailText ?? "No active iPhone transfer found"
        }
        return controller.detailText
    }

    private var shouldShowRelayState: Bool {
        switch controller.status {
        case .relayPending:
            return true
        case .idle:
            return relay.handoffState.isActive
        default:
            return false
        }
    }
}

#Preview {
    WatchContentView()
        .environmentObject(BridgeConfigurationStore(defaults: UserDefaults(suiteName: "watch-preview")!))
}
