import SwiftUI

struct WatchContentView: View {
    @EnvironmentObject private var store: BridgeConfigurationStore
    @StateObject private var controller = WatchVoiceController()
    @StateObject private var golfWorkout = GolfWorkoutController()
    @ObservedObject private var relay = WatchRelayController.shared
    @AppStorage("clawBridgeWalkieMode") private var walkieMode = false
    @AppStorage("clawBridgeGolfMode") private var golfMode = false
    @State private var restoredStoredGolfMode = false

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                ModeToggleButton(
                    accessibilityLabel: "Active Mode",
                    systemImage: "figure.run",
                    isOn: activeModeEnabled,
                    tint: .orange,
                    action: toggleGolfMode
                )

                ModeToggleButton(
                    accessibilityLabel: "Speak",
                    systemImage: "speaker.wave.2.fill",
                    isOn: walkieMode,
                    tint: .green,
                    action: { walkieMode.toggle() }
                )
            }

            Button {
                Task {
                    await controller.toggleRecording(
                        configuration: store.configuration,
                        wantsVoiceReply: walkieMode,
                        sourceContext: golfMode ? .golfMode : nil
                    )
                }
            } label: {
                ZStack(alignment: .topTrailing) {
                    ZStack {
                        if controller.isRecordControlBusy {
                            ProgressView()
                                .controlSize(.large)
                                .tint(.white)
                        } else {
                            Image(systemName: controller.status.isListening ? "stop.fill" : "mic.fill")
                                .font(.system(size: 38, weight: .semibold))
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 92)

                    LocationReadinessDot(readiness: controller.locationReadiness)
                        .padding(10)
                        .opacity(golfMode ? 1 : 0.45)
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(recordButtonTint)
            .disabled(controller.isBusy)
            .accessibilityLabel(controller.status.isListening ? "Stop recording" : "Start recording")
            .accessibilityValue(recordAccessibilityValue)

            if controller.lastResponseID != nil {
                Button(action: toggleReplyPlayback) {
                    Image(systemName: controller.isReplyPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 18, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .frame(height: 32)
                }
                .buttonStyle(.bordered)
                .disabled(controller.status.isListening || controller.isRecordControlBusy)
                .accessibilityLabel(controller.isReplyPlaying ? "Pause Jay" : "Replay Jay")
            }
        }
        .padding(.horizontal, 10)
        .onAppear {
            relay.refreshOutstandingTransfers()
            restoreGolfModeIfNeeded()
        }
        .onDisappear {
            controller.stopPlayback()
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

    private var activeModeEnabled: Bool {
        golfMode || golfWorkout.isActive
    }

    private var recordButtonTint: Color {
        if controller.status.isListening {
            return .red
        }
        if controller.isRecordControlBusy {
            return .gray
        }
        return .blue
    }

    private var recordAccessibilityValue: String {
        if controller.status.isListening {
            return "Recording"
        }
        if controller.isRecordControlBusy {
            return "Working"
        }
        return "Ready"
    }

    private func toggleGolfMode() {
        Task {
            controller.stopPlayback()
            if golfMode || golfWorkout.isActive {
                golfWorkout.stop()
                golfMode = false
                return
            }

            controller.warmLocationForGolfMode()
            let started = await golfWorkout.start()
            golfMode = started
        }
    }

    private func toggleReplyPlayback() {
        if controller.isReplyPlaying {
            controller.pauseLastResponse()
        } else {
            Task {
                await controller.replayLastResponse(configuration: store.configuration)
            }
        }
    }

    private func restoreGolfModeIfNeeded() {
        guard golfMode, !restoredStoredGolfMode else { return }
        restoredStoredGolfMode = true
        Task {
            controller.warmLocationForGolfMode()
            let started = await golfWorkout.start()
            golfMode = started
        }
    }

}

private struct ModeToggleButton: View {
    let accessibilityLabel: String
    let systemImage: String
    let isOn: Bool
    let tint: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 20, weight: .semibold))
            .frame(maxWidth: .infinity)
            .frame(height: 42)
        }
        .buttonStyle(.borderedProminent)
        .tint(isOn ? tint : .gray)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(isOn ? "On" : "Off")
    }
}

private struct LocationReadinessDot: View {
    let readiness: WatchLocationReadiness

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 12, height: 12)
            .overlay(
                Circle()
                    .stroke(.white.opacity(0.85), lineWidth: 1)
            )
            .accessibilityLabel(readiness.accessibilityLabel)
    }

    private var color: Color {
        switch readiness {
        case .ready:
            .green
        case .waiting:
            .yellow
        case .denied, .unavailable:
            .red
        case .unknown:
            .gray
        }
    }
}

#Preview {
    WatchContentView()
        .environmentObject(BridgeConfigurationStore(defaults: UserDefaults(suiteName: "watch-preview")!))
}
