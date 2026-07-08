import SwiftData
import SwiftUI

/// A grid of every generated image — both standalone images (from the "Generate Image" action) and
/// images generated inside chats — newest first. Tapping one opens a full-screen viewer.
struct GalleryView: View {
    @Environment(\.dismiss) private var dismiss

    /// Selects the source conversation when the viewer's "Open in chat" is tapped; the gallery then
    /// dismisses so the chat is revealed underneath.
    let onOpenConversation: (UUID) -> Void

    @Query(sort: \GeneratedImage.createdAt, order: .reverse)
    private var standaloneImages: [GeneratedImage]

    // All messages, filtered to those carrying image bytes in memory: SwiftData predicates on
    // `.externalStorage` Data are unreliable, and the message count is bounded per conversation.
    @Query(sort: \ChatMessage.createdAt, order: .reverse)
    private var allMessages: [ChatMessage]

    @State private var selectedImage: GalleryImage?
    @State private var showingGenerator = false

    private let columns = [GridItem(.adaptive(minimum: 110), spacing: 3)]

    private var images: [GalleryImage] {
        GalleryImageMerger.merge(
            standalone: standaloneImages,
            chatMessages: allMessages.filter(\.hasImage)
        )
    }

    var body: some View {
        // Merge once per body evaluation — reading `images` twice (empty-check + grid) would
        // otherwise re-materialize every image's bytes twice in a single render.
        let images = self.images
        return NavigationStack {
            Group {
                if images.isEmpty {
                    emptyState
                } else {
                    grid(images)
                }
            }
            .navigationTitle("Gallery")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showingGenerator = true
                    } label: {
                        Label("Generate Image", systemImage: "wand.and.stars")
                    }
                }
            }
            .sheet(item: $selectedImage) { image in
                ImageViewerView(item: image) { conversationID in
                    selectedImage = nil
                    dismiss()
                    onOpenConversation(conversationID)
                }
            }
            .sheet(isPresented: $showingGenerator) {
                ImageGeneratorView()
            }
        }
    }

    private func grid(_ images: [GalleryImage]) -> some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 3) {
                ForEach(images) { image in
                    Button {
                        selectedImage = image
                    } label: {
                        ThumbnailImage(data: image.imageData, identity: image.id, maxPixelSize: 360)
                            .aspectRatio(1, contentMode: .fill)
                            .frame(maxWidth: .infinity)
                            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(3)
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No Images Yet", systemImage: "photo.on.rectangle.angled")
        } description: {
            Text("Images you generate in chats or with Generate Image appear here.")
        } actions: {
            Button("Generate Image") { showingGenerator = true }
                .buttonStyle(.borderedProminent)
        }
    }
}

#Preview {
    GalleryView(onOpenConversation: { _ in })
        .modelContainer(PreviewData.container)
}
