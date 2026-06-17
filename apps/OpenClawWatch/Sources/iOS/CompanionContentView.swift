import SwiftUI

struct CompanionContentView: View {
    @EnvironmentObject private var store: BridgeConfigurationStore
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
                        store.configuration = BridgeConfiguration(
                            bridgeURL: URL(string: bridgeURLText.trimmingCharacters(in: .whitespacesAndNewlines)),
                            bearerToken: tokenText.trimmingCharacters(in: .whitespacesAndNewlines)
                        )
                        CompanionRelayController.shared.sendConfiguration(store.configuration)
                    }
                    .disabled(bridgeURLText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || tokenText.isEmpty)
                }

                Section("Status") {
                    Label(store.configuration.isComplete ? "Ready for Watch uploads" : "Bridge configuration required",
                          systemImage: store.configuration.isComplete ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                }
            }
            .navigationTitle("Claw Bridge")
            .onAppear {
                bridgeURLText = store.configuration.bridgeURL?.absoluteString ?? ""
                tokenText = store.configuration.bearerToken
            }
        }
    }
}

#Preview {
    CompanionContentView()
        .environmentObject(BridgeConfigurationStore(defaults: UserDefaults(suiteName: "preview")!))
}
