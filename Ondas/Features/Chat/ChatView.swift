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

    /// Increments on each send, driving the send-button symbol bounce and the send haptic.
    @State private var sentCount = 0

    /// Whether the transcript is scrolled near its bottom. Gates streaming auto-scroll (so
    /// reading history isn't interrupted) and the visibility of the jump-to-bottom button.
    @State private var isNearBottom = true

    var body: some View {
        VStack(spacing: 0) {
            transcript
            if engine.isAtCapacity {
                capacityBanner
            } else if let availabilityMessage = engine.availabilityMessage {
                unavailableBanner(availabilityMessage)
            } else if let usage = engine.tokenUsage {
                tokenMeter(usage)
            }
            composer
        }
        .navigationTitle(conversation.title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: conversation.id) {
            await engine.configure(conversation: conversation, context: modelContext)
        }
        .onDisappear {
            // Leaving the conversation cancels any in-flight reply so it stops streaming into a
            // thread that's no longer on screen.
            engine.cancelActiveTurn()
        }
        // A light tap when the user sends; a soft tap when a reply completes, an error tap when
        // the turn failed. Haptics are a no-op on devices without a Taptic Engine (iPad/Catalyst).
        .sensoryFeedback(.impact(weight: .light), trigger: sentCount)
        .sensoryFeedback(trigger: engine.lastTurn) { _, turn in
            guard let turn else { return nil }
            return turn.failed ? .error : .impact(flexibility: .soft)
        }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(conversation.orderedMessages) { message in
                        MessageBubble(
                            message: message,
                            isAwaitingResponse: engine.isResponding && message.isEmptyPlaceholder,
                            isStreaming: isStreaming(message)
                        )
                        .id(message.id)
                        .transition(.messageInsertion)
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 16)
                // Animate only when the message *count* changes, so new bubbles slide in without
                // animating every token update as the last message streams.
                .animation(
                    .spring(response: 0.35, dampingFraction: 0.85),
                    value: conversation.orderedMessages.count
                )
                // Anchor used to keep the newest message in view as the transcript grows.
                Color.clear.frame(height: 1).id(bottomAnchorID)
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                let distanceFromBottom = geometry.contentSize.height
                    - geometry.contentOffset.y - geometry.containerSize.height
                return distanceFromBottom < Self.nearBottomThreshold
            } action: { _, nearBottom in
                isNearBottom = nearBottom
            }
            .overlay(alignment: .bottomTrailing) {
                jumpToBottomButton(proxy)
                    .opacity(isNearBottom ? 0 : 1)
                    .allowsHitTesting(!isNearBottom)
                    .animation(.easeInOut(duration: 0.2), value: isNearBottom)
            }
            .onChange(of: conversation.orderedMessages.count) {
                scrollToBottom(proxy)
            }
            .onChange(of: lastMessageText) {
                // Follow streamed/late-arriving text only when already at the bottom, so scrolling
                // up to read history isn't yanked back down mid-reply. Unanimated to stay glued
                // smoothly to the growing text rather than stuttering per token.
                if isNearBottom { scrollToBottom(proxy, animated: false) }
            }
            .onAppear {
                scrollToBottom(proxy, animated: false)
            }
        }
    }

    private func jumpToBottomButton(_ proxy: ScrollViewProxy) -> some View {
        Button {
            withAnimation(.easeOut(duration: 0.25)) {
                proxy.scrollTo(bottomAnchorID, anchor: .bottom)
            }
        } label: {
            Image(systemName: "chevron.down")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 36, height: 36)
                .background(.regularMaterial, in: Circle())
                .overlay(Circle().strokeBorder(.separator))
        }
        .padding(.trailing, 16)
        .padding(.bottom, 8)
        .accessibilityLabel("Scroll to latest message")
    }

    /// True while `message` is the in-flight assistant reply currently receiving streamed text.
    private func isStreaming(_ message: ChatMessage) -> Bool {
        engine.isResponding
            && message.role == .assistant
            && !message.text.isEmpty
            && message.id == conversation.latestMessage?.id
    }

    private static let nearBottomThreshold: CGFloat = 120

    private func unavailableBanner(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle.fill")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal)
            .padding(.vertical, 8)
            .background(.bar)
    }

    /// A slim live meter of how much of the model's context window this conversation is using.
    /// The bar shifts from accent → orange → red as the chat approaches its token budget.
    private func tokenMeter(_ usage: TokenUsage) -> some View {
        VStack(spacing: 4) {
            HStack {
                Label("Context", systemImage: "gauge.medium")
                Spacer(minLength: 8)
                Text("\(usage.used.formatted()) / \(usage.limit.formatted()) tokens")
                    .monospacedDigit()
            }
            .font(.caption2)
            .foregroundStyle(.secondary)

            ProgressView(value: usage.fraction)
                .tint(meterColor(for: usage.fraction))
        }
        .padding(.horizontal)
        .padding(.vertical, 6)
        .background(.bar)
    }

    private func meterColor(for fraction: Double) -> Color {
        switch fraction {
        case ..<0.75: return .accentColor
        case ..<0.9: return .orange
        default: return .red
        }
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
                .disabled(engine.isAtCapacity)
                .onSubmit(send)

            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .symbolRenderingMode(.hierarchical)
                    .symbolEffect(.bounce, value: sentCount)
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
            && !engine.isAtCapacity
    }

    /// The last message's text, observed so streamed/late-arriving replies re-trigger a
    /// scroll to the bottom.
    private var lastMessageText: String {
        conversation.latestMessage?.text ?? ""
    }

    private let bottomAnchorID = "bottom-anchor"

    private func send() {
        let outgoing = draft
        guard canSend else { return }
        draft = ""
        sentCount += 1
        engine.submit(outgoing)
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

private extension AnyTransition {
    /// New messages rise into place with a fade — a subtle, native-feeling insert.
    static var messageInsertion: AnyTransition {
        .asymmetric(
            insertion: .move(edge: .bottom).combined(with: .opacity),
            removal: .opacity
        )
    }
}

#Preview {
    NavigationStack {
        ChatView(conversation: PreviewData.sampleConversation, onStartNewChat: {})
    }
    .modelContainer(PreviewData.container)
}
