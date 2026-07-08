import SwiftData
import SwiftUI

/// The standalone "Generate Image" flow, launched from the home screen. Unlike an in-chat image,
/// the result is decoupled from any conversation: it's saved as a `GeneratedImage` that stands on
/// its own in the Gallery. No language-model turn is involved — this calls `ImageGenerator` directly.
struct ImageGeneratorView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss

    @State private var prompt = ""
    @State private var phase: Phase = .editing
    @State private var saveState: SaveState = .idle
    @State private var showDeniedAlert = false
    @FocusState private var isPromptFocused: Bool

    private enum Phase: Equatable {
        case editing
        case generating
        case result(Data)
        case failed(String)
    }

    private enum SaveState: Equatable {
        case idle, saving, saved, failed
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                preview
                promptField
                actionButton
            }
            .padding()
            .navigationTitle("Generate Image")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
            }
            .alert("Photos Access Needed", isPresented: $showDeniedAlert) {
                Button("Open Settings") { openSettings() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Allow adding to your photo library in Settings to save this image.")
            }
            .onAppear { isPromptFocused = true }
        }
    }

    @ViewBuilder
    private var preview: some View {
        switch phase {
        case .editing:
            placeholderCard {
                ContentUnavailableView(
                    "Describe an Image",
                    systemImage: "wand.and.stars",
                    description: Text("Type a prompt below and generate an on-device image.")
                )
            }
        case .generating:
            placeholderCard {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Generating…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        case .result(let data):
            resultCard(data)
        case .failed(let message):
            placeholderCard {
                ContentUnavailableView(
                    "Couldn't Generate",
                    systemImage: "exclamationmark.triangle",
                    description: Text(message)
                )
            }
        }
    }

    private func placeholderCard<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        RoundedRectangle(cornerRadius: Theme.bubbleCornerRadius, style: .continuous)
            .fill(Theme.assistantBubble)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(content())
    }

    private func resultCard(_ data: Data) -> some View {
        VStack(spacing: 12) {
            if let uiImage = UIImage(data: data) {
                Image(uiImage: uiImage)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: Theme.bubbleCornerRadius, style: .continuous))
            }
            HStack(spacing: 12) {
                Button {
                    Task { await save(data) }
                } label: {
                    Label(saveLabel, systemImage: saveState == .saved ? "checkmark" : "square.and.arrow.down")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(saveState == .saving || saveState == .saved)

                if let uiImage = UIImage(data: data) {
                    let shareImage = Image(uiImage: uiImage)
                    ShareLink(item: shareImage, preview: SharePreview("Generated image", image: shareImage)) {
                        Label("Share", systemImage: "square.and.arrow.up")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var promptField: some View {
        TextField("Describe the image…", text: $prompt, axis: .vertical)
            .lineLimit(1...4)
            .textFieldStyle(.roundedBorder)
            .focused($isPromptFocused)
            .disabled(phase == .generating)
            .onSubmit { Task { await generate() } }
    }

    private var actionButton: some View {
        Button {
            Task { await generate() }
        } label: {
            Label(isResult ? "Generate Another" : "Generate", systemImage: "sparkles")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(prompt.isBlank || phase == .generating)
    }

    private var isResult: Bool {
        if case .result = phase { return true }
        return false
    }

    private var saveLabel: String {
        switch saveState {
        case .idle, .saving: return "Save"
        case .saved: return "Saved"
        case .failed: return "Try Again"
        }
    }

    private func generate() async {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, phase != .generating else { return }
        isPromptFocused = false
        phase = .generating
        saveState = .idle

        let start = Date.now
        do {
            let data = try await ImageGenerator.generate(prompt: text)
            let image = GeneratedImage(prompt: text, imageData: data)
            modelContext.insert(image)
            modelContext.saveOrLog()
            phase = .result(data)
            recordTelemetry(start: start, end: .now)
        } catch {
            let message = (error as? ImageGenerator.GenerationError)?.errorDescription
                ?? "Something went wrong. Please try again."
            phase = .failed(message)
        }
    }

    private func save(_ data: Data) async {
        saveState = .saving
        switch await PhotoLibrarySaver.save(data) {
        case .saved: saveState = .saved
        case .denied:
            saveState = .idle
            showDeniedAlert = true
        case .failed: saveState = .failed
        }
    }

    /// Emits the same `ondas.tool` span a chat `/image` turn does, so standalone generations show up
    /// in telemetry identically. No-ops when telemetry is disabled. A fresh session id is used since
    /// there's no conversation to key off.
    private func recordTelemetry(start: Date, end: Date) {
        Task {
            await TelemetryService.shared.recordToolCall(
                conversationID: UUID(),
                toolName: "generate_image",
                start: start,
                end: end
            )
        }
    }

    private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

#Preview {
    ImageGeneratorView()
        .modelContainer(PreviewData.container)
}
