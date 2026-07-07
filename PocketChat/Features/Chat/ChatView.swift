import SwiftData
import SwiftUI

/// A single conversation: a scrolling transcript with a message composer pinned to the
/// bottom. Owns the `ChatEngine` that talks to the on-device model.
struct ChatView: View {
    @Environment(\.modelContext) private var modelContext

    let conversation: Conversation

    /// Starts a fresh conversation and selects it — invoked from the "chat is full" banner.
    let onStartNewChat: () -> Void

    @State private var engine = ChatEngine()
    @State private var draft = ""
    @FocusState private var isComposerFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            transcript
            if conversation.isAtCapacity {
                capacityBanner
            } else if let availabilityMessage = engine.availabilityMessage {
                unavailableBanner(availabilityMessage)
            }
            composer
        }
        .navigationTitle(conversation.title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: conversation.id) {
            engine.configure(conversation: conversation, context: modelContext)
        }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(conversation.orderedMessages) { message in
                        MessageBubble(
                            message: message,
                            isAwaitingResponse: engine.isResponding && message.isEmptyPlaceholder
                        )
                        .id(message.id)
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 16)
                // Anchor used to keep the newest message in view as the transcript grows.
                Color.clear.frame(height: 1).id(bottomAnchorID)
            }
            .onChange(of: conversation.orderedMessages.count) {
                scrollToBottom(proxy)
            }
            .onChange(of: lastMessageText) {
                scrollToBottom(proxy)
            }
            .onAppear {
                scrollToBottom(proxy, animated: false)
            }
        }
    }

    private func unavailableBanner(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle.fill")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal)
            .padding(.vertical, 8)
            .background(.bar)
    }

    private var capacityBanner: some View {
        HStack(spacing: 12) {
            Label(
                "This chat is full. Start a new one to keep going.",
                systemImage: "checkmark.seal.fill"
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Button("New Chat", action: onStartNewChat)
                .font(.footnote.weight(.semibold))
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Message", text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...6)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Theme.assistantBubble, in: Capsule())
                .focused($isComposerFocused)
                .disabled(conversation.isAtCapacity)
                .onSubmit(send)

            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .symbolRenderingMode(.hierarchical)
            }
            .disabled(!canSend)
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var canSend: Bool {
        !draft.isBlank
            && !engine.isResponding
            && engine.availabilityMessage == nil
            && !conversation.isAtCapacity
    }

    /// The last message's text, observed so streamed/late-arriving replies re-trigger a
    /// scroll to the bottom.
    private var lastMessageText: String {
        conversation.orderedMessages.last?.text ?? ""
    }

    private let bottomAnchorID = "bottom-anchor"

    private func send() {
        let outgoing = draft
        guard canSend else { return }
        draft = ""
        Task { await engine.send(outgoing) }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool = true) {
        guard conversation.hasMessages else { return }
        if animated {
            withAnimation(.easeOut(duration: 0.2)) {
                proxy.scrollTo(bottomAnchorID, anchor: .bottom)
            }
        } else {
            proxy.scrollTo(bottomAnchorID, anchor: .bottom)
        }
    }
}

#Preview {
    NavigationStack {
        ChatView(conversation: PreviewData.sampleConversation, onStartNewChat: {})
    }
    .modelContainer(PreviewData.container)
}
