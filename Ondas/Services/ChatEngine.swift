import Foundation
import FoundationModels
import Observation
import OSLog
import SwiftData

/// A snapshot of how much of the on-device model's context window a conversation is using.
/// `used` and `limit` are token counts; `limit` is the context window minus a reserve kept free
/// for the model's reply. Drives the in-chat token meter and the token-based capacity cap.
struct TokenUsage: Equatable {
    let used: Int
    let limit: Int

    /// 0...1 share of the usable budget consumed, for the meter's progress bar.
    var fraction: Double {
        guard limit > 0 else { return 0 }
        return min(1, Double(used) / Double(limit))
    }

    /// True once the conversation has consumed its usable token budget and can take no more turns.
    var isAtCapacity: Bool { used >= limit }
}

/// A marker of the most recently finished model turn, so the UI can fire a completion haptic.
/// `id` changes on every turn (making it a usable `sensoryFeedback` trigger); `failed`
/// distinguishes an error turn (error haptic) from a normal reply (soft-impact haptic).
struct TurnSignal: Equatable {
    let id: Int
    let failed: Bool
}

/// Drives one conversation: sends user messages to the on-device language model and persists
/// both sides of the exchange to SwiftData (which syncs via CloudKit).
///
/// Image generation is the model's own decision: an `ImageGenerationTool` is registered on the
/// live `LanguageModelSession`, so when the user asks for a picture the model calls the tool,
/// the tool produces the image, and the model writes a genuine natural-language reply about it.
/// There is no out-of-model intent classifier or acknowledgment reframing — the model knows an
/// image was made because it made it.
///
/// Lives on the main actor and orchestrates every step sequentially, so all SwiftData mutation
/// happens on the main context and there is no cross-actor state to guard. The one value that
/// crosses actors — image bytes produced inside the off-main-actor tool call — comes back
/// through the `Sendable` `GeneratedImageCollector`.
///
/// A `LanguageModelSession` holds the in-memory chat context. It is rebuilt when the engine is
/// pointed at a different conversation, rehydrating the model's working memory from the
/// persisted transcript so context survives app relaunches and thread switches.
@MainActor
@Observable
final class ChatEngine {
    /// True while a model response (text or image) is in flight; the UI disables the
    /// composer and shows a progress indicator.
    private(set) var isResponding = false

    /// Non-nil when the on-device language model can't run, carrying a user-facing reason.
    private(set) var availabilityMessage: String?

    /// Live token usage for the current conversation, or nil when token counting isn't available
    /// (before iOS 26.4, or a count failed) — in which case the message-count cap applies instead.
    private(set) var tokenUsage: TokenUsage?

    /// Marks the most recently completed turn so the view can fire a completion/error haptic.
    private(set) var lastTurn: TurnSignal?
    private var turnCounter = 0

    /// The in-flight turn, if any. Held so it can be cancelled when the view is torn down or the
    /// conversation changes — otherwise a streamed reply (now multi-second, not instant) would keep
    /// writing into, and re-saving, a conversation the user has already navigated away from or deleted.
    private var activeTurn: Task<Void, Never>?

    private var conversation: Conversation?
    private var modelContext: ModelContext?
    private var session: LanguageModelSession?

