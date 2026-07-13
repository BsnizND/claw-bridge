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
        ZStack(alignment: .bottomTrailing) {
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
                        action: toggleWalkieMode
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
                    ZStack {
                        if controller.isRecordControlBusy {
                            ProgressView()
                                .controlSize(.large)
                                .tint(.white)
                        } else {
                            Image(systemName: recordButtonSystemImage)
                                .font(.system(size: 38, weight: .semibold))
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 92)
                }
                .buttonStyle(.borderedProminent)
                .tint(recordButtonTint)
                .disabled(controller.isReplyPlaying)
                .accessibilityLabel(recordAccessibilityLabel)
                .accessibilityValue(recordAccessibilityValue)

                WatchDeliveryStatusView(presentation: deliveryStatusPresentation)

                if walkieMode && controller.hasPlayableReply {
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

            LocationReadinessDot(readiness: controller.locationReadiness)
                .opacity(golfMode ? 1 : 0.45)
                .padding(.trailing, 2)
                .padding(.bottom, 2)
                .allowsHitTesting(false)
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

    private var deliveryStatusPresentation: WatchDeliveryStatusPresentation {
        if shouldShowRelayStatus,
           let relayPresentation = WatchDeliveryStatusPresentation(relayState: relay.handoffState) {
            return relayPresentation
        }
        return WatchDeliveryStatusPresentation(
            voiceStatus: controller.status,
            detail: controller.detailText
        )
    }

    private var shouldShowRelayStatus: Bool {
        guard relay.handoffState.isActive else { return false }
        switch controller.status {
        case .idle, .relayPending:
            return true
        default:
            return false
        }
    }

    private var recordButtonTint: Color {
        if controller.status.isListening {
            return .red
        }
        if controller.isRecordControlBusy {
            return .gray
        }
        if case .failed = controller.status {
            return .red
        }
        return .blue
    }

    private var recordButtonSystemImage: String {
        if controller.status.isListening {
            return "stop.fill"
        }
        if case .failed = controller.status {
            return "exclamationmark.triangle.fill"
        }
        return "mic.fill"
    }

    private var recordAccessibilityLabel: String {
        if controller.status.isListening {
            return "Stop recording"
        }
        if case .failed = controller.status {
            return "Recording failed. Tap to try again"
        }
        return "Start recording"
    }

    private var recordAccessibilityValue: String {
        if controller.status.isListening {
            return "Recording"
        }
        if controller.isRecordControlBusy {
            return "Working. Tap to cancel"
        }
        if case .failed = controller.status {
            return "Error"
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

            golfMode = true
            controller.warmLocationForGolfMode()
            let started = await golfWorkout.start()
            if !started {
                controller.warmLocationForGolfMode()
            }
        }
    }

    private func toggleWalkieMode() {
        if walkieMode {
            walkieMode = false
            controller.clearReplyPlayback()
        } else {
            walkieMode = true
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
            _ = await golfWorkout.start()
        }
    }

}

private struct WatchDeliveryStatusPresentation {
    let title: String
    let detail: String?
    let systemImage: String
    let tint: Color

    init(voiceStatus: WatchVoiceStatus, detail: String?) {
        title = voiceStatus.title
        self.detail = detail
        switch voiceStatus {
        case .idle:
            systemImage = "checkmark.circle"
            tint = .secondary
        case .recording:
            systemImage = "waveform"
            tint = .red
        case .sending, .waitingForReply:
            systemImage = "arrow.up.circle.fill"
            tint = .blue
        case .relayPending:
            systemImage = "clock.fill"
            tint = .orange
        case .sent, .replyReady:
            systemImage = "checkmark.circle.fill"
            tint = .green
        case .playing:
            systemImage = "speaker.wave.2.fill"
            tint = .green
        case .failed:
            systemImage = "exclamationmark.triangle.fill"
            tint = .red
        }
    }

    init?(relayState: WatchRelayHandoffState) {
        guard let title = relayState.title else { return nil }
        self.title = title
        detail = relayState.detailText
        switch relayState {
        case .idle:
            return nil
        case .pending, .queuedOnPhone, .uploadingToBridge, .retryingBridge:
            systemImage = "clock.fill"
            tint = .orange
        case .transferred:
            systemImage = "iphone"
            tint = .blue
        case .sentToBridge:
            systemImage = "checkmark.circle.fill"
            tint = .green
        case .failed:
            systemImage = "exclamationmark.triangle.fill"
            tint = .red
        }
    }
}

private struct WatchDeliveryStatusView: View {
    let presentation: WatchDeliveryStatusPresentation

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: presentation.systemImage)
                .foregroundStyle(presentation.tint)
                .font(.caption.weight(.semibold))

            VStack(alignment: .leading, spacing: 1) {
                Text(presentation.title)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                if let detail = presentation.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .minimumScaleFactor(0.8)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Delivery status")
        .accessibilityValue(accessibilityValue)
        .accessibilityAddTraits(.updatesFrequently)
    }

    private var accessibilityValue: String {
        guard let detail = presentation.detail, !detail.isEmpty else {
            return presentation.title
        }
        return "\(presentation.title). \(detail)"
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
