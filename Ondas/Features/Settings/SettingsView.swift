import SwiftUI

/// Lets the user opt in to sending on-device model usage telemetry to an OTLP endpoint. Telemetry
/// and transcript capture are both off by default; message content is included only when the user
/// separately enables transcript capture.
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss

    private let store = TelemetrySettingsStore()
    private let generationSettings = GenerationSettingsStore()
    private let syncMonitor = CloudKitSyncMonitor.shared

    @State private var isEnabled = false
    @State private var sendTranscripts = false
    @State private var endpoint = ""
    @State private var apiKey = ""
    @State private var testResult: TestResult?
    @State private var isTesting = false
    @State private var responseStyle: ResponseStyle = .balanced

    private enum TestResult {
        case success
        case failure
    }

    /// The config assembled from the current (possibly unsaved) fields, for the test button.
    private var draftConfig: TelemetryConfig {
        TelemetryConfig(
            isEnabled: isEnabled,
            sendTranscripts: sendTranscripts,
            endpointField: endpoint,
            apiKeyField: apiKey
        )
    }

    private var hasInvalidEndpoint: Bool {
        !endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && draftConfig.endpoint == nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("iCloud Sync", value: syncMonitor.status ?? "No sync activity yet")
                } footer: {
                    Text("Reflects the most recent CloudKit sync attempt for your chats.")
                }

                Section {
                    Picker("Response style", selection: $responseStyle) {
                        ForEach(ResponseStyle.allCases) { style in
                            Text(style.label).tag(style)
                        }
                    }
                    .pickerStyle(.segmented)
                } footer: {
                    Text(responseStyle.footer)
                }

                Section {
                    Toggle("Send usage telemetry", isOn: $isEnabled)
                } footer: {
                    Text(
                        "Off by default. When on, Ondas sends model id, token counts, tool calls, "
                            + "and timing to your endpoint."
                    )
                }

                Section {
                    Toggle("Send transcripts", isOn: $sendTranscripts)
                        .disabled(!isEnabled)
                } footer: {
                    Text(
                        "Includes each successful text prompt and model reply in OTLP spans. "
                            + "Messages may contain sensitive information."
                    )
                }

                Section {
                    TextField("OTLP base URL", text: $endpoint)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Bearer key (otlp_…)", text: $apiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Endpoint")
                } footer: {
                    if hasInvalidEndpoint {
                        Text("Use a valid HTTPS base URL. Ondas appends /v1/traces (JSON traces).")
                    } else {
                        Text("Use an HTTPS base OTLP URL; Ondas appends /v1/traces (JSON traces). e.g. https://stats.keegan.codes/api/otlp")
                    }
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
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: dismiss.callAsFunction)
                }
            }
            .onAppear(perform: load)
            // A prior test result is only valid for the endpoint/key it was run against. Clear it
            // the moment either changes, so an edited (e.g. now-wrong) endpoint doesn't keep showing
            // the previous run's ✓.
            .onChange(of: endpoint) { testResult = nil }
            .onChange(of: apiKey) { testResult = nil }
            // Save on *any* dismissal — Done and an interactive swipe-down behave the same, so
            // edits (e.g. a freshly pasted API key) are never silently discarded.
            .onDisappear(perform: save)
        }
    }

    private func load() {
        let values = store.load()
        isEnabled = values.isEnabled
        sendTranscripts = values.sendTranscripts
        endpoint = values.endpoint
        apiKey = values.apiKey
        responseStyle = generationSettings.load()
    }

    private func save() {
        generationSettings.save(responseStyle)
        store.save(
            isEnabled: isEnabled,
            sendTranscripts: sendTranscripts,
            endpoint: endpoint,
            apiKey: apiKey
        )
        let config = store.currentConfig()
        Task { await TelemetryService.shared.update(config) }
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
