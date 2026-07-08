import SwiftData
import SwiftUI

/// Root screen: a sidebar list of conversations paired with the selected chat. Uses
/// `NavigationSplitView` so it reads as a two-column layout on iPad/Mac and a push
/// navigation stack on iPhone, from one declaration.
struct ConversationListView: View {
    @Environment(\.modelContext) private var modelContext

    @Query(sort: \Conversation.updatedAt, order: .reverse)
    private var conversations: [Conversation]

    @State private var selectedConversationID: UUID?
    @State private var searchText = ""
    @State private var showingSettings = false
    @State private var showingGallery = false
    @State private var showingGenerator = false

    var body: some View {
        NavigationSplitView {
            List(selection: $selectedConversationID) {
                ForEach(filteredConversations) { conversation in
                    NavigationLink(value: conversation.id) {
                        ConversationRow(conversation: conversation)
                    }
                    // Right-click (Mac Catalyst) / long-press (iOS) delete, plus an explicit
                    // trailing swipe. Mac Catalyst has no swipe-to-delete, so the context menu is
                    // the primary path there.
                    .contextMenu {
                        Button(role: .destructive) {
                            delete(conversation)
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            delete(conversation)
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }
                .onDelete(perform: deleteConversations)
            }
            .searchable(text: $searchText, prompt: "Search chats")
            .navigationTitle("Chats")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showingSettings = true
                    } label: {
                        Label("Settings", systemImage: "gearshape")
                    }
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button {
                        showingGallery = true
                    } label: {
                        Label("Gallery", systemImage: "photo.on.rectangle.angled")
                    }
                    Button(action: startNewConversation) {
                        Label("New Chat", systemImage: "square.and.pencil")
                    }
                }
                ToolbarItem(placement: .bottomBar) {
                    Button {
                        showingGenerator = true
                    } label: {
                        // Show the title alongside the icon: on Mac Catalyst a bare wand glyph reads
                        // as a generic "AI" action, not an image one. The words make it unambiguous.
                        Label("Generate Image", systemImage: "photo.badge.plus")
                    }
                    .labelStyle(.titleAndIcon)
                    .help("Generate an image from a text prompt")
                }
            }
            .overlay {
                if conversations.isEmpty {
                    emptyState
                }
            }
            .sheet(isPresented: $showingSettings) {
                SettingsView()
            }
            .sheet(isPresented: $showingGallery) {
                GalleryView { conversationID in
                    selectedConversationID = conversationID
                }
            }
            .sheet(isPresented: $showingGenerator) {
                ImageGeneratorView()
            }
        } detail: {
            if let conversation = selectedConversation {
                ChatView(conversation: conversation, onStartNewChat: startNewConversation)
                    // Rebuild the chat view (and its engine) when the selection changes.
                    .id(conversation.id)
            } else {
                ContentUnavailableView(
                    "Pick a Chat",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("Select a conversation or start a new one.")
                )
            }
        }
    }

    /// Conversations narrowed by the search field. Filtering in-memory (rather than a
    /// dynamic `@Query`) is fine at chat-history scale and keeps the live sort intact.
    private var filteredConversations: [Conversation] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return conversations }
        return conversations.filter { conversation in
            // Membership doesn't care about order — skip `orderedMessages`' sort.
            conversation.title.localizedCaseInsensitiveContains(query)
                || (conversation.messages ?? []).contains {
                    $0.text.localizedCaseInsensitiveContains(query)
                }
        }
    }

    private var selectedConversation: Conversation? {
        guard let selectedConversationID else { return nil }
        return conversations.first { $0.id == selectedConversationID }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No Chats Yet", systemImage: "bubble.left.and.bubble.right")
        } description: {
            Text("Start a new conversation to chat with the on-device model.")
        } actions: {
            Button("New Chat", action: startNewConversation)
                .buttonStyle(.borderedProminent)
        }
    }

    private func startNewConversation() {
        // Reuse an existing empty thread rather than accumulating "New Chat" rows that would
        // sync to CloudKit; repeated taps (or the capacity banner) then converge on one draft.
        if let empty = conversations.first(where: { !$0.hasMessages }) {
            selectedConversationID = empty.id
            return
        }
        let conversation = Conversation()
        modelContext.insert(conversation)
        modelContext.saveOrLog()
        selectedConversationID = conversation.id
    }

    private func deleteConversations(at offsets: IndexSet) {
        // Offsets index into the same array the ForEach renders (`filteredConversations`),
        // not the unfiltered query — otherwise a search would delete the wrong rows.
        let visible = filteredConversations
        offsets.map { visible[$0] }.forEach(delete)
    }

    /// Deletes a conversation from the context menu, swipe action, or edit control.
    ///
    /// If it's the open conversation, the selection is cleared *first* and the actual delete is
    /// deferred to the next main-actor hop. Deleting a model while the `NavigationSplitView` detail
    /// still shows it makes SwiftUI read the now-invalidated object (e.g. `navigationTitle`) and
    /// crash — notably on Mac Catalyst. Clearing selection this cycle tears the detail down before
    /// the object goes away.
    private func delete(_ conversation: Conversation) {
        if conversation.id == selectedConversationID {
            selectedConversationID = nil
        }
        Task { @MainActor in
            modelContext.delete(conversation)
            modelContext.saveOrLog()
        }
    }
}

/// One row in the conversation sidebar: title plus a preview of the latest message.
private struct ConversationRow: View {
    let conversation: Conversation

    /// Fixed thumbnail edge, in points; decoded at 3× for a crisp Retina preview.
    private static let thumbnailSize: CGFloat = 44

    var body: some View {
        HStack(spacing: 10) {
            if let imageMessage = conversation.latestImageMessage,
               let imageData = imageMessage.imageData {
                ThumbnailImage(
                    data: imageData,
                    identity: imageMessage.id,
                    maxPixelSize: Self.thumbnailSize * 3
                )
                .frame(width: Self.thumbnailSize, height: Self.thumbnailSize)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(conversation.title)
                    .font(.headline)
                    .lineLimit(1)
                Text(previewText)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }

    private var previewText: String {
        guard let latest = conversation.latestMessage else {
            return "No messages yet"
        }
        if latest.hasImage, latest.text.isEmpty {
            return latest.role == .user ? "Image request" : "Generated image"
        }
        return latest.text
    }
}

#Preview {
    ConversationListView()
        .modelContainer(PreviewData.container)
}
