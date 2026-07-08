import SwiftUI

/// Lets the user opt in to sending on-device model usage telemetry to a coding-stats OTLP endpoint.
/// Off by default: this app is otherwise fully on-device, so nothing about a conversation leaves the
/// device unless the user enables this and provides a destination + key. Only usage metrics — model
/// id, token counts, and timings — are ever sent; message content never is.
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss

    private let store = TelemetrySettingsStore()

    @State private var isEnabled = false
    @State private var endpoint = TelemetrySettingsStore.defaultEndpoint
    @State private var apiKey = ""
    @State private var testResult: TestResult?
    @State private var isTesting = false

    private enum TestResult {
        case success
        case failure
    }

    /// The config assembled from the current (possibly unsaved) fields, for the test button.
    private var draftConfig: TelemetryConfig {
        let trimmedEndpoint = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        return TelemetryConfig(
            isEnabled: isEnabled,
            endpoint: trimmedEndpoint.isEmpty ? nil : URL(string: trimmedEndpoint),
            apiKey: trimmedKey.isEmpty ? nil : trimmedKey
        )
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Send usage telemetry", isOn: $isEnabled)
                } footer: {
                    Text(
                        "Off by default. When on, Ondas sends only model usage — model id, token "
                            + "counts, tool calls, and timing — to your endpoint. Your messages and "
                            + "the model's replies never leave the device."
                    )
                }

                Section("Endpoint") {
                    TextField("OTLP base URL", text: $endpoint)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Bearer key (otlp_…)", text: $apiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                Section {
                    Button(action: sendTest) {
                        HStack {
                            Text("Send test event")
                            Spacer()
                            if isTesting {
                                ProgressView()
                            } else if let testResult {
                                switch testResult {
                                case .success:
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(.green)
                                case .failure:
                                    Image(systemName: "xmark.circle.fill")
                                        .foregroundStyle(.red)
                                }
                            }
                        }
                    }
                    .disabled(isTesting || !draftConfig.isDeliverable)
                } footer: {
                    if testResult == .failure {
                        Text("The endpoint didn't accept the event. Check the URL and key.")
                    }
                }
            }
            .navigationTitle("Telemetry")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: saveAndDismiss)
                }
            }
            .onAppear(perform: load)
        }
    }

    private func load() {
        let values = store.load()
        isEnabled = values.isEnabled
        endpoint = values.endpoint
        apiKey = values.apiKey
    }

    private func saveAndDismiss() {
        store.save(isEnabled: isEnabled, endpoint: endpoint, apiKey: apiKey)
        let config = store.currentConfig()
        Task { await TelemetryService.shared.update(config) }
        dismiss()
    }

    private func sendTest() {
        isTesting = true
        testResult = nil
        let config = draftConfig
        Task {
            let ok = await TelemetryService.shared.sendTestEvent(using: config)
            isTesting = false
            testResult = ok ? .success : .failure
        }
    }
}

#Preview {
    SettingsView()
}
