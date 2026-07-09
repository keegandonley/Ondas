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

    /// Fraction of the budget at/after which the chat warns and offers compaction. Set below 1 so
    /// compaction is offered while there's still headroom to summarize the live turns in one pass —
    /// once the window is truly full the summarizer itself would overflow, so we don't offer it then.
    static let warningFraction = 0.8

    /// True in the warning band: near the budget but not yet full, so the chat still accepts input
    /// while nudging the user to compact.
    var isApproachingCapacity: Bool { fraction >= Self.warningFraction && !isAtCapacity }
}

/// How close a conversation is to the model's context budget, driving the composer and banner.
/// `.approaching` warns and offers compaction while still accepting input; `.full` blocks input and
/// offers only a fresh chat — by then the conversation is too large to summarize reliably.
enum CapacityState {
    case normal
    case approaching
    case full
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
/// Image generation is an explicit, model-free path: when the user sends the `/image` command
/// (`asImage`), the engine calls `ImageGenerator` directly, attaches the picture, and writes no
/// text — the language model never runs on an image turn. This is deterministic and sidesteps every
/// failure the model showed when it was in the loop for images (over-triggering on bare nouns,
/// refusing genuine requests, and narrating or hallucinating base64/markdown alongside a real
/// image). Plain messages run through the model as normal text turns.
///
/// Lives on the main actor and orchestrates every step sequentially, so all SwiftData mutation
/// happens on the main context and there is no cross-actor state to guard. Image bytes come back
/// from `ImageGenerator` (which does its work off the main actor) as a plain `Sendable` `Data`
/// value the engine simply awaits and assigns.
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

    /// True while a compaction is summarizing the conversation, so the "Continue" action can show
    /// a progress state and ignore repeat taps.
    private(set) var isCompacting = false

    /// Bumped when a compaction starts, so a superseded compaction's `defer` (unwinding after its
    /// `await` on a thread the user already left) can't clear the flag out from under a newer,
    /// genuinely in-flight compaction. Only the current generation's task resets `isCompacting`.
    private var compactionGeneration = 0

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
    private let generationSettings = GenerationSettingsStore()

    /// Tokens held back from the context window for the model's reply, so a nearly-full chat can
    /// still answer. Tuned against the on-device model's small (~4k-token) context window.
    private static let responseTokenReserve = 1024

    private static let logger = Logger(subsystem: AppInfo.bundleID, category: "ChatEngine")

    /// The conversation's standing against the context budget. Prefers the real token budget; falls
    /// back to the message-count cap when token counting is unavailable (pre-iOS 26.4 or a failed
    /// count). `.approaching` still accepts input (and offers compaction); `.full` does not.
    var capacityState: CapacityState {
        if let tokenUsage {
            if tokenUsage.isAtCapacity { return .full }
            if tokenUsage.isApproachingCapacity { return .approaching }
            return .normal
        }
        return conversation?.capacityState ?? .normal
    }

    private static let chatInstructionsText =
        """
        You are Ondas, a helpful and friendly assistant that runs entirely on the user's
        device. Answer conversationally and concisely, in text. Always respond to the user's most
        recent message; never repeat one of your earlier replies.

        """

    /// Target length for a compaction summary, in words. Kept well under the ~400-token budget the
    /// summary is allowed to occupy in the rebuilt context, and bounds growth across repeated
    /// compactions (each round re-condenses the previous summary to this same length).
    private static let summaryWordTarget = 150

    /// Instructions given to the throwaway session that condenses a conversation on compaction.
    private static let summaryInstructionsText =
        """
        You are compacting a long conversation to free up the model's limited context. Write a
        concise summary — about \(summaryWordTarget) words or fewer, and never more than a few short
        paragraphs — capturing the key facts, decisions, the user's stated preferences, and any open
        threads needed to continue the conversation naturally. Preserve names, numbers, and anything
        the user asked you to remember. Do not add commentary and do not address the user: output
        only the summary.
        """

    /// Builds the session's instructions, folding in a compaction summary (when present) as
    /// background context. It's framed as already-summarized prior context so the model treats it
    /// as memory rather than words to echo back on the next turn.
    private static func instructionsContent(summary: String?) -> String {
        guard let summary, !summary.isEmpty else { return chatInstructionsText }
        return chatInstructionsText + """

            Earlier in this conversation was compacted to save space. Here is a summary of what \
            happened so far — treat it as background context you already know; do not repeat it \
            back to the user:

            \(summary)
            """
    }

