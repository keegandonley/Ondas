import Foundation
import FoundationModels
import Observation
import OSLog
import SwiftData

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

    private static let chatInstructionsText =
        """
        You are Ondas, a helpful and friendly assistant that runs entirely on the user's
        device. Answer conversationally and concisely. When the user wants a picture, drawing,
        illustration, logo, or other visual — including when they accept an image you offered to
        make — call the generateImage tool with a vivid description. The tool creates and shows
        the image to the user, so reply naturally about the image you made; never say you can't
        create images.
        """

    /// Points the engine at `conversation`, rebuilding the model session only when the
    /// target thread actually changes. Safe to call repeatedly (e.g. from `.task(id:)`).
    func configure(conversation: Conversation, context: ModelContext) {
        modelContext = context
        if self.conversation?.id != conversation.id || session == nil {
            self.conversation = conversation
            let (newSession, collector) = Self.makeSession(for: conversation)
            session = newSession
            imageCollector = collector
        }
        refreshAvailability()
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

    /// Appends the user's message, then a model reply — which may include a tool-generated image
    /// — saving after each step so a mid-flight termination still leaves a coherent transcript.
    func send(_ raw: String) async {
        guard let conversation, let modelContext, let session, let imageCollector else { return }
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // A full chat is closed to new turns — the UI reflects this, but guard defensively so a
        // late send (e.g. an in-flight submit) can't push past the cap.
        guard !text.isEmpty, !isResponding, !conversation.isAtCapacity else { return }

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
            conversation.updatedAt = .now
            save(modelContext)
        }

        if let availabilityMessage {
            assistant.text = availabilityMessage
            return
        }

        await respond(to: text, session: session, collector: imageCollector, into: assistant)
    }

    /// Runs one model turn. The model answers in natural language and, when the user wants a
    /// picture, calls the image tool itself; any image it produced is drained from `collector`
    /// and attached to the assistant message. Routing through the live `session` records the turn
    /// so follow-ups like "make it bigger" keep their context.
    private func respond(
        to text: String,
        session: LanguageModelSession,
        collector: GeneratedImageCollector,
        into assistant: ChatMessage
    ) async {
        // Start the turn with an empty collector so this message only attaches what it generates.
        await collector.reset()
        do {
            let reply = try await session.respond(to: text).content
            if let imageData = await collector.take() {
                assistant.imageData = imageData
            }
            assistant.text = reply
        } catch {
            // The turn failed. Drain the collector first: if the tool produced an image before the
            // failure (e.g. reply composition threw afterward), keep it — the user still gets the
            // picture they asked for, and it stands alone rather than beside a contradictory error
            // caption. Only when no image survived do we surface a friendly message. A
            // `ToolCallError` means the tool itself threw (e.g. the generator is unavailable), so
            // unwrap its real cause for the message.
            if let imageData = await collector.take() {
                assistant.imageData = imageData
            } else if let toolError = error as? LanguageModelSession.ToolCallError {
                assistant.text = friendlyMessage(for: toolError.underlyingError)
            } else {
                assistant.text = friendlyMessage(for: error)
            }
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
