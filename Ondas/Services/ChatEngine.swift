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

        You may be given the assistant's previous message alongside the user's reply. If the
        assistant offered to create an image and the user's reply accepts it (e.g. "yes",
        "sure"), set wantsImage to true and build imagePrompt from the image the assistant
        offered — the reply itself won't restate the subject.

        Never leave imagePrompt empty when wantsImage is true; always describe the subject.
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
        // Capture the assistant's last turn before inserting this one, so a bare acceptance like
        // "yes" can be resolved against an image the assistant may have just offered. Only a
        // text-only turn can be an *offer*; a turn that already produced an image is a
        // fulfillment, so a following "yes" must not spawn a duplicate.
        let lastAssistant = conversation.orderedMessages.last { $0.role == .assistant }
        let previousAssistantText = (lastAssistant?.hasImage == true) ? nil : lastAssistant?.text
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

        if let prompt = await imagePrompt(for: text, offeredBy: previousAssistantText) {
            await generateImage(prompt: prompt, session: session, into: assistant)
            return
        }

        await respondWithText(to: text, session: session, into: assistant)
    }

    /// Decides whether this turn should produce an image and, if so, returns the prompt to
    /// generate; nil falls back to a text reply.
    ///
    /// A cheap keyword prefilter gates the model classifier so ordinary chat never pays for it.
    /// The prefilter also escalates a bare acceptance ("yes", "sure") when `previousAssistant`
    /// looks like an image offer; in that case the offer text is handed to the classifier as
    /// context so it can resolve the acceptance and write a prompt from what was offered. The
    /// classifier runs in a throwaway session so it never pollutes the chat transcript.
    private func imagePrompt(for text: String, offeredBy previousAssistant: String?) async -> String? {
        let acceptsOffer = ImageRequestHeuristic.acceptsImageOffer(text, previousAssistant: previousAssistant)
        guard ImageRequestHeuristic.mightRequestImage(text) || acceptsOffer else { return nil }

        // A direct request stands on its own; only a bare acceptance needs the prior offer to
        // make sense, so pass context (and pay the extra tokens) only then.
        let context = acceptsOffer ? previousAssistant : nil
        let classifier = LanguageModelSession(instructions: Self.classifierInstructions)
        do {
            let decision = try await classifier.respond(
                to: Self.classifierPrompt(for: text, previousAssistant: context),
                generating: ImageIntent.self
            ).content
            guard decision.wantsImage else { return nil }
            let extracted = decision.imagePrompt.trimmingCharacters(in: .whitespacesAndNewlines)
            if !extracted.isEmpty { return extracted }
            // The classifier flagged an image but gave no prompt. A direct request is already
            // image-shaped, so the user's own message is a usable fallback; a bare acceptance
            // ("yes") carries no subject to draw, so decline rather than feed the generator a
            // stray question.
            return acceptsOffer ? nil : text
        } catch {
            // A classifier failure shouldn't block the conversation — treat as plain chat.
            return nil
        }
    }

    /// Builds the classifier's input. Without context it's just the user's message; when the user
    /// is replying to an image the assistant offered, both turns are included so a bare "yes"
    /// resolves against the offer.
    private static func classifierPrompt(for text: String, previousAssistant: String?) -> String {
        guard let previousAssistant, !previousAssistant.isEmpty else { return text }
        return """
            The assistant previously said: "\(previousAssistant)"
            The user now replied: "\(text)"

            Decide whether the user is asking for an image, including accepting one the assistant \
            just offered. If so, base imagePrompt on the image described in that exchange.
            """
    }

    /// Produces an image and a short spoken acknowledgment for an image turn.
    ///
    /// Image generation runs first; the acknowledgment is only requested — and thereby recorded
    /// in the live `session`'s transcript — *after* the image actually exists. Ordering it this
    /// way keeps the session's context truthful: it never carries an "I made you an image" turn
    /// for an image that failed to generate, so follow-ups like "make it bigger" are grounded in
    /// reality. Routing the acknowledgment through the live `session` (not the throwaway
    /// classifier) is what records the turn for those follow-ups.
    private func generateImage(
        prompt: String,
        session: LanguageModelSession,
        into assistant: ChatMessage
    ) async {
        assistant.text = "Creating your image…"
        save(modelContext)

        do {
            let imageData = try await ImageGenerator.generate(prompt: prompt)
            assistant.imageData = imageData
            assistant.text = await acknowledgment(for: prompt, session: session)
        } catch {
            assistant.text = friendlyMessage(for: error)
        }
    }

    /// Asks the live model to caption an image that already exists. Falls back to a canned line
    /// when the model returns nothing usable — including when it still produces a refusal despite
    /// the reframed prompt, which would otherwise sit contradictorily next to the shown image.
    private func acknowledgment(for prompt: String, session: LanguageModelSession) async -> String {
        let spoken = ((try? await session.respond(to: Self.acknowledgmentPrompt(for: prompt)).content) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if spoken.isEmpty || Self.looksLikeRefusal(spoken) {
            return Self.acknowledgmentFallback
        }
        return spoken
    }

    /// Default acknowledgment used when the model returns nothing usable.
    private static let acknowledgmentFallback = "Here's your image!"

    /// Phrases that mark a reply as the model wrongly claiming it can't make the image — the very
    /// refusal the acknowledgment prompt is designed to avoid. Kept specific to image-creation
    /// denials so ordinary captions that merely contain "can't" aren't discarded.
    private static let refusalMarkers = [
        "can't create", "cannot create", "can't generate", "cannot generate",
        "can't make", "cannot make", "can't produce", "cannot produce",
        "unable to create", "unable to generate", "don't have the ability",
    ]

    private static func looksLikeRefusal(_ text: String) -> Bool {
        let lowered = text.lowercased()
        return refusalMarkers.contains { lowered.contains($0) }
    }

    /// Prompts the live model to caption an image that *already exists*, rather than replaying
    /// the user's "draw me X" request. The on-device model has no image capability and will
    /// often refuse a raw generation request ("I can't create images") — a refusal that would
    /// then sit right next to the image the app already produced. Framing the image as done
    /// avoids that contradiction while still recording the turn for follow-ups.
    private static func acknowledgmentPrompt(for imagePrompt: String) -> String {
        """
        You just created and showed the user an image of: \(imagePrompt)
        Reply with one short, friendly sentence acknowledging it. Do not say you can't create \
        images — the image already exists.
        """
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
