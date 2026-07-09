import SwiftData
import SwiftUI

/// The compact quick-chat shown in the menu-bar popover (native macOS SwiftUI). Reuses the shared
/// `ChatEngine` — streaming, compaction, token budget, and the `/image` command all come from it;
/// only the view is macOS-specific. Opens on a fresh chat and slides in a past-conversations list.
struct MenuBarChatView: View {
    @Environment(\.modelContext) private var modelContext

    @Query(sort: \Conversation.updatedAt, order: .reverse)
    private var conversations: [Conversation]

    @State private var engine = ChatEngine()
    @State private var selectedConversationID: UUID?
    @State private var draft = ""
    @State private var isImageMode = false
    @State private var isListVisible = false
    @FocusState private var isComposerFocused: Bool

    /// The popover's content size — shared with `MenuBarAgentDelegate` so the `NSPopover` and the
    /// SwiftUI content agree.
    static let preferredSize = CGSize(width: 380, height: 560)
    private static let listWidth: CGFloat = 220

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ZStack(alignment: .leading) {
                chatArea
                if isListVisible {
                    pastConversationsList
                        .frame(width: Self.listWidth)
                        .background(.regularMaterial)
                        .transition(.move(edge: .leading))
                        .zIndex(1)
                }
            }
        }
        .frame(width: Self.preferredSize.width, height: Self.preferredSize.height)
        .animation(.snappy(duration: 0.22), value: isListVisible)
        .task { ensureConversation() }
        .task(id: selectedConversationID) {
            guard let conversation = selectedConversation else { return }
            await engine.configure(conversation: conversation, context: modelContext)
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 8) {
            Button {
                withAnimation(.snappy(duration: 0.22)) { isListVisible.toggle() }
            } label: {
                Image(systemName: "sidebar.left")
            }
            .buttonStyle(.borderless)
            .help("Past chats")

            Spacer()
            Text(selectedConversation?.title ?? "Quick Chat")
                .font(.headline)
                .lineLimit(1)
            Spacer()

            Button(action: startNewConversation) {
                Image(systemName: "square.and.pencil")
            }
            .buttonStyle(.borderless)
            .help("New chat")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    // MARK: Chat

    private var chatArea: some View {
        VStack(spacing: 0) {
            transcript
            banner
            composer
        }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(orderedMessages) { message in
                        MenuBarMessageRow(
                            message: message,
                            isAwaitingResponse: engine.isResponding && message.isEmptyPlaceholder
                        )
                        .id(message.id)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                Color.clear.frame(height: 1).id(bottomAnchor)
            }
            .onChange(of: orderedMessages.count) { scrollToBottom(proxy) }
            .onChange(of: orderedMessages.last?.text ?? "") { scrollToBottom(proxy, animated: false) }
            .onAppear { scrollToBottom(proxy, animated: false) }
        }
    }

    @ViewBuilder
    private var banner: some View {
        if engine.capacityState == .full {
            bannerRow("This chat is full.", systemImage: "checkmark.seal.fill") {
                Button("New Chat", action: startNewConversation).buttonStyle(.borderedProminent)
            }
        } else if let availability = engine.availabilityMessage {
            bannerRow(availability, systemImage: "exclamationmark.triangle.fill") { EmptyView() }
        } else if engine.capacityState == .approaching {
            bannerRow("This chat is getting long.", systemImage: "exclamationmark.circle.fill") {
                Button("Compact") { engine.compact() }
                    .disabled(engine.isResponding || engine.isCompacting)
            }
        }
    }

    private func bannerRow(
        _ text: String,
        systemImage: String,
        @ViewBuilder trailing: () -> some View
    ) -> some View {
        HStack(spacing: 8) {
            Label(text, systemImage: systemImage)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Spacer(minLength: 4)
            trailing()
                .controlSize(.small)
                .font(.caption)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.bar)
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Button {
                isImageMode.toggle()
                isComposerFocused = true
            } label: {
                Image(systemName: isImageMode ? "photo.fill" : "photo.badge.plus")
                    .foregroundStyle(isImageMode ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.secondary))
            }
            .buttonStyle(.borderless)
            .disabled(isInputDisabled)
            .help(isImageMode ? "Cancel image" : "Generate an image")

            TextField(isImageMode ? "Describe an image…" : "Message", text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .focused($isComposerFocused)
                .disabled(isInputDisabled)
                .onSubmit(send)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Theme.assistantBubble, in: RoundedRectangle(cornerRadius: 14, style: .continuous))

            Button {
                if engine.isResponding { engine.cancelActiveTurn() } else { send() }
            } label: {
                Image(systemName: engine.isResponding ? "stop.circle.fill" : "arrow.up.circle.fill")
                    .font(.title2)
                    .symbolRenderingMode(.hierarchical)
            }
            .buttonStyle(.borderless)
            .disabled(engine.isResponding ? false : !canSend)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(.bar)
    }

    // MARK: Past-chats list

    private var pastConversationsList: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Past Chats").font(.subheadline.weight(.semibold))
                Spacer()
                Button {
                    withAnimation(.snappy(duration: 0.22)) { isListVisible = false }
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            Divider()

            if conversations.isEmpty {
                Spacer()
                Text("No chats yet").font(.caption).foregroundStyle(.secondary)
                Spacer()
            } else {
                List(conversations, selection: $selectedConversationID) { conversation in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(conversation.title).font(.subheadline).lineLimit(1)
                        Text(conversation.previewText).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    .contentShape(.rect)
                    .onTapGesture { select(conversation) }
                }
                .listStyle(.sidebar)
            }
        }
    }

    // MARK: Derived state

    private var orderedMessages: [ChatMessage] {
        selectedConversation?.orderedMessages ?? []
    }

    private var selectedConversation: Conversation? {
        guard let selectedConversationID else { return nil }
        return conversations.first { $0.id == selectedConversationID }
    }

    private var canSend: Bool {
        engine.canSend(draft: draft)
    }

    private var isInputDisabled: Bool {
        engine.isComposerDisabled
    }

    private let bottomAnchor = "bottom"

    // MARK: Actions

    private func send() {
        guard canSend else { return }
        let outgoing = draft
        let asImage = isImageMode
        draft = ""
        isImageMode = false
        engine.submit(outgoing, asImage: asImage)
    }

    private func select(_ conversation: Conversation) {
        selectedConversationID = conversation.id
        withAnimation(.snappy(duration: 0.22)) { isListVisible = false }
    }

    private func ensureConversation() {
        guard selectedConversation == nil else { return }
        startNewConversation()
    }

    private func startNewConversation() {
        withAnimation(.snappy(duration: 0.22)) { isListVisible = false }
        selectedConversationID = Conversation.reuseEmptyOrCreate(from: conversations, in: modelContext).id
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool = true) {
        guard !orderedMessages.isEmpty else { return }
        if animated {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bottomAnchor, anchor: .bottom) }
        } else {
            proxy.scrollTo(bottomAnchor, anchor: .bottom)
        }
    }
}
