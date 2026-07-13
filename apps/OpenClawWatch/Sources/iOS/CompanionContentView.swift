import SwiftUI

struct CompanionContentView: View {
    @EnvironmentObject private var store: BridgeConfigurationStore
    @ObservedObject private var relay = CompanionRelayController.shared
    @StateObject private var walkie = CompanionWalkieController()
    @State private var bridgeURLText = ""
    @State private var tokenText = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Bridge") {
                    TextField("https://example.com", text: $bridgeURLText)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Bearer token", text: $tokenText)
                        .textContentType(.password)
                }

                Section {
                    Button("Save") {
                        do {
                            try store.updateConfiguration(
                                BridgeConfiguration(
                                    bridgeURL: URL(string: bridgeURLText.trimmingCharacters(in: .whitespacesAndNewlines)),
                                    bearerToken: tokenText.trimmingCharacters(in: .whitespacesAndNewlines)
                                )
                            )
                            CompanionRelayController.shared.sendConfiguration(store.configuration)
                        } catch {
                            tokenText = ""
                        }
                    }
                    .disabled(bridgeURLText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || tokenText.isEmpty)
                }

                Section("Status") {
                    Label(store.configuration.isComplete ? "Ready for Watch uploads" : "Bridge configuration required",
                          systemImage: store.configuration.isComplete ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")

                    if let credentialErrorMessage = store.credentialErrorMessage {
                        Text(credentialErrorMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }

                Section("Watch Relay") {
                    Label(
                        relay.relayStatusText,
                        systemImage: relay.pendingRelayCount == 0 ? "checkmark.circle" : "tray.and.arrow.up"
                    )

                    Button {
                        relay.drainPending(reason: "manual")
                    } label: {
                        Label("Retry Now", systemImage: "arrow.clockwise")
                    }
                    .disabled(relay.pendingRelayCount == 0 || !store.configuration.isComplete)
                }

                Section("Walkie") {
                    TextField("Message Jay", text: $walkie.messageText, axis: .vertical)
                        .lineLimit(2...4)
                        .disabled(walkie.isBusy)

                    HStack {
                        Button {
                            Task {
                                await walkie.send(configuration: store.configuration)
                            }
                        } label: {
                            Label("Send", systemImage: "waveform.circle.fill")
                        }
                        .disabled(walkie.isBusy || walkie.messageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                        if walkie.lastResponseID != nil {
                            Button {
                                Task {
                                    await walkie.replay(configuration: store.configuration)
                                }
                            } label: {
                                Label("Replay", systemImage: "play.circle")
                            }
                            .disabled(walkie.isBusy)
                        }
                    }

                    Label(walkie.statusText, systemImage: walkie.isBusy ? "clock" : "speaker.wave.2")

                    if let detail = walkie.detailText {
                        Text(detail)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Notifications") {
                    Button {
                        Task {
                            await walkie.requestNotificationPermission(configuration: store.configuration)
                        }
                    } label: {
                        Label("Enable Tap to Play", systemImage: "bell.badge")
                    }

                    Label(walkie.notificationStatus, systemImage: "bell")
                }
            }
            .navigationTitle("Claw Bridge")
            .onAppear {
                bridgeURLText = store.configuration.bridgeURL?.absoluteString ?? ""
                tokenText = store.configuration.bearerToken
                relay.drainPending(reason: "ui-appear")
            }
            .onReceive(NotificationCenter.default.publisher(for: .clawBridgeOpenResponse)) { notification in
                guard let responseID = notification.object as? String else { return }
                Task {
                    await walkie.open(responseID: responseID, configuration: store.configuration)
                }
            }
        }
    }
}

#Preview {
    CompanionContentView()
        .environmentObject(BridgeConfigurationStore(defaults: UserDefaults(suiteName: "preview")!))
}