    /// Points the engine at `conversation`, rebuilding the model session only when the
    /// target thread actually changes. Safe to call repeatedly (e.g. from `.task(id:)`).
    func configure(conversation: Conversation, context: ModelContext) async {
        modelContext = context
        if self.conversation?.id != conversation.id || session == nil {
            // Abandon any turn still streaming into the previous conversation before switching.
            cancelActiveTurn()
            // Clear the compaction progress flag so a cancelled compaction on the previous thread
            // can't leave the newly-opened one transiently showing "Compacting…" (its orphaned
            // task's `defer` may not have unwound yet).
            isCompacting = false
            self.conversation = conversation
            session = Self.makeSession(for: conversation.orderedMessages)
        }
        refreshAvailability()
        await refreshTokenUsage()
    }

    /// Builds the conversation's text session, rehydrated from `history` so context survives
    /// relaunches and thread switches. There is no image tool: image generation is handled directly
    /// by the engine on `/image` turns and never involves the model. A brand-new (or fully empty)
    /// thread starts from a blank instructions-only session.
    ///
    /// When the conversation has been compacted, only the turns the model should still see are
    /// seeded (`Compaction.liveMessages`) and the summary of the older turns is folded into the
    /// instructions — the turns above the divider stay on screen but no longer feed the model.
    private static func makeSession(for history: [ChatMessage]) -> LanguageModelSession {
        let live = Compaction.liveMessages(in: history)
        let summary = Compaction.activeSummary(in: history)
        if live.isEmpty && summary == nil {
            return LanguageModelSession(instructions: Instructions(chatInstructionsText))
        }
        return LanguageModelSession(
            model: SystemLanguageModel.default,
            transcript: makeTranscript(summary: summary, messages: live)
        )
    }

