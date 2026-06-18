import SwiftUI

struct WatchContentView: View {
    @EnvironmentObject private var store: BridgeConfigurationStore
    @StateObject private var controller = WatchVoiceController()
    @State private var walkieMode = false

    var body: some View {
        VStack(spacing: 10) {
            AssistantPortraitView(status: controller.status)
                .frame(maxWidth: 116)

            Text(controller.status.title)
                .font(.headline)
                .lineLimit(1)

            Toggle(isOn: $walkieMode) {
                Image(systemName: walkieMode ? "waveform.circle.fill" : "paperplane.circle")
            }
            .labelsHidden()
            .tint(.green)
            .accessibilityLabel("Walkie mode")

            Button {
                Task {
                    await controller.toggleRecording(configuration: store.configuration, wantsVoiceReply: walkieMode)
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

            if let detail = controller.detailText {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
            }
        }
        .padding(.horizontal, 10)
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
}

#Preview {
    WatchContentView()
        .environmentObject(BridgeConfigurationStore(defaults: UserDefaults(suiteName: "watch-preview")!))
}
