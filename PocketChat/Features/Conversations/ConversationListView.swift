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

    var body: some View {
        NavigationSplitView {
            List(selection: $selectedConversationID) {
                ForEach(filteredConversations) { conversation in
                    NavigationLink(value: conversation.id) {
                        ConversationRow(conversation: conversation)
                    }
                }
                .onDelete(perform: deleteConversations)
            }
            .searchable(text: $searchText, prompt: "Search chats")
            .navigationTitle("Chats")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button(action: startNewConversation) {
                        Label("New Chat", systemImage: "square.and.pencil")
                    }
                }
            }
            .overlay {
                if conversations.isEmpty {
                    emptyState
                }
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
            conversation.title.localizedCaseInsensitiveContains(query)
                || conversation.orderedMessages.contains {
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
        let conversation = Conversation()
        modelContext.insert(conversation)
        try? modelContext.save()
        selectedConversationID = conversation.id
    }

    private func deleteConversations(at offsets: IndexSet) {
        // Offsets index into the same array the ForEach renders (`filteredConversations`),
        // not the unfiltered query — otherwise a search would delete the wrong rows.
        let visible = filteredConversations
        for index in offsets {
            let conversation = visible[index]
            if conversation.id == selectedConversationID {
                selectedConversationID = nil
            }
            modelContext.delete(conversation)
        }
        try? modelContext.save()
    }
}

/// One row in the conversation sidebar: title plus a preview of the latest message.
private struct ConversationRow: View {
    let conversation: Conversation

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(conversation.title)
                .font(.headline)
                .lineLimit(1)
            Text(previewText)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
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
