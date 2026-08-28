package com.keegancodes.ondas.chat

import com.keegancodes.ondas.data.ConversationRepository
import com.keegancodes.ondas.kit.chat.CapacityState
import com.keegancodes.ondas.kit.chat.Compaction
import com.keegancodes.ondas.kit.chat.ConversationTitle
import com.keegancodes.ondas.kit.chat.GenerationSettingsStore
import com.keegancodes.ondas.kit.chat.TokenUsage
import com.keegancodes.ondas.kit.chat.TurnSignal
import com.keegancodes.ondas.kit.models.ChatMessage
import com.keegancodes.ondas.kit.models.ChatRole
import com.keegancodes.ondas.kit.models.Conversation
import com.keegancodes.ondas.kit.telemetry.TelemetryService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID
import kotlin.coroutines.coroutineContext
import kotlin.time.Clock
import kotlin.time.Instant

/**
 * Everything the chat screen observes.
 *
 * One immutable snapshot rather than several observable properties: the derived questions below are
 * answered from more than one field at once, and a Compose reader subscribed to only some of them
 * would answer from a mix of old and new.
 */
public data class ChatEngineState(
    val conversation: Conversation? = null,
    val isResponding: Boolean = false,
    val isCompacting: Boolean = false,
    val availabilityMessage: String? = null,
    /**
     * The model's own status, carried alongside the message.
     *
     * The UI needs to know specifically that the model is DOWNLOADABLE, so it can offer to fetch
     * it — a state iOS has no counterpart for. Exposing only [availabilityMessage] forced the
     * download button to string-match that message, which meant rewording a user-facing string
     * would silently remove the button from exactly the devices that need it: every fresh Pixel.
     * Flagged during the spec #93 port; a state field is the fix.
     */
    val modelStatus: ModelStatus? = null,
    val downloadProgress: DownloadProgress? = null,
    val tokenUsage: TokenUsage? = null,
    val lastTurn: TurnSignal? = null,
    /**
     * The reply being streamed, held in memory rather than written to the store per chunk.
     * Swift makes the same split — `@Observable` mutation drives the UI and the turn is persisted
     * once at completion, because saving per token would mean a database write per few characters.
     */
    val streamingMessageId: UUID? = null,
    val streamingText: String = "",
) {
    /**
     * Prefers the real token budget; falls back to the message-count cap only when a count is
     * unavailable (failed or undeterminable).
     */
    public val capacityState: CapacityState
        get() {
            val usage = tokenUsage
            return when {
                usage == null -> conversation?.capacityState ?: CapacityState.NORMAL
                usage.isAtCapacity -> CapacityState.FULL
                usage.isApproachingCapacity -> CapacityState.APPROACHING
                else -> CapacityState.NORMAL
            }
        }

    public fun canSend(draft: String): Boolean =
        draft.isNotBlank() &&
            !isResponding &&
            !isCompacting &&
            availabilityMessage == null &&
            capacityState != CapacityState.FULL

    /** A full chat takes no more input, and input is frozen while a compaction rebuilds context. */
    public val isComposerDisabled: Boolean
        get() = capacityState == CapacityState.FULL || isCompacting

    /** The message list with the in-flight streamed text applied, which is what the UI renders. */
    public val displayedMessages: List<ChatMessage>
        get() {
            val ordered = conversation?.orderedMessages ?: return emptyList()
            val streamingId = streamingMessageId ?: return ordered
            return ordered.map { if (it.id == streamingId) it.copy(text = streamingText) else it }
        }
}

/**
 * Drives one conversation: sends user messages to the on-device model and persists both sides.
 *
 * ## What is different from Swift, and why
 *
 * Swift holds a `LanguageModelSession` that carries the conversation's context and is rebuilt on a
 * thread switch. There is no such object here, so history is reassembled into every request (see
 * [ChatPrompt]). Everything that hangs off session identity in Swift hangs off [sessionGeneration]
 * instead — including the guard that stops a slow token count from a conversation the user has
 * left committing over the one they are now looking at.
 *
 * The turn-cancellation machinery is ported rather than reinvented. Each guard in it corresponds
 * to a bug that was actually hit: a streamed reply writing into a deleted conversation, a second
 * submit racing into the pre-`isResponding` window and making the live turn uncancellable, an
 * error message overwriting an abandoned message's partial text, and a blank placeholder
 * persisting forever because cancellation skipped its cleanup.
 */
