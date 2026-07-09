import SwiftData
import SwiftUI

/// A single conversation: a scrolling transcript with a message composer pinned to the
/// bottom. Owns the `ChatEngine` that talks to the on-device model.
struct ChatView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase

    let conversation: Conversation

    /// Starts a fresh conversation and selects it — invoked from the "chat is full" banner.
    let onStartNewChat: () -> Void

    @State private var engine = ChatEngine()
    @State private var draft = ""
    @FocusState private var isComposerFocused: Bool

    /// Increments on each send, driving the send-button symbol bounce and the send haptic.
    @State private var sentCount = 0

    /// Baseline height of the composer's single-line input, scaled with Dynamic Type. Flooring the
    /// input row to this keeps its height fixed when the image chip appears or disappears — the chip
    /// is otherwise a hair taller than one line of text, which made the field visibly jump on toggle.
    @ScaledMetric(relativeTo: .body) private var composerFieldHeight: CGFloat = 24

    /// Vertical padding inside the input capsule, doubled for top+bottom.
    private static let composerVerticalPadding: CGFloat = 9

    /// Full height of the single-line input capsule. The leading image button and trailing send
    /// button are sized to this so they center on the input's one line, and — because the row is
    /// bottom-aligned — drop to the last line when the field grows.
    private var composerRowHeight: CGFloat {
        composerFieldHeight + Self.composerVerticalPadding * 2
    }

    /// True when the composer is in image mode — entered by typing the `/image` command, shown as a
    /// highlighted chip. The next send is an explicit image request; `draft` holds just the prompt.
    @State private var isImageMode = false

    /// Whether the transcript follows streamed text to the bottom. Engaged by default and while the
    /// user sits at the bottom; released the moment the user scrolls away, and re-engaged when they
    /// scroll all the way back down.
    @State private var autoScroll = true

    /// True while the user is physically driving the scroll (dragging or coasting), so a scroll
    /// away from the bottom can be attributed to them rather than to our own auto-scroll.
    @State private var isUserScrolling = false

    /// Whether the jump-to-bottom button is shown — i.e. the user has scrolled well clear of the
    /// bottom. Stored as a threshold-crossed `Bool` rather than the live distance so a scroll only
    /// writes state when the value actually flips. Writing continuous geometry here re-invalidated
    /// `body` (which reads this state) on every scroll tick, re-triggering layout and the geometry
    /// callback in a loop that never settled on Mac Catalyst — a scroll would hang the app.
    @State private var showJumpButton = false

    var body: some View {
        VStack(spacing: 0) {
            transcript
            // Full takes precedence (its New Chat action works even when the model is down); then
            // an availability notice; then the non-blocking "getting long" warning; then the meter.
            if engine.capacityState == .full {
                capacityFullBanner
            } else if let availabilityMessage = engine.availabilityMessage {
                unavailableBanner(availabilityMessage)
            } else if engine.capacityState == .approaching {
                capacityWarningBanner
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
        .onChange(of: scenePhase) {
            // Availability can change while backgrounded (e.g. the model finished downloading,
            // or Apple Intelligence was toggled in Settings) — re-check on return so the banner
            // reflects reality without waiting for a conversation switch.
            if scenePhase == .active {
                engine.refreshAvailability()
            }
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
        // Sort once per body evaluation: streamed tokens re-evaluate this view constantly and
        // `orderedMessages` re-sorts on every access, so the several uses below share this copy.
        let messages = conversation.orderedMessages
        return ScrollViewReader { proxy in
            ScrollView {
                // Deliberately NOT a LazyVStack. On Mac Catalyst a lazy stack here livelocked the
                // main thread after compaction: lazy row placement depends on the visible rect,
                // but placing rows changes the content-size estimate, which (anchored near the
                // bottom) moves the visible rect and re-places different rows — and with row
                // heights as mixed as a ~25pt divider next to essay-length bubbles the estimate
                // never converged, spinning inside a single layout pass at 100% CPU. Laziness
                // bought nothing anyway: the surrounding layout asks the ScrollView for its ideal
                // size, which measures every row each pass regardless. A plain VStack's content
                // size is deterministic and viewport-independent, so the feedback loop can't form,
                // and compaction keeps the transcript bounded.
                VStack(spacing: 12) {
                    ForEach(messages) { message in
                        messageRow(message, latest: messages.last)
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
                    value: messages.count
                )
                // Anchor used to keep the newest message in view as the transcript grows.
                Color.clear.frame(height: 1).id(bottomAnchorID)
            }
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                max(0, geometry.contentSize.height
                    - geometry.contentOffset.y - geometry.containerSize.height)
            } action: { _, distance in
                // Only mutate state on an actual threshold crossing. Writing on every geometry
                // callback re-invalidated `body` (which reads this state), re-triggering layout and
                // this very callback in a loop that never settled on Mac Catalyst (a scroll hung
                // the app). Guarding every write keeps a steady scroll from touching state at all.
                if distance <= Self.atBottomThreshold {
                    // Back at the bottom (whether the user scrolled there or our own auto-scroll
                    // did) — follow the generation again.
                    if !autoScroll { autoScroll = true }
                } else if isUserScrolling, autoScroll {
                    // The user scrolled away from the bottom: hand them control and stay put.
                    // Growth from streamed text (not user-driven) never trips this.
                    autoScroll = false
                }
                let shouldShowJump = distance > Self.jumpButtonThreshold
                if shouldShowJump != showJumpButton { showJumpButton = shouldShowJump }
            }
            .onScrollPhaseChange { _, phase in
                isUserScrolling = phase == .tracking
                    || phase == .interacting
                    || phase == .decelerating
            }
            .overlay(alignment: .bottomTrailing) {
                jumpToBottomButton(proxy)
                    .opacity(showJumpButton ? 1 : 0)
                    .allowsHitTesting(showJumpButton)
                    .animation(.easeInOut(duration: 0.2), value: showJumpButton)
            }
            .onChange(of: messages.count) {
                // A new message (the user's send, then the reply placeholder): snap to it and
                // resume following the generation.
                autoScroll = true
                scrollToBottom(proxy)
            }
            .onChange(of: messages.last?.text ?? "") {
                // Follow streamed/late-arriving text only while auto-scroll is engaged. Unanimated
                // to stay glued smoothly to the growing text rather than stuttering per token.
                if autoScroll { scrollToBottom(proxy, animated: false) }
            }
            .onAppear {
                scrollToBottom(proxy, animated: false)
            }
        }
    }

    /// One row in the transcript: a compaction divider for a summary marker, otherwise a message
    /// bubble. Split out so the SwiftUI type-checker stays fast (an inline `if` inside `ForEach`
    /// pushed it over its time budget).
    @ViewBuilder
    private func messageRow(_ message: ChatMessage, latest: ChatMessage?) -> some View {
        if message.isCompactionSummary {
            CompactionDivider()
        } else {
            MessageBubble(
                message: message,
                isAwaitingResponse: engine.isResponding && message.isEmptyPlaceholder,
                isStreaming: isStreaming(message, latest: latest)
            )
        }
    }

    private func jumpToBottomButton(_ proxy: ScrollViewProxy) -> some View {
        Button {
            autoScroll = true
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
    /// `latest` is passed in so the caller's already-sorted copy is reused.
    private func isStreaming(_ message: ChatMessage, latest: ChatMessage?) -> Bool {
        engine.isResponding
            && message.role == .assistant
            && !message.text.isEmpty
            && message.id == latest?.id
    }

    /// Slack for treating the transcript as "at the bottom" — small, so any deliberate scroll-up
    /// releases auto-scroll, while sub-point layout jitter during streaming does not.
    private static let atBottomThreshold: CGFloat = 40

    /// How far from the bottom the user must be before the jump-to-bottom button appears.
    private static let jumpButtonThreshold: CGFloat = 120

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
    /// The bar shifts from accent → orange as the chat approaches the warning band, at which point
    /// `capacityWarningBanner` replaces the meter entirely — so the ramp lives within `[0, 0.8)`.
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
        // The meter is only shown below the warning band, so the ramp is scaled to that range.
        fraction < 0.6 ? .accentColor : .orange
    }

    /// Non-blocking nudge shown as the chat nears the context budget. The user can keep chatting;
    /// compaction summarizes the older turns into a divider and continues in the same conversation,
    /// which is offered here — while there's still room to summarize — rather than once the chat is
    /// full. This branch only renders when the model is available, so the button needs no extra gate.
    private var capacityWarningBanner: some View {
        HStack(spacing: 12) {
            Label(
                engine.isCompacting ? "Compacting the conversation…" : "This chat is getting long.",
                systemImage: engine.isCompacting ? "arrow.triangle.merge" : "exclamationmark.circle.fill"
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Button {
                engine.compact()
            } label: {
                if engine.isCompacting {
                    ProgressView().controlSize(.small)
                } else {
                    Text("Compact")
                }
            }
            .font(.footnote.weight(.semibold))
            .buttonStyle(.borderedProminent)
            // `compact()` also refuses while a reply is streaming; the composer stays enabled at
            // `.approaching`, so without this the button would be tappable but silently no-op.
            .disabled(engine.isResponding || engine.isCompacting)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }

    /// Blocking banner once the chat has filled the context budget: the conversation is now too
    /// large to summarize reliably, so the only path forward is a fresh chat.
    private var capacityFullBanner: some View {
        HStack(spacing: 12) {
            Label("This chat is full.", systemImage: "checkmark.seal.fill")
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
            imageToggleButton
            HStack(alignment: .center, spacing: 6) {
                if isImageMode {
                    imageModeChip
                }
                TextField(isImageMode ? "Describe the image…" : "Message", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .focused($isComposerFocused)
                    .onSubmit(send)
                    .onChange(of: draft) { enterImageModeIfCommanded() }
            }
            .frame(minHeight: composerFieldHeight)
            .padding(.horizontal, 14)
            .padding(.vertical, Self.composerVerticalPadding)
            .background(Theme.assistantBubble, in: Capsule())
            .disabled(isInputDisabled)

            Button {
                if engine.isResponding { cancel() } else { send() }
            } label: {
                Image(systemName: composerButtonSymbol)
                    .font(.system(size: 32))
                    .symbolRenderingMode(.hierarchical)
                    .contentTransition(.symbolEffect(.replace))
                    .symbolEffect(.bounce, value: sentCount)
            }
            // While a reply is streaming the button becomes a stop control (always tappable so a
            // runaway generation can be halted); otherwise it's the send button, gated by `canSend`.
            .disabled(engine.isResponding ? false : !canSend)
            .accessibilityLabel(engine.isResponding ? "Stop generating" : "Send message")
            .frame(height: composerRowHeight)
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.bar)
        .animation(.snappy(duration: 0.2), value: isImageMode)
    }

    /// A visible affordance for image generation: tapping it toggles `/image` mode without the user
    /// having to know the text command. Highlights while active. The `/image` typed command still
    /// works and drives the same mode.
    private var imageToggleButton: some View {
        Button {
            withAnimation(.snappy(duration: 0.2)) { isImageMode.toggle() }
            isComposerFocused = true
        } label: {
            Image(systemName: isImageMode ? "photo.fill" : "photo.badge.plus")
                .font(.system(size: 26))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(isImageMode ? AnyShapeStyle(Theme.userBubble) : AnyShapeStyle(.secondary))
        }
        .frame(height: composerRowHeight)
        .disabled(isInputDisabled)
        .accessibilityLabel(isImageMode ? "Turn off image generation" : "Generate an image")
    }

    /// A highlighted pill shown at the head of the composer while in `/image` mode. Tapping it
    /// cancels image mode and returns to a plain message.
    private var imageModeChip: some View {
        Button {
            withAnimation(.snappy(duration: 0.2)) { isImageMode = false }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "photo")
                Text("Image")
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .opacity(0.8)
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 9)
            // Match the input row's baseline height exactly so toggling the chip never resizes it.
            .frame(height: composerFieldHeight)
            .background(Theme.userBubble, in: Capsule())
        }
        .buttonStyle(.plain)
        .transition(.scale.combined(with: .opacity))
        .accessibilityLabel("Image command active. Activate to cancel.")
    }

    /// Detects the `/image ` command as the user types and converts it into image mode: the token
    /// is lifted out of the field into the chip, leaving just the prompt behind.
    private func enterImageModeIfCommanded() {
        guard !isImageMode, let prompt = ImageCommand.prompt(in: draft) else { return }
        withAnimation(.snappy(duration: 0.2)) { isImageMode = true }
        draft = prompt
    }

    /// The composer button's symbol: a stop control while a reply streams, otherwise the
    /// image-mode sparkle or the plain send arrow.
    private var composerButtonSymbol: String {
        if engine.isResponding { return "stop.circle.fill" }
        return isImageMode ? "sparkles" : "arrow.up.circle.fill"
    }

    private var canSend: Bool {
        engine.canSend(draft: draft)
    }

    private var isInputDisabled: Bool {
        engine.isComposerDisabled
    }

    private let bottomAnchorID = "bottom-anchor"

    private func send() {
        let outgoing = draft
        let asImage = isImageMode
        guard canSend else { return }
        draft = ""
        isImageMode = false
        sentCount += 1
        engine.submit(outgoing, asImage: asImage)
    }

    /// Stops the in-flight reply. The engine cancels the streaming turn, which keeps whatever text
    /// arrived so far and re-enables the composer — the escape hatch for a runaway generation.
    private func cancel() {
        engine.cancelActiveTurn()
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
