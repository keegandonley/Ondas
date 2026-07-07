import Foundation
import FoundationModels
import Observation
import OSLog
import SwiftData

/// The language model's decision about whether a user message is an image request, and the
/// prompt to hand the image generator when it is. `@Generable` lets the on-device model fill
/// this in a single structured response.
@Generable
struct ImageIntent {
    @Guide(description: "True only when the user clearly wants a picture, drawing, illustration, logo, or other visual to be created. False for general chat or questions about existing images.")
    var wantsImage: Bool

    @Guide(description: "When wantsImage is true, a vivid, self-contained visual description suitable for an image generator, capturing the subject and any style the user asked for. Empty otherwise.")
    var imagePrompt: String
}

/// Drives one conversation: sends user messages to the on-device language model, decides
/// when to generate an image instead of a text reply, and persists both sides of the
/// exchange to SwiftData (which syncs via CloudKit).
///
/// Lives on the main actor and orchestrates every step sequentially, so all SwiftData
/// mutation happens on the main context and there is no cross-actor state to guard.
///
/// A `LanguageModelSession` holds the in-memory chat context. It is rebuilt when the engine
/// is pointed at a different conversation, so context is retained while a thread is open but
/// not restored across app launches — the full history is always persisted and shown either
/// way.
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

    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.keegancodes.ondas",
        category: "ChatEngine"
    )

    private static let chatInstructionsText =
        """
        You are Ondas, a helpful and friendly assistant that runs entirely on the
        user's device. Answer conversationally and concisely. When the user asks you to
        create, draw, or generate an image, the app produces the image for you — briefly
        and naturally acknowledge the request rather than describing pixels.
        """

    private static let classifierInstructions = Instructions(
        """
        You decide whether a user's message is a request to generate an image. Only set
        wantsImage to true when the user clearly wants a picture, drawing, illustration,
        logo, or other visual created. General questions and ordinary chat are false. When
        true, write imagePrompt as a single vivid, self-contained visual description for an
        image generator, incorporating the subject and any style the user requested.
        """
    )

    /// Points the engine at `conversation`, rebuilding the model session only when the
    /// target thread actually changes. Safe to call repeatedly (e.g. from `.task(id:)`).
    func configure(conversation: Conversation, context: ModelContext) {
        modelContext = context
        if self.conversation?.id != conversation.id || session == nil {
            self.conversation = conversation
            session = Self.makeSession(for: conversation)
        }
        refreshAvailability()
    }

    /// Builds the session for `conversation`, rehydrating the model's working memory from the
    /// persisted transcript so context survives app relaunches and thread switches. A brand-new
    /// thread starts from a blank instructions-only session.
    private static func makeSession(for conversation: Conversation) -> LanguageModelSession {
        let history = conversation.orderedMessages
        guard !history.isEmpty else {
            return LanguageModelSession(instructions: Instructions(chatInstructionsText))
        }
        return LanguageModelSession(
            model: SystemLanguageModel.default,
            tools: [],
            transcript: makeTranscript(from: history)
        )
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

    /// Appends the user's message, then a model reply (text) or a generated image, saving
    /// after each step so a mid-flight termination still leaves a coherent transcript.
    func send(_ raw: String) async {
        guard let conversation, let modelContext, let session else { return }
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

        if ImageRequestHeuristic.mightRequestImage(text),
           let prompt = await imagePrompt(for: text) {
            await generateImage(prompt: prompt, for: text, session: session, into: assistant)
            return
        }

        await respondWithText(to: text, session: session, into: assistant)
    }

    /// Runs the image-intent classifier in a throwaway session so it never pollutes the
    /// chat transcript. Returns the prompt to generate, or nil to fall back to a text reply.
    private func imagePrompt(for text: String) async -> String? {
        let classifier = LanguageModelSession(instructions: Self.classifierInstructions)
        do {
            let decision = try await classifier.respond(to: text, generating: ImageIntent.self).content
            guard decision.wantsImage else { return nil }
            let prompt = decision.imagePrompt.trimmingCharacters(in: .whitespacesAndNewlines)
            return prompt.isEmpty ? text : prompt
        } catch {
            // A classifier failure shouldn't block the conversation — treat as plain chat.
            return nil
        }
    }

    /// Produces an image and a short spoken acknowledgment for an image turn.
    ///
    /// The acknowledgment is routed through the live `session` (not the throwaway classifier)
    /// so the running chat context records this turn — otherwise a follow-up like "make it
    /// bigger" would have no memory that an image was ever requested. The two model calls run
    /// concurrently since neither depends on the other.
    private func generateImage(
        prompt: String,
        for userText: String,
        session: LanguageModelSession,
        into assistant: ChatMessage
    ) async {
        assistant.text = "Creating your image…"
        save(modelContext)

        // Kick off image generation in a child task (a static call over Sendable args, so no
        // captured non-Sendable state), then run the acknowledgment on the main actor — the two
        // still overlap. The acknowledgment goes through the live `session` so this turn is
        // recorded in the chat context for follow-ups like "make it bigger".
        async let generated = ImageGenerator.generate(prompt: prompt)
        let acknowledgment = (try? await session.respond(to: userText).content) ?? ""

        do {
            assistant.imageData = try await generated
            assistant.text = acknowledgment
        } catch {
            assistant.text = friendlyMessage(for: error)
        }
    }

    private func respondWithText(
        to text: String,
        session: LanguageModelSession,
        into assistant: ChatMessage
    ) async {
        do {
            assistant.text = try await session.respond(to: text).content
        } catch {
            assistant.text = friendlyMessage(for: error)
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