    /// Drains images the `ImageGenerationTool` produces during a `respond` turn. Paired with
    /// `session` (both are rebuilt together in `makeSession`) since the tool holds this same
    /// collector.
    private var imageCollector: GeneratedImageCollector?

    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.keegancodes.ondas",
        category: "ChatEngine"
    )

    /// Tokens held back from the context window for the model's reply, so a nearly-full chat can
    /// still answer. Tuned against the on-device model's small (~4k-token) context window.
    private static let responseTokenReserve = 1024

    /// Whether the conversation can accept another turn. Prefers the real token budget; falls back
    /// to the message-count cap when token counting is unavailable (pre-iOS 26.4 or a failed count).
    var isAtCapacity: Bool {
        if let tokenUsage { return tokenUsage.isAtCapacity }
        return conversation?.isAtCapacity ?? false
    }

    private static let chatInstructionsText =
        """
        You are Ondas, a helpful and friendly assistant that runs entirely on the user's
        device. Answer conversationally and concisely, in text.

        Only call the generateImage tool when the user explicitly asks you to create, draw,
        generate, or make a picture or other visual — or clearly accepts an image you just
        offered. Never call it for informational questions, facts, definitions, or ordinary
        conversation, even when the subject is a place, person, or object that could be
        pictured. For example, "what's the capital of Texas" is a plain text answer, not an
        image. When in doubt, answer with text. After you do generate an image, reply
        naturally about the image you made rather than saying you can't create images.
        """

    /// Points the engine at `conversation`, rebuilding the model session only when the
    /// target thread actually changes. Safe to call repeatedly (e.g. from `.task(id:)`).
    func configure(conversation: Conversation, context: ModelContext) async {
        modelContext = context
        if self.conversation?.id != conversation.id || session == nil {
            // Abandon any turn still streaming into the previous conversation before switching.
            cancelActiveTurn()
            self.conversation = conversation
            let (newSession, collector) = Self.makeSession(for: conversation)
            session = newSession
            imageCollector = collector
        }
        refreshAvailability()
        await refreshTokenUsage()
    }

    /// Builds the session for `conversation`, rehydrating the model's working memory from the
    /// persisted transcript so context survives app relaunches and thread switches, and
    /// registering the image-generation tool. A brand-new thread starts from a blank
    /// instructions-only session. Returns the collector the tool writes into so the engine can
    /// drain it after each turn.
    private static func makeSession(for conversation: Conversation) -> (LanguageModelSession, GeneratedImageCollector) {
        let collector = GeneratedImageCollector()
        let tool = ImageGenerationTool(collector: collector)
        let history = conversation.orderedMessages

        let session: LanguageModelSession
        if history.isEmpty {
            session = LanguageModelSession(
                tools: [tool],
                instructions: Instructions(chatInstructionsText)
            )
        } else {
            session = LanguageModelSession(
                model: SystemLanguageModel.default,
                tools: [tool],
                transcript: makeTranscript(from: history)
            )
        }
        return (session, collector)
    }

    /// Reconstructs a `Transcript` from stored messages: a leading instructions entry (so the
    /// rehydrated session keeps its system prompt) followed by every message mapped to a
    /// prompt/response entry. Seeding the whole history is safe because `Conversation.messageLimit`
    /// hard-caps how long a chat can grow.
    private static func makeTranscript(from history: [ChatMessage]) -> Transcript {
        var entries: [Transcript.Entry] = [
            .instructions(Transcript.Instructions(
                id: "instructions",
                segments: [.text(Transcript.TextSegment(id: "instructions-text", content: chatInstructionsText))],
                toolDefinitions: []
            ))
        ]

        for message in history {
            let content = seededContent(for: message)
            guard !content.isEmpty else { continue }
            let segment = Transcript.Segment.text(
                Transcript.TextSegment(id: "\(message.id.uuidString)-segment", content: content)
            )
            switch message.role {
            case .user:
                entries.append(.prompt(Transcript.Prompt(
                    id: message.id.uuidString,
                    segments: [segment],
                    options: GenerationOptions(),
                    responseFormat: nil
                )))
            case .assistant:
                entries.append(.response(Transcript.Response(
                    id: message.id.uuidString,
                    assetIDs: [],
                    segments: [segment]
                )))
            }
        }
        return Transcript(entries: entries)
    }

    /// The text used to represent a message inside the rehydrated transcript. Generated images
    /// carry no language content of their own, so stand in a short note (using the caption when
    /// present) that keeps the model aware an image was produced for follow-up references.
    private static func seededContent(for message: ChatMessage) -> String {
        if message.role == .assistant, message.hasImage {
            let caption = message.text.isEmpty ? "" : " (\(message.text))"
            return "[Generated an image for the user's request.\(caption)]"
        }
        return message.text
    }

    private func refreshAvailability() {
        switch SystemLanguageModel.default.availability {
        case .available:
            availabilityMessage = nil
        case .unavailable(let reason):
            availabilityMessage = Self.message(for: reason)
        }
    }

    /// Recomputes `tokenUsage` from the session's live transcript against the model's context
    /// window. Token counting is iOS 26.4+; on earlier systems (or if a count throws), `tokenUsage`
    /// is cleared and capacity falls back to the message-count cap.
    private func refreshTokenUsage() async {
        guard let session else { return }
        guard #available(iOS 26.4, *) else {
            tokenUsage = nil
            return
        }
        let model = SystemLanguageModel.default
        // `contextSize` is the model's full window; hold back a reserve for the reply. If the
        // window is somehow no larger than the reserve, treat the budget as undeterminable and
        // fall back to the message-count cap rather than wedging an empty chat at capacity.
        let limit = model.contextSize - Self.responseTokenReserve
        guard limit > 0 else {
            tokenUsage = nil
            return
        }
        do {
            // The session transcript is the exact context the model carries (instructions + turns).
            let used = try await model.tokenCount(for: session.transcript)
            // The engine is reused across conversations (`.task(id:)` re-`configure`s it in place),
            // so a thread switch may have swapped `session` while this count was in flight. Only
            // commit if it's still the session we counted — otherwise a stale count could lock out
            // the now-current chat.
            guard self.session === session else { return }
            tokenUsage = TokenUsage(used: used, limit: limit)
        } catch {
            guard self.session === session else { return }
            tokenUsage = nil
        }
    }

    /// Starts a turn as a tracked task so it can be cancelled if the user leaves the conversation.
    /// The composer disables itself while `isResponding`, so there is only ever one active turn.
    func submit(_ raw: String) {
        activeTurn = Task { [weak self] in await self?.send(raw) }
    }

    /// Cancels the in-flight turn (if any). The streaming loop checks `Task.isCancelled` and stops
    /// writing, and `send` skips its trailing persistence so a torn-down/deleted conversation isn't
    /// touched.
    func cancelActiveTurn() {
        activeTurn?.cancel()
        activeTurn = nil
    }

    /// Appends the user's message, then a model reply — which may include a tool-generated image
    /// — saving after each step so a mid-flight termination still leaves a coherent transcript.
    func send(_ raw: String) async {
        guard let conversation, let modelContext, let session, let imageCollector else { return }
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // A full chat is closed to new turns — the UI reflects this, but guard defensively so a
        // late send (e.g. an in-flight submit) can't push past the token/message cap.
        guard !text.isEmpty, !isResponding, !isAtCapacity else { return }

        let wasEmpty = !conversation.hasMessages
        let now = Date.now

        let userMessage = ChatMessage(role: .user, text: text, createdAt: now)
        userMessage.conversation = conversation
        modelContext.insert(userMessage)
        if wasEmpty {
            conversation.title = ConversationTitle.derive(from: text)
        }
        conversation.updatedAt = now
        save(modelContext)

        // A placeholder assistant bubble the UI can show a spinner in until it's filled.
        // Nudged 1ms later so it always sorts after the user message.
        let assistant = ChatMessage(role: .assistant, createdAt: now.addingTimeInterval(0.001))
        assistant.conversation = conversation
        modelContext.insert(assistant)
        save(modelContext)

        isResponding = true
        defer {
            isResponding = false
            // Skip the final save if the turn was cancelled: the conversation may have been left or
            // deleted, so bumping `updatedAt`/saving would touch a torn-down model.
            if !Task.isCancelled {
                conversation.updatedAt = .now
                save(modelContext)
            }
        }

        if let availabilityMessage {
            assistant.text = availabilityMessage
            return
        }

        let failed = await respond(to: text, session: session, collector: imageCollector, into: assistant)
        // Re-enable the composer as soon as the reply lands; the token refresh below updates the
        // meter and cap without making the user wait on a second model call. (The defer resets
        // this too, so every exit path is covered.)
        isResponding = false
        // The user navigated away mid-reply; don't refresh the meter or fire a completion haptic
        // for a conversation that's no longer on screen.
        guard !Task.isCancelled else { return }
        // The turn changed the session transcript; refresh the meter and token-based cap.
        await refreshTokenUsage()
        // Signal the finished turn so the view can play a completion (or error) haptic.
        turnCounter += 1
        lastTurn = TurnSignal(id: turnCounter, failed: failed)
    }

    /// Runs one model turn. The model answers in natural language and, when the user wants a
    /// picture, calls the image tool itself; any image it produced is drained from `collector`
    /// and attached to the assistant message. Routing through the live `session` records the turn
    /// so follow-ups like "make it bigger" keep their context.
    /// Returns `true` if the turn failed (so the caller can pick an error haptic).
    private func respond(
        to text: String,
        session: LanguageModelSession,
        collector: GeneratedImageCollector,
        into assistant: ChatMessage
    ) async -> Bool {
        // Start the turn with an empty collector so this message only attaches what it generates.
        await collector.reset()
        do {
            // Stream the reply so text appears token-by-token instead of all at once. Each
            // snapshot carries the full response so far, so assigning it directly keeps
            // `assistant.text` correct without manual concatenation. These in-memory updates
            // drive the UI via @Observable; the turn is persisted once it completes (see `send`).
            for try await snapshot in session.streamResponse(to: text) {
                // Stop writing into the message once the turn is cancelled (view gone / thread
                // switched or deleted), rather than mutating an abandoned model each token.
                if Task.isCancelled { break }
                assistant.text = snapshot.content
            }
            if let imageData = await collector.take() {
                assistant.imageData = imageData
            }
            return false
        } catch {
            // The turn failed. Drain the collector first: if the tool produced an image before the
            // failure (e.g. reply composition threw afterward), keep it — the user still gets the
            // picture they asked for, and it stands alone rather than beside a contradictory error
            // caption (any partial streamed text is dropped). Only when no image survived do we
            // surface a friendly message. A `ToolCallError` means the tool itself threw (e.g. the
            // generator is unavailable), so unwrap its real cause for the message.
            if let imageData = await collector.take() {
                assistant.imageData = imageData
                assistant.text = ""
            } else if let toolError = error as? LanguageModelSession.ToolCallError {
                assistant.text = friendlyMessage(for: toolError.underlyingError)
            } else {
                assistant.text = friendlyMessage(for: error)
            }
            return true
        }
    }

    private func save(_ context: ModelContext?) {
        do {
            try context?.save()
        } catch {
            // A save failure here is non-fatal: the in-memory objects stay correct and the
            // next successful save persists them. Surfacing it would interrupt the chat, but a
            // systemic schema/CloudKit fault would fail every save, so log it for diagnosis.
            Self.logger.error("Failed to save chat context: \(error, privacy: .public)")
        }
    }

    private func friendlyMessage(for error: Error) -> String {
        if let generationError = error as? ImageGenerator.GenerationError {
            return generationError.errorDescription ?? "Something went wrong."
        }
        return "Sorry, I couldn't finish that. Please try again."
    }

    private static func message(for reason: SystemLanguageModel.Availability.UnavailableReason) -> String {
        switch reason {
        case .deviceNotEligible:
            return "This device doesn't support Apple Intelligence, so chat isn't available."
        case .appleIntelligenceNotEnabled:
            return "Turn on Apple Intelligence in Settings to start chatting."
        case .modelNotReady:
            return "The on-device model is still downloading. Try again shortly."
        @unknown default:
            return "On-device intelligence is currently unavailable."
        }
    }
}