    /// Reconstructs a `Transcript`: a leading instructions entry (so the rehydrated session keeps
    /// its system prompt, with any compaction summary folded in as background context) followed by
    /// each live message mapped to a prompt/response entry. Seeding a bounded set of turns is safe
    /// because `Conversation.messageLimit` and the token budget cap how far a segment can grow.
    private static func makeTranscript(summary: String?, messages: [ChatMessage]) -> Transcript {
        var entries: [Transcript.Entry] = [
            .instructions(Transcript.Instructions(
                id: "instructions",
                segments: [.text(Transcript.TextSegment(
                    id: "instructions-text",
                    content: instructionsContent(summary: summary)
                ))],
                toolDefinitions: []
            ))
        ]

        for message in messages {
            // App-generated error/availability notices are not model output; seeding them would
            // teach the rehydrated session it said "Sorry, I couldn't finish that." itself.
            // (Compaction markers are excluded upstream by `Compaction.liveMessages`.)
            guard !message.isError else { continue }
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

    /// The text used to represent a message inside the rehydrated transcript. Generated images carry
    /// no language content of their own, so an image turn is represented by its natural caption (or a
    /// plain fallback) — this still tells the model an image was produced, without a bracketed
    /// annotation the model would echo back verbatim as a reply on the next turn.
    private static func seededContent(for message: ChatMessage) -> String {
        if message.role == .assistant, message.hasImage {
            return message.text.isEmpty ? "I created an image for you." : message.text
        }
        return message.text
    }

    /// Recomputes `availabilityMessage` from the model's current availability. Called on
    /// configure, on each send, and when the app returns to the foreground (via `ChatView`),
    /// so the banner clears as soon as e.g. a model download finishes.
    func refreshAvailability() {
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
    /// `asImage` is true when the user sent the `/image` command, which is the only thing that gives
    /// the turn the image tool.
    ///
    /// The composer disables itself while `isResponding`, but that flag only flips once the task
    /// body runs — a second submit racing into that window would otherwise replace `activeTurn`
    /// and leave the real in-flight turn uncancellable. Guard the flag and cancel any not-yet-run
    /// predecessor so the handle always points at the one live turn.
    func submit(_ raw: String, asImage: Bool) {
        guard !isResponding, !isCompacting else { return }
        cancelActiveTurn()
        activeTurn = Task { [weak self] in await self?.send(raw, asImage: asImage) }
    }

    /// Cancels the in-flight turn (if any). The streaming loop checks `Task.isCancelled` and stops
    /// writing, and `send` skips its trailing persistence so a torn-down/deleted conversation isn't
    /// touched. Also covers an in-flight compaction (it shares `activeTurn`).
    func cancelActiveTurn() {
        activeTurn?.cancel()
        activeTurn = nil
    }

    /// Compacts the conversation in place: summarizes the turns since the last compaction, drops
    /// a "Conversation compacted" divider, and rebuilds the session from the summary plus a short
    /// verbatim tail — so the chat keeps going under the same `id` (and same OTLP session) instead
    /// of hitting a dead end at capacity. Manual only, driven by the capacity banner's Continue
    /// button. Runs as a tracked task so leaving the conversation cancels it, like a normal turn.
    func compact() {
        // Only from the warning band: `.full` is intentionally past the point of compaction (the
        // summarizer would overflow the same window), and `.normal` has nothing worth condensing.
        guard !isResponding, !isCompacting, capacityState == .approaching else { return }
        cancelActiveTurn()
        activeTurn = Task { [weak self] in await self?.performCompaction() }
    }

    private func performCompaction() async {
        guard let conversation, let modelContext, let session else { return }
        guard !Task.isCancelled else { return }

        // Re-check availability at the moment of use — summarization needs the model too.
        refreshAvailability()
        if let availabilityMessage {
            insertErrorNotice(availabilityMessage, into: conversation, context: modelContext)
            return
        }

        let ordered = conversation.orderedMessages
        // Summarize every live turn since the last compaction; the divider is appended at the end,
        // so the model continues from the summary alone (no verbatim tail kept).
        let toSummarize = Compaction.liveMessages(in: ordered)
        // Nothing to condense — compaction can't reclaim anything. Shouldn't happen while at
        // capacity (the segment is non-empty then), but guard rather than insert an empty divider.
        guard !toSummarize.isEmpty else { return }
        let previousSummary = Compaction.activeSummary(in: ordered)

        compactionGeneration += 1
        let generation = compactionGeneration
        isCompacting = true
        // Only clear the flag if this is still the current compaction — a superseded task
        // unwinding late must not re-enable the controls under a newer one.
        defer { if generation == compactionGeneration { isCompacting = false } }

        let start = Date.now
        let summary: String
        do {
            summary = try await Self.summarize(previousSummary: previousSummary, messages: toSummarize)
        } catch {
            // Surface a friendly notice and insert no marker, so the user can retry from the still-
            // showing capacity banner. Skip if the turn was abandoned (view gone / thread switched).
            guard !Task.isCancelled, !conversation.isDeleted else { return }
            Self.logFailure("Compaction summary", error)
            insertErrorNotice(friendlyMessage(for: error), into: conversation, context: modelContext)
            return
        }
        let end = Date.now

        // The user navigated away or deleted the thread while summarizing — don't touch the store.
        guard !Task.isCancelled, !conversation.isDeleted else { return }
        // The session that produced this summary may have been swapped by a thread change.
        guard self.session === session else { return }
        // An empty summary would silently discard the compacted context (folded-in summary becomes
        // nothing) — treat it as a failure so the user can retry rather than losing the history.
        guard !summary.isEmpty else {
            insertErrorNotice(friendlyMessage(for: CompactionError.emptySummary), into: conversation, context: modelContext)
            return
        }

        // Appended at the end (default `createdAt` of now sorts after every existing turn), so the
        // divider renders at the seam and the auto-scroll on message insertion brings it into view.
        let marker = ChatMessage(role: .assistant, text: summary)
        marker.isCompactionSummary = true
        marker.conversation = conversation
        modelContext.insert(marker)
        conversation.updatedAt = .now
        modelContext.saveOrLog()

        // Rebuild the working session from the now-compacted history: summary folded into
        // instructions + the short verbatim tail. This is what frees the context budget.
        self.session = Self.makeSession(for: conversation.orderedMessages)
        await refreshTokenUsage()

        // Report the summarization as its own `feature: "compaction"` span so it doesn't look like a
        // normal chat turn. Detached and snapshotted so it never delays teardown.
        let conversationID = conversation.id
        Task { [weak self] in
            await self?.recordCompactionTelemetry(conversationID: conversationID, summary: summary, start: start, end: end)
        }
    }

    /// Summarizes `messages` (optionally folding in the prior summary so compaction is cumulative)
    /// using a throwaway session — kept separate from the live chat session so this internal call
    /// never lands in the conversation's own transcript.
    private static func summarize(previousSummary: String?, messages: [ChatMessage]) async throws -> String {
        let summarizer = LanguageModelSession(instructions: Instructions(summaryInstructionsText))
        var lines: [String] = []
        if let previousSummary, !previousSummary.isEmpty {
            lines.append("Summary of the conversation so far:\n\(previousSummary)\n")
        }
        for message in messages {
            let speaker = message.role == .user ? "User" : "Assistant"
            lines.append("\(speaker): \(seededContent(for: message))")
        }
        let prompt = "Summarize this conversation:\n\n" + lines.joined(separator: "\n")
        let response = try await summarizer.respond(to: prompt)
        return response.content.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Failures specific to compaction that reuse the shared friendly-message path.
    private enum CompactionError: Error {
        /// The model returned an empty summary — inserting it would silently drop the context.
        case emptySummary
    }

    /// Inserts an app-generated error/availability notice as an assistant message. Marked `isError`
    /// so it's kept out of the rehydrated transcript and doesn't count toward capacity.
    private func insertErrorNotice(_ text: String, into conversation: Conversation, context: ModelContext) {
        guard !conversation.isDeleted else { return }
        let notice = ChatMessage(role: .assistant, text: text)
        notice.isError = true
        notice.conversation = conversation
        context.insert(notice)
        conversation.updatedAt = .now
        context.saveOrLog()
    }

    /// Appends the user's message, then a model reply — which may include a tool-generated image
    /// — saving after each step so a mid-flight termination still leaves a coherent transcript.
    func send(_ raw: String, asImage: Bool) async {
        guard let conversation, let modelContext else { return }
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // A full chat is closed to new turns — the UI reflects this, but guard defensively so a
        // late send (e.g. an in-flight submit) can't push past the token/message cap. A turn
        // cancelled before it ever ran (superseded in `submit`) must not touch the store at all.
        guard !text.isEmpty, !isResponding, capacityState != .full, !Task.isCancelled else { return }

        let wasEmpty = !conversation.hasMessages
        let now = Date.now

        let userMessage = ChatMessage(role: .user, text: text, createdAt: now)
        userMessage.conversation = conversation
        modelContext.insert(userMessage)
        if wasEmpty {
            conversation.title = ConversationTitle.derive(from: text)
        }
        conversation.updatedAt = now
        modelContext.saveOrLog()

        // A placeholder assistant bubble the UI can show a spinner in until it's filled.
        // Nudged 1ms later so it always sorts after the user message.
        let assistant = ChatMessage(role: .assistant, createdAt: now.addingTimeInterval(0.001))
        assistant.conversation = conversation
        modelContext.insert(assistant)
        modelContext.saveOrLog()

        isResponding = true
        defer {
            isResponding = false
            if Task.isCancelled {
                // The turn was abandoned (view gone / thread switched or deleted). Don't bump
                // `updatedAt` — but if no content ever arrived, remove the placeholder, or it
                // would persist (and sync) forever as a blank bubble. Saved immediately so a
                // process kill can't resurrect it. A partial streamed reply is kept.
                // (`isDeleted` guards the conversation-was-cascade-deleted race.)
                if !assistant.isDeleted, assistant.isEmptyPlaceholder {
                    modelContext.delete(assistant)
                    modelContext.saveOrLog()
                }
            } else {
                conversation.updatedAt = .now
                modelContext.saveOrLog()
            }
        }

        // Re-check availability at the moment of use: the model may have finished downloading —
        // or become unavailable — since the engine was configured.
        refreshAvailability()
        if let availabilityMessage {
            assistant.text = availabilityMessage
            assistant.isError = true
            return
        }

        // Snapshot the transcript token count as of the end of the previous turn, so telemetry can
        // report this turn's *marginal* prompt tokens rather than the whole cumulative context.
        let priorTokenCount = tokenUsage?.used

        // An `/image` turn generates directly with no model involvement; a plain turn streams a text
        // reply from the model. Either way `failed` picks the completion vs error haptic. Time only
        // this call for the telemetry span — not the surrounding DB saves or the token refresh below.
        let turnStart = Date.now
        let failed: Bool
        if asImage {
            failed = await generateImage(prompt: text, into: assistant)
        } else if let session {
            failed = await respond(to: text, session: session, into: assistant)
        } else {
            return
        }
        let turnEnd = Date.now
        // Re-enable the composer as soon as the reply lands; the token refresh below updates the
        // meter and cap without making the user wait. (The defer resets this too, so every exit
        // path is covered.)
        isResponding = false
        // The user navigated away mid-reply; don't refresh the meter or fire a completion haptic
        // for a conversation that's no longer on screen.
        guard !Task.isCancelled else { return }
        // A text turn changed the session transcript; refresh the meter and token-based cap. (An
        // image turn leaves the transcript untouched, but refreshing is harmless.)
        await refreshTokenUsage()
        // Signal the finished turn so the view can play a completion (or error) haptic.
        turnCounter += 1
        lastTurn = TurnSignal(id: turnCounter, failed: failed)

        // Best-effort usage telemetry, off unless the user enabled it in Settings. Transcript text
        // is attached only when separately opted in. Only successful turns are reported. Detached
        // and snapshotting the values first so it never delays the turn's teardown.
        if !failed {
            let conversationID = conversation.id
            let assistantText = assistant.text
            let currentTokenCount = tokenUsage?.used
            Task { [weak self] in
                await self?.recordTelemetry(
                    conversationID: conversationID,
                    asImage: asImage,
                    userText: text,
                    assistantText: assistantText,
                    priorTokenCount: priorTokenCount,
                    currentTokenCount: currentTokenCount,
                    start: turnStart,
                    end: turnEnd
                )
            }
        }
    }

    /// Reports a completed turn's usage as an OTLP span: an `ondas.tool` call for an `/image` turn
    /// (the model doesn't run), or an `ondas.llm` request for a text turn. The user and assistant
    /// text are forwarded to the telemetry service, which attaches them only when transcript capture
    /// is enabled. No-ops when telemetry is disabled, so the reply token count is skipped then.
    private func recordTelemetry(
        conversationID: UUID,
        asImage: Bool,
        userText: String,
        assistantText: String,
        priorTokenCount: Int?,
        currentTokenCount: Int?,
        start: Date,
        end: Date
    ) async {
        guard await TelemetryService.shared.isDeliverable else { return }

        if asImage {
            await TelemetryService.shared.recordToolCall(
                conversationID: conversationID,
                // Snake_case per the coding-stats OTLP contract (`tool_name = "generate_image"`).
                toolName: "generate_image",
                start: start,
                end: end
            )
            return
        }

        var inputTokens = 0
        var outputTokens = 0
        // Token counting is iOS 26.4+ only. Report this turn's *marginal* tokens: `completion` is the
        // reply; `prompt` is the new input added this turn (the user's message) — the growth in
        // transcript size since the previous turn, minus the reply. This keeps
        // `llm.token_count.prompt` a per-call figure comparable to the cache-aware claude_code/
        // opencode sources, instead of the whole ever-growing conversation context.
        if #available(iOS 26.4, *), let currentTokenCount {
            outputTokens = (try? await SystemLanguageModel.default.tokenCount(for: assistantText)) ?? 0
            let addedThisTurn = max(0, currentTokenCount - (priorTokenCount ?? 0))
            inputTokens = max(0, addedThisTurn - outputTokens)
        }
        await TelemetryService.shared.recordLLM(
            conversationID: conversationID,
            feature: "chat",
            prompt: userText,
            completion: assistantText,
            inputTokens: inputTokens,
            outputTokens: outputTokens,
            start: start,
            end: end
        )
    }

    /// Reports a compaction as an `ondas.llm` span tagged `feature: "compaction"`, so the internal
    /// summarization is counted and separable from real chat turns rather than masquerading as one.
    /// The summary is forwarded as the completion (attached only when transcript capture is on).
    /// No-ops when telemetry is disabled.
    private func recordCompactionTelemetry(
        conversationID: UUID,
        summary: String,
        start: Date,
        end: Date
    ) async {
        guard await TelemetryService.shared.isDeliverable else { return }
        var outputTokens = 0
        if #available(iOS 26.4, *) {
            outputTokens = (try? await SystemLanguageModel.default.tokenCount(for: summary)) ?? 0
        }
        await TelemetryService.shared.recordLLM(
            conversationID: conversationID,
            feature: "compaction",
            prompt: "",
            completion: summary,
            inputTokens: 0,
            outputTokens: outputTokens,
            start: start,
            end: end
        )
    }

    /// Generates an image for `prompt` directly (no model turn) and attaches it. Returns whether it
    /// failed, so the caller can pick an error haptic and surface a friendly message.
    private func generateImage(prompt: String, into assistant: ChatMessage) async -> Bool {
        do {
            let data = try await ImageGenerator.generate(prompt: prompt)
            // If the user left mid-generation, don't write into the abandoned message.
            guard !Task.isCancelled else { return false }
            assistant.imageData = data
            return false
        } catch {
            guard !Task.isCancelled else { return true }
            Self.logFailure("Image generation", error)
            assistant.text = friendlyMessage(for: error)
            assistant.isError = true
            return true
        }
    }

    /// Streams a plain text reply from the model into `assistant`, using the user's chosen response
    /// style (temperature). Returns whether the turn failed (so the caller can pick an error haptic).
    private func respond(
        to text: String,
        session: LanguageModelSession,
        into assistant: ChatMessage
    ) async -> Bool {
        // Read fresh each turn so a change in Settings (Precise/Balanced/Creative) applies to the
        // very next message. `.balanced` maps to `nil`, leaving the model's own default temperature.
        let options = GenerationOptions(temperature: generationSettings.load().temperature)
        do {
            // Stream the reply so text appears token-by-token instead of all at once. Each
            // snapshot carries the full response so far, so assigning it directly keeps
            // `assistant.text` correct without manual concatenation. These in-memory updates
            // drive the UI via @Observable; the turn is persisted once it completes (see `send`).
            for try await snapshot in session.streamResponse(to: text, options: options) {
                // Stop writing into the message once the turn is cancelled (view gone / thread
                // switched or deleted), rather than mutating an abandoned model each token.
                if Task.isCancelled { break }
                assistant.text = snapshot.content
            }
            return false
        } catch {
            // Cancellation usually surfaces here as a thrown `CancellationError`, not the loop's
            // `isCancelled` break — don't overwrite an abandoned (possibly deleted) message's
            // partial text with an error it never had.
            guard !Task.isCancelled else { return true }
            Self.logFailure("Text response", error)
            assistant.text = friendlyMessage(for: error)
            assistant.isError = true
            return true
        }
    }

    private func friendlyMessage(for error: Error) -> String {
        if let generationError = error as? ImageGenerator.GenerationError {
            return generationError.errorDescription ?? "Something went wrong."
        }
        if let modelError = error as? LanguageModelSession.GenerationError,
           let curated = Self.message(for: modelError) {
            return curated
        }
        return "Sorry, I couldn't finish that. Please try again."
    }

    /// Maps a Foundation Models generation error to a curated, user-facing message, or nil to use the
    /// generic fallback. Apple's own `errorDescription`s are developer-facing ("Exceeded the context
    /// window size."), so we don't surface them verbatim — this mirrors the availability and
    /// image-generation mappings. Structured-generation failures (`unsupportedGuide`,
    /// `decodingFailure`) shouldn't arise in plain chat, so they fall through to the generic message.
    private static func message(for error: LanguageModelSession.GenerationError) -> String? {
        switch error {
        case .exceededContextWindowSize:
            return "This conversation has grown too long to continue. Start a new chat to keep going."
        case .guardrailViolation, .refusal:
            return "I can't help with that request."
        case .unsupportedLanguageOrLocale:
            return "I can't respond in that language yet."
        case .rateLimited:
            return "Too many requests right now. Wait a moment and try again."
        case .concurrentRequests:
            return "I'm still finishing the last response. Try again in a moment."
        case .assetsUnavailable:
            return "The on-device model is still getting ready. Try again shortly."
        case .unsupportedGuide, .decodingFailure:
            return nil
        @unknown default:
            return nil
        }
    }

    /// Logs a failed model operation for diagnostics. Foundation Models errors are logged by case
    /// only — their `Context` can echo prompt fragments, so we never log the error itself and avoid
    /// leaking conversation text into the device logs.
    private static func logFailure(_ operation: String, _ error: Error) {
        if let modelError = error as? LanguageModelSession.GenerationError {
            logger.error("\(operation, privacy: .public) failed: LanguageModelSession.GenerationError.\(diagnosticCase(for: modelError), privacy: .public)")
        } else {
            logger.error("\(operation, privacy: .public) failed: \(String(describing: type(of: error)), privacy: .public)")
        }
    }

    /// A stable, content-free label for a generation error's case, for diagnostic logging.
    private static func diagnosticCase(for error: LanguageModelSession.GenerationError) -> String {
        switch error {
        case .exceededContextWindowSize: return "exceededContextWindowSize"
        case .assetsUnavailable: return "assetsUnavailable"
        case .guardrailViolation: return "guardrailViolation"
        case .unsupportedGuide: return "unsupportedGuide"
        case .unsupportedLanguageOrLocale: return "unsupportedLanguageOrLocale"
        case .decodingFailure: return "decodingFailure"
        case .rateLimited: return "rateLimited"
        case .concurrentRequests: return "concurrentRequests"
        case .refusal: return "refusal"
        @unknown default: return "unknown"
        }
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
