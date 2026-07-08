import SwiftUI

/// A full-screen viewer for a single generated image: pinch/double-tap to zoom, save to Photos,
/// share, and — for a chat-sourced image — jump to the conversation it was generated in.
struct ImageViewerView: View {
    let item: GalleryImage

    /// Invoked with the source conversation id when the user taps "Open in chat". nil for standalone
    /// images (the button isn't shown then).
    let onOpenConversation: ((UUID) -> Void)?

    @Environment(\.dismiss) private var dismiss

    @State private var saveState: SaveState = .idle
    @State private var showDeniedAlert = false

    /// Committed zoom scale, plus the live gesture delta, so pinch feels continuous.
    @State private var zoom: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1

    private enum SaveState: Equatable {
        case idle, saving, saved, failed
    }

    var body: some View {
        NavigationStack {
            imageContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(.systemGroupedBackground).ignoresSafeArea())
                .navigationTitle(navigationTitle)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbarContent }
                .toolbarBackground(.visible, for: .navigationBar)
                .safeAreaInset(edge: .bottom) { actionBar }
                .alert("Photos Access Needed", isPresented: $showDeniedAlert) {
                    Button("Open Settings") { openSettings() }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("Allow adding to your photo library in Settings to save this image.")
                }
        }
    }

    /// A short heading for the top bar: the prompt for a standalone image, or a generic label for a
    /// chat image (which carries no separate prompt). Keeps the bar from showing just a lone Done.
    private var navigationTitle: String {
        item.prompt.isEmpty ? "Image" : item.prompt
    }

    private var imageContent: some View {
        Group {
            if let uiImage = UIImage(data: item.imageData) {
                Image(uiImage: uiImage)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
                    .padding(24)
                    .scaleEffect(zoom * pinch)
                    .gesture(magnification)
                    .onTapGesture(count: 2) {
                        withAnimation(.snappy) { zoom = zoom > 1 ? 1 : 2.5 }
                    }
            } else {
                ContentUnavailableView("Couldn't Load Image", systemImage: "photo")
            }
        }
    }

    private var magnification: some Gesture {
        MagnifyGesture()
            .updating($pinch) { value, state, _ in state = value.magnification }
            .onEnded { value in
                // Clamp so the image can't be zoomed away to nothing or blown up unboundedly.
                zoom = min(max(zoom * value.magnification, 1), 5)
            }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button("Done") { dismiss() }
        }
    }

    private var actionBar: some View {
        HStack(spacing: 12) {
            Button {
                Task { await save() }
            } label: {
                Label(saveLabel, systemImage: saveSymbol)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(saveState == .saving || saveState == .saved)

            ShareLink(item: shareImage, preview: SharePreview("Generated image", image: shareImage)) {
                Label("Share", systemImage: "square.and.arrow.up")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)

            if let sourceConversationID = item.sourceConversationID, let onOpenConversation {
                Button {
                    onOpenConversation(sourceConversationID)
                } label: {
                    Label("Open in Chat", systemImage: "bubble.left.and.text.bubble.right")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
        }
        .padding()
        .background(.bar)
    }

    private var shareImage: Image {
        if let uiImage = UIImage(data: item.imageData) {
            return Image(uiImage: uiImage)
        }
        return Image(systemName: "photo")
    }

    private var saveLabel: String {
        switch saveState {
        case .idle, .saving: return "Save"
        case .saved: return "Saved"
        case .failed: return "Try Again"
        }
    }

    private var saveSymbol: String {
        switch saveState {
        case .idle, .saving, .failed: return "square.and.arrow.down"
        case .saved: return "checkmark"
        }
    }

    private func save() async {
        saveState = .saving
        switch await PhotoLibrarySaver.save(item.imageData) {
        case .saved:
            saveState = .saved
        case .denied:
            saveState = .idle
            showDeniedAlert = true
        case .failed:
            saveState = .failed
        }
    }

    private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}