public class ChatEngine(
    private val model: OnDeviceModel,
    private val repository: ConversationRepository,
    private val telemetry: TelemetryService,
    private val settings: GenerationSettingsStore,
    private val scope: CoroutineScope,
    /**
     * Tokens held back from the context window for the model's reply.
     *
     * **No default, on purpose.** Swift's 1024 was tuned against a ~4096-token window; Nano's is
     * 8192, so the number does not carry over. Keegan's decision (PORTING.md § A1) is to derive it
     * from the compaction summariser's measured headroom rather than inherit or rescale it, and
     * until that measurement exists an unmeasured value must not be able to ship quietly.
     */
    private val responseTokenReserve: Int,
    private val now: () -> Instant = { Clock.System.now() },
    private val logFailure: (String, String) -> Unit = { _, _ -> },
) {
    private val _state = MutableStateFlow(ChatEngineState())
    public val state: StateFlow<ChatEngineState> = _state.asStateFlow()

    private var conversationId: UUID? = null

    /**
     * Stands in for Swift's `session` object identity.
     *
     * Swift guards slow work with `self.session === session`, because the engine is reused across
     * conversations and a count that started on one thread must not commit onto another. With no
     * session object the same guard is a monotonic counter, bumped whenever the engine is pointed
     * somewhere new.
     */
    private var sessionGeneration = 0

    private var compactionGeneration = 0
    private var turnCounter = 0
    private var activeTurn: Job? = null

    /** Points the engine at a conversation. Safe to call repeatedly with the same one. */
    public suspend fun configure(conversation: Conversation) {
        if (conversationId != conversation.id) {
            // Abandon any turn still streaming into the previous conversation before switching.
            cancelActiveTurn()
            conversationId = conversation.id
            sessionGeneration++
            // Clear the compaction flag so a cancelled compaction on the previous thread cannot
            // leave the newly-opened one transiently showing "Compacting…".
            _state.update {
                it.copy(
                    conversation = conversation,
                    isCompacting = false,
                    streamingMessageId = null,
                    streamingText = "",
                )
            }
        } else {
            _state.update { it.copy(conversation = conversation) }
        }
        refreshAvailability()
        refreshTokenUsage()
    }

    /**
     * Applies a write to the in-memory conversation immediately, rather than waiting for the store
     * to emit it back.
     *
     * Without this the engine's own state trails its own writes by a Room round-trip, and two
     * things go wrong that a reader would struggle to attribute: a just-sent message can be
     * briefly absent from the transcript while the composer has already cleared, and
     * [refreshTokenUsage] — which reads this state synchronously on its first line — can compute
     * the capacity meter from a conversation missing the turn that just completed, leaving a stale
     * "approaching capacity" reading with nothing scheduled to re-check it.
     *
     * The store remains the source of truth; [onConversationChanged] reconciles when it emits.
     */
    private fun applyLocally(message: ChatMessage) {
        _state.update { current ->
            val conversation = current.conversation ?: return@update current
            val existing = conversation.messages.indexOfFirst { it.id == message.id }
            val messages = if (existing >= 0) {
                conversation.messages.toMutableList().apply { this[existing] = message }
            } else {
                conversation.messages + message
            }
            current.copy(conversation = conversation.copy(messages = messages))
        }
    }

    private fun removeLocally(messageId: UUID) {
        _state.update { current ->
            val conversation = current.conversation ?: return@update current
            current.copy(
                conversation = conversation.copy(
                    messages = conversation.messages.filterNot { it.id == messageId },
                ),
            )
        }
    }

    /** Called when the store emits a new version of the conversation being displayed. */
    public fun onConversationChanged(conversation: Conversation) {
        if (conversation.id != conversationId) return
        _state.update { it.copy(conversation = conversation) }
    }

    /**
     * Recomputes the availability banner. Called on configure, on each send, on each compaction
     * and when the app returns to the foreground, so the banner clears once a download finishes.
     */
    public suspend fun refreshAvailability() {
        val status = runCatching { model.status() }.getOrElse { ModelStatus.UNAVAILABLE }
        _state.update {
            it.copy(modelStatus = status, availabilityMessage = availabilityMessage(status))
        }
    }

    /**
     * Drives the model download. No Swift counterpart: on iOS the model is either present or it is
     * not, whereas a fresh Pixel reports DOWNLOADABLE and the app must fetch Nano before the first
     * message can be sent (spec #88).
     */
    public fun startDownload() {
        scope.launch {
            model.download().collect { progress ->
                _state.update { it.copy(downloadProgress = progress) }
            }
            refreshAvailability()
            _state.update { it.copy(downloadProgress = null) }
        }
    }

    /**
     * Starts a turn as a tracked job so it can be cancelled when the user leaves.
     *
     * The composer disables itself while `isResponding`, but that flag only flips once the job body
     * runs — a second submit racing into that window would otherwise replace [activeTurn] and leave
     * the real in-flight turn uncancellable. Guard the flag and cancel any not-yet-run predecessor
     * so the handle always points at the one live turn.
     */
    public fun submit(raw: String) {
        val current = _state.value
        if (current.isResponding || current.isCompacting) return
        cancelActiveTurn()
        activeTurn = scope.launch { send(raw) }
    }

    /** Cancels the in-flight turn or compaction (they share the handle). */
    public fun cancelActiveTurn() {
        activeTurn?.cancel()
        activeTurn = null
    }

    public suspend fun send(raw: String) {
        val conversation = _state.value.conversation ?: return
        val text = raw.trim()
        // A full chat is closed to new turns; the UI reflects it, but guard defensively so a late
        // send cannot push past the cap. A turn cancelled before it ever ran must not touch the
        // store at all.
        if (text.isEmpty() ||
            _state.value.isResponding ||
            _state.value.capacityState == CapacityState.FULL ||
            !coroutineContext.isActive
        ) {
            return
        }

        val generation = sessionGeneration
        val wasEmpty = !conversation.hasMessages
        val timestamp = now()

        val userMessage = ChatMessage(role = ChatRole.USER, text = text, createdAt = timestamp)
        applyLocally(userMessage)
        repository.appendMessage(conversation.id, userMessage)
        if (wasEmpty) {
            repository.rename(conversation.id, ConversationTitle.derive(text))
        }

        // The placeholder the UI shows a "thinking" indicator in. Nudged 1ms later so it always
        // sorts after the user message — see the nanosecond storage note in Converters.
        val assistant = ChatMessage(
            role = ChatRole.ASSISTANT,
            text = "",
            createdAt = timestamp.plusMillis(1),
        )
        applyLocally(assistant)
        repository.appendMessage(conversation.id, assistant)

        _state.update {
            it.copy(isResponding = true, streamingMessageId = assistant.id, streamingText = "")
        }

        var finalText = ""
        var failed = false
        var completed = false
        try {
            refreshAvailability()
            val availability = _state.value.availabilityMessage
            if (availability != null) {
                finalText = availability
                failed = true
                completed = true
                repository.updateMessage(
                    conversation.id,
                    assistant.copy(text = availability, isError = true),
                )
                return
            }

            val priorTokenCount = _state.value.tokenUsage?.used
            val turnStart = now()

            val history = ChatPrompt.history(
                Compaction.liveMessages(conversation.orderedMessages),
            )
            val instructions = ChatPrompt.instructions(
                Compaction.activeSummary(conversation.orderedMessages),
            )

            val outcome = respond(instructions, history, text, assistant)
            finalText = outcome.text
            failed = outcome.failed
            completed = true
            val turnEnd = now()

            applyLocally(assistant.copy(text = finalText, isError = failed))
            repository.updateMessage(
                conversation.id,
                assistant.copy(text = finalText, isError = failed),
            )

            _state.update { it.copy(isResponding = false) }
            if (!coroutineContext.isActive) return

            refreshTokenUsage()
            turnCounter += 1
            _state.update { it.copy(lastTurn = TurnSignal(turnCounter, failed)) }

            if (!failed && generation == sessionGeneration) {
                val currentTokenCount = _state.value.tokenUsage?.used
                scope.launch {
                    recordTelemetry(
                        conversationId = conversation.id,
                        userText = text,
                        assistantText = finalText,
                        priorTokenCount = priorTokenCount,
                        currentTokenCount = currentTokenCount,
                        start = turnStart,
                        end = turnEnd,
                    )
                }
            }
        } finally {
            // NonCancellable because this is the analogue of Swift's `defer`, which is a plain
            // synchronous block that cancellation cannot skip. Every call in here suspends, so
            // without it a cancelled turn would leave `isResponding` stuck true and the composer
            // disabled forever. (Same rule as the telemetry exporter's flush flag.)
            withContext(NonCancellable) {
                _state.update {
                    it.copy(isResponding = false, streamingMessageId = null, streamingText = "")
                }
                if (!completed) {
                    // Abandoned: view gone, thread switched, or the conversation deleted. Don't
                    // bump updatedAt — but if no content ever arrived, remove the placeholder or it
                    // persists forever as a blank bubble. A partial streamed reply is KEPT.
                    val partial = _state.value.streamingText
                    if (partial.isEmpty()) {
                        removeLocally(assistant.id)
                        repository.deleteMessage(assistant.id)
                    } else {
                        applyLocally(assistant.copy(text = partial))
                        repository.updateMessage(conversation.id, assistant.copy(text = partial))
                    }
                } else {
                    repository.touch(conversation.id)
                }
            }
        }
    }

    private data class TurnOutcome(val text: String, val failed: Boolean)

    /**
     * Streams a reply, concatenating deltas.
     *
     * Swift assigns `snapshot.content` directly because Apple's snapshots are CUMULATIVE. ML Kit
     * emits deltas — verified on device in spec #88, where a reply arrived as "One, two" /
     * ", three, four, five" / ", six, seven, eight" / "". Assigning instead of appending here would
     * truncate every reply to its last fragment, and the trailing empty chunk would blank it.
     */
    private suspend fun respond(
        instructions: String,
        history: String?,
        text: String,
        assistant: ChatMessage,
    ): TurnOutcome {
        val temperature = settings.load().temperature
        val builder = StringBuilder()
        return try {
            model.stream(instructions, history, ChatPrompt.userTurn(text), temperature)
                .collect { delta ->
                    if (!coroutineContext.isActive) return@collect
                    builder.append(delta)
                    _state.update {
                        if (it.streamingMessageId == assistant.id) {
                            it.copy(streamingText = builder.toString())
                        } else {
                            it
                        }
                    }
                }
            TurnOutcome(builder.toString(), failed = false)
        } catch (error: Exception) {
            // Cancellation usually surfaces here as a thrown CancellationException rather than the
            // loop's isActive check — don't overwrite an abandoned message's partial text with an
            // error it never had.
            if (!coroutineContext.isActive) throw error
            logDiagnostic("Text response", error)
            TurnOutcome(friendlyMessage(error), failed = true)
        }
    }

    /**
     * Compacts in place: summarises the live turns, appends a divider, and continues under the same
     * conversation id so the telemetry session stays continuous.
     *
     * Offered only from the warning band. `.full` is deliberately past the point of compaction —
     * the summariser would overflow the same window — and `.normal` has nothing worth condensing.
     */
    public fun compact() {
        val current = _state.value
        if (current.isResponding || current.isCompacting) return
        if (current.capacityState != CapacityState.APPROACHING) return
        cancelActiveTurn()
        activeTurn = scope.launch { performCompaction() }
    }

    private suspend fun performCompaction() {
        val conversation = _state.value.conversation ?: return
        if (!coroutineContext.isActive) return
        val generation = sessionGeneration

        refreshAvailability()
        _state.value.availabilityMessage?.let { message ->
            insertErrorNotice(conversation.id, message)
            return
        }

        val ordered = conversation.orderedMessages
        val toSummarize = Compaction.liveMessages(ordered)
        // Nothing to condense — guard rather than insert an empty divider.
        if (toSummarize.isEmpty()) return
        val previousSummary = Compaction.activeSummary(ordered)

        compactionGeneration += 1
        val compaction = compactionGeneration
        _state.update { it.copy(isCompacting = true) }

        try {
            val start = now()
            val summary = try {
                model.generate(
                    ChatPrompt.SUMMARY_INSTRUCTIONS,
                    ChatPrompt.summarizerPrompt(previousSummary, toSummarize),
                    ResponseStyleForSummary,
                ).trim()
            } catch (error: Exception) {
                if (!coroutineContext.isActive) throw error
                logDiagnostic("Compaction summary", error)
                insertErrorNotice(conversation.id, friendlyMessage(error))
                return
            }
            val end = now()

            if (!coroutineContext.isActive) return
            // The conversation the summary belongs to may no longer be the one on screen.
            if (generation != sessionGeneration) return
            // An empty summary would silently discard the compacted context — treat it as a
            // failure so the user can retry rather than losing the history.
            if (summary.isEmpty()) {
                insertErrorNotice(conversation.id, EMPTY_SUMMARY_MESSAGE)
                return
            }

            // Appended at the END, so the divider renders at the seam and the message-insertion
            // auto-scroll brings it into view. Everything above it is summarised history.
            val marker = ChatMessage(
                role = ChatRole.ASSISTANT,
                text = summary,
                createdAt = now(),
                isCompactionSummary = true,
            )
            // Applied locally FIRST: refreshTokenUsage below reads the in-memory conversation, and
            // the whole point of a compaction is that the budget drops immediately.
            applyLocally(marker)
            repository.appendMessage(conversation.id, marker)
            refreshTokenUsage()

            scope.launch {
                recordCompactionTelemetry(conversation.id, summary, start, end)
            }
        } finally {
            // Only clear the flag if this is still the current compaction — a superseded task
            // unwinding late must not re-enable the controls under a newer one. NonCancellable for
            // the same reason as the send path.
            withContext(NonCancellable) {
                if (compaction == compactionGeneration) {
                    _state.update { it.copy(isCompacting = false) }
                }
            }
        }
    }

    /**
     * Recomputes the token budget.
     *
     * If the count throws, or the window is no larger than the reply reserve, the usage is cleared
     * and capacity falls back to the message-count cap rather than wedging an empty chat at
     * capacity.
     */
    public suspend fun refreshTokenUsage() {
        val conversation = _state.value.conversation ?: return
        val generation = sessionGeneration
        val ordered = conversation.orderedMessages
        val instructions = ChatPrompt.instructions(Compaction.activeSummary(ordered))
        val body = ChatPrompt.history(Compaction.liveMessages(ordered)).orEmpty()

        val usage = try {
            val limit = model.tokenLimit() - responseTokenReserve
            if (limit <= 0) {
                null
            } else {
                TokenUsage(used = model.countTokens(instructions, body), limit = limit)
            }
        } catch (error: Exception) {
            if (!coroutineContext.isActive) throw error
            null
        }

        // The engine is reused across conversations, so a thread switch may have happened while
        // this count was in flight. Only commit if it is still the conversation we counted, or a
        // stale count could lock out the chat now on screen.
        if (generation != sessionGeneration) return
        _state.update { it.copy(tokenUsage = usage) }
    }

    private suspend fun insertErrorNotice(conversationId: UUID, text: String) {
        val notice = ChatMessage(
            role = ChatRole.ASSISTANT,
            text = text,
            createdAt = now(),
            isError = true,
        )
        applyLocally(notice)
        repository.appendMessage(conversationId, notice)
    }

    private suspend fun recordTelemetry(
        conversationId: UUID,
        userText: String,
        assistantText: String,
        priorTokenCount: Int?,
        currentTokenCount: Int?,
        start: Instant,
        end: Instant,
    ) {
        if (!telemetry.isDeliverable()) return
        var inputTokens = 0
        var outputTokens = 0
        // This turn's MARGINAL tokens: completion is the reply, prompt is the growth in context
        // since the previous turn minus the reply. Keeps llm.token_count.prompt a per-call figure
        // comparable to the cache-aware sources coding-stats already ingests, rather than the whole
        // ever-growing context.
        if (currentTokenCount != null) {
            outputTokens = runCatching { model.countTokens("", assistantText) }.getOrDefault(0)
            val addedThisTurn = maxOf(0, currentTokenCount - (priorTokenCount ?: 0))
            inputTokens = maxOf(0, addedThisTurn - outputTokens)
        }
        telemetry.recordLLM(
            conversationId = conversationId,
            feature = "chat",
            prompt = userText,
            completion = assistantText,
            inputTokens = inputTokens,
            outputTokens = outputTokens,
            start = start,
            end = end,
        )
    }

    private suspend fun recordCompactionTelemetry(
        conversationId: UUID,
        summary: String,
        start: Instant,
        end: Instant,
    ) {
        if (!telemetry.isDeliverable()) return
        val outputTokens = runCatching { model.countTokens("", summary) }.getOrDefault(0)
        telemetry.recordLLM(
            conversationId = conversationId,
            feature = "compaction",
            prompt = "",
            completion = summary,
            inputTokens = 0,
            outputTokens = outputTokens,
            start = start,
            end = end,
        )
    }

    /**
     * Curated, user-facing text for a model failure.
     *
     * The vendor's own messages are never surfaced — ML Kit's are developer-facing in exactly the
     * way Apple's are ("Input text length exceeds the limit. Please check the countTokens API",
     * which is also circular advice, since countTokens throws on the same oversize input).
     */
    private fun friendlyMessage(error: Throwable): String {
        val kind = (error as? ModelException)?.kind ?: return GENERIC_FAILURE
        return when (kind) {
            ModelException.Kind.REQUEST_TOO_LARGE ->
                "This conversation has grown too long to continue. Start a new chat to keep going."
            ModelException.Kind.POLICY_REFUSAL ->
                "I can't help with that request."
            ModelException.Kind.BUSY ->
                "I'm still finishing the last response. Try again in a moment."
            ModelException.Kind.NOT_AVAILABLE ->
                "The on-device model is still getting ready. Try again shortly."
            ModelException.Kind.BACKGROUND_BLOCKED ->
                "Ondas can only use the on-device model while it's on screen. Reopen the app and try again."
            ModelException.Kind.QUOTA_EXCEEDED ->
                "Too many requests right now. Wait a moment and try again."
            ModelException.Kind.NEEDS_SYSTEM_UPDATE ->
                "A system update is needed before the on-device model can run."
            ModelException.Kind.NOT_ENOUGH_DISK_SPACE ->
                "There isn't enough free space to run the on-device model."
            ModelException.Kind.UNKNOWN -> GENERIC_FAILURE
        }
    }

    private fun availabilityMessage(status: ModelStatus): String? = when (status) {
        ModelStatus.AVAILABLE -> null
        ModelStatus.DOWNLOADABLE ->
            MODEL_DOWNLOADABLE_MESSAGE
        ModelStatus.DOWNLOADING ->
            "The on-device model is still downloading. Try again shortly."
        ModelStatus.UNAVAILABLE ->
            "This device doesn't support on-device AI, so chat isn't available."
    }

    /**
     * Logs a failure by CASE LABEL ONLY.
     *
     * The privacy invariant ported from Swift: a model error's context can echo prompt fragments,
     * so logging the error itself would leak conversation text into the device log.
     */
    private fun logDiagnostic(operation: String, error: Throwable) {
        val label = (error as? ModelException)?.diagnosticLabel ?: error.javaClass.simpleName
        logFailure(operation, label)
    }

    public companion object {
        /**
         * The banner copy for a device that has no model yet.
         *
         * Public and referenced rather than re-typed in the UI: it was independently duplicated in
         * ChatScreen, coupled only by a test. The download button no longer keys off this string
         * (it uses [ChatEngineState.modelStatus]), but two copies of user-facing copy still drift.
         */
        public const val MODEL_DOWNLOADABLE_MESSAGE: String =
            "Ondas needs to download the on-device model before you can chat."

        const val GENERIC_FAILURE = "Sorry, I couldn't finish that. Please try again."
        const val EMPTY_SUMMARY_MESSAGE =
            "I couldn't summarize this conversation. Try again, or start a new chat."

        /** Summarisation wants determinism, not variety, regardless of the user's chat style. */
        const val ResponseStyleForSummary = 0.3f
    }
}

private fun Instant.plusMillis(millis: Long): Instant =
    Instant.fromEpochSeconds(epochSeconds, nanosecondsOfSecond + millis * 1_000_000L)
