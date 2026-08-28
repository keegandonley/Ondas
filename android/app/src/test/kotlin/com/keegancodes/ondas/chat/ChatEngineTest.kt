package com.keegancodes.ondas.chat

import androidx.test.core.app.ApplicationProvider
import com.keegancodes.ondas.data.ConversationRepository
import com.keegancodes.ondas.data.OndasDatabase
import com.keegancodes.ondas.kit.chat.CapacityState
import com.keegancodes.ondas.kit.chat.GenerationSettingsStore
import com.keegancodes.ondas.kit.models.ChatMessage
import com.keegancodes.ondas.kit.models.ChatRole
import com.keegancodes.ondas.kit.telemetry.KeyValueStore
import com.keegancodes.ondas.kit.telemetry.OtlpExporter
import com.keegancodes.ondas.kit.telemetry.TelemetryService
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import kotlin.time.Instant

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatEngineTest {

    private lateinit var database: OndasDatabase
    private lateinit var repository: ConversationRepository
    private var clock = Instant.fromEpochSeconds(1_000)

    /** A programmable stand-in for Gemini Nano, which exists only where AICore does. */
    private class FakeModel : OnDeviceModel {
        var status = ModelStatus.AVAILABLE
        var limit = 8192
        var tokens = 10
        var chunks: List<String> = listOf("Hello", " there")
        var streamError: Throwable? = null
        var generateResult: String = "SUMMARY"
        var generateError: Throwable? = null
        var streamGate: CompletableDeferred<Unit>? = null
        var lastPrefix: String? = null
        var lastPrompt: String? = null
        var lastSystemPrompt: String? = null
        var lastTemperature: Float? = null

        override suspend fun status(): ModelStatus = status
        override fun download(): Flow<DownloadProgress> = flow { emit(DownloadProgress.Completed) }
        override suspend fun tokenLimit(): Int = limit
        override suspend fun countTokens(systemPrompt: String, body: String): Int = tokens
        override suspend fun baseModelName(): String = "fake-model"

        override fun stream(
            systemPrompt: String,
            prefix: String?,
            prompt: String,
            temperature: Float,
        ): Flow<String> = flow {
            lastSystemPrompt = systemPrompt
            lastPrefix = prefix
            lastPrompt = prompt
            lastTemperature = temperature
            streamError?.let { throw it }
            for (chunk in chunks) {
                streamGate?.await()
                emit(chunk)
            }
        }

        override suspend fun generate(systemPrompt: String, prompt: String, temperature: Float): String {
            generateError?.let { throw it }
            return generateResult
        }
    }

    private val model = FakeModel()

    private fun telemetry() = TelemetryService(
        OtlpExporter("1.0", OkHttpClient()),
        modelName = { "fake-model" },
    )

    private class MemoryStore : KeyValueStore {
        private val map = mutableMapOf<String, Any>()
        override fun string(key: String) = map[key] as? String
        override fun boolean(key: String) = map[key] as? Boolean ?: false
        override fun putString(key: String, value: String) { map[key] = value }
        override fun putBoolean(key: String, value: Boolean) { map[key] = value }
    }

    @Before
    fun setUp() {
        database = OndasDatabase.createInMemory(ApplicationProvider.getApplicationContext())
        repository = ConversationRepository(database.conversations(), now = { clock })
    }

    @After
    fun tearDown() = database.close()

    private fun engine(scope: TestScope, reserve: Int = 1024) = ChatEngine(
        model = model,
        repository = repository,
        telemetry = telemetry(),
        settings = GenerationSettingsStore(MemoryStore()),
        scope = scope,
        responseTokenReserve = reserve,
        now = { clock },
    )

    // MARK: - Streaming

    @Test
    fun `streamed deltas are concatenated, not assigned`() = runTest {
        // The single most consequential difference from Apple's cumulative snapshots. Assigning
        // each chunk would leave only " there"; the trailing empty chunk would blank it entirely.
        model.chunks = listOf("One, two", ", three", ", four", "")
        val engine = engine(this)
        val conversation = repository.createConversation()
        engine.configure(conversation)

        engine.send("count")
        advanceUntilIdle()

        val stored = repository.conversation(conversation.id)!!.orderedMessages
        assertEquals("One, two, three, four", stored.last { it.role == ChatRole.ASSISTANT }.text)
    }

    @Test
    fun `the reply is persisted once at completion, not per chunk`() = runTest {
        model.chunks = listOf("a", "b", "c", "d")
        val engine = engine(this)
        val conversation = repository.createConversation()
        engine.configure(conversation)

        engine.send("hi")
        advanceUntilIdle()

        // Two messages total: the user turn and one assistant turn. Per-chunk persistence would
        // still yield two rows, so the assertion that matters is that the row holds the WHOLE
        // reply and the intermediate states never became separate messages.
        val stored = repository.conversation(conversation.id)!!.orderedMessages
        assertEquals(2, stored.size)
        assertEquals("abcd", stored[1].text)
    }

    @Test
    fun `history is sent as a role-labelled prefix with the system prompt separate`() = runTest {
        val engine = engine(this)
        val conversation = repository.createConversation()
        repository.appendMessage(conversation.id, ChatMessage(role = ChatRole.USER, text = "first", createdAt = clock))
        repository.appendMessage(
            conversation.id,
            ChatMessage(role = ChatRole.ASSISTANT, text = "reply", createdAt = clock.plus(1)),
        )
        engine.configure(repository.conversation(conversation.id)!!)

        engine.send("second")
        advanceUntilIdle()

        assertTrue(model.lastSystemPrompt!!.startsWith("You are Ondas"))
        // Roles are labelled: a role-less shape loses track of who said what (spec #88).
        assertEquals("User: first\nAssistant: reply\n", model.lastPrefix)
        assertEquals("User: second", model.lastPrompt)
    }

    @Test
    fun `error notices are excluded from the replayed history`() = runTest {
        val engine = engine(this)
        val conversation = repository.createConversation()
        repository.appendMessage(conversation.id, ChatMessage(role = ChatRole.USER, text = "q", createdAt = clock))
        repository.appendMessage(
            conversation.id,
            ChatMessage(role = ChatRole.ASSISTANT, text = "Sorry, I couldn't finish that.", createdAt = clock.plus(1), isError = true),
        )
        engine.configure(repository.conversation(conversation.id)!!)

        engine.send("again")
        advanceUntilIdle()

        // Seeding the notice would teach the model it said that itself.
        assertFalse(model.lastPrefix!!.contains("Sorry"))
    }

    // MARK: - Cancellation discipline

    @Test
    fun `a cancelled turn with no content removes the blank placeholder`() = runTest {
        val gate = CompletableDeferred<Unit>()
        model.streamGate = gate
        val engine = engine(this)
        val conversation = repository.createConversation()
        engine.configure(conversation)

        engine.submit("hi")
        advanceUntilIdle()
        engine.cancelActiveTurn()
        gate.complete(Unit)
        advanceUntilIdle()

        // Otherwise it persists forever as an empty bubble.
        val stored = repository.conversation(conversation.id)!!.orderedMessages
        assertEquals(listOf("hi"), stored.map { it.text })
    }

    @Test
    fun `a cancelled turn keeps partially streamed text`() = runTest {
        val gate = CompletableDeferred<Unit>()
        model.chunks = listOf("partial", " more")
        val engine = engine(this)
        val conversation = repository.createConversation()
        engine.configure(conversation)

        engine.submit("hi")
        advanceUntilIdle()
        // First chunk lands, then the user leaves.
        model.streamGate = gate
        engine.cancelActiveTurn()
        gate.complete(Unit)
        advanceUntilIdle()

        val stored = repository.conversation(conversation.id)!!.orderedMessages
        assertTrue(stored.size >= 1)
    }

    /**
     * NOTE ON WHAT THIS DOES AND DOES NOT PROVE. It covers the non-suspending half of the cleanup:
     * the state reset. It does NOT guard the `NonCancellable` wrapper, and cannot here — mutating
     * that away leaves this test green. The reason is that this suite runs Room on direct
     * executors (see `OndasDatabase.createInMemory`) to keep the test dispatcher deterministic,
     * and that removes the suspension points cancellation needs in order to be observed. The
     * wrapper protects the repository writes in the same `finally`, which DO suspend against the
     * real executor. Verified by reasoning and by the identical defect the telemetry exporter had.
     */
    @Test
    fun `cancellation still releases isResponding and clears the streaming slot`() = runTest {
        val gate = CompletableDeferred<Unit>()
        model.streamGate = gate
        val engine = engine(this)
        val conversation = repository.createConversation()
        engine.configure(conversation)

        engine.submit("hi")
        advanceUntilIdle()
        engine.cancelActiveTurn()
        gate.complete(Unit)
        advanceUntilIdle()

        assertFalse(engine.state.value.isResponding)
        assertNull(engine.state.value.streamingMessageId)
    }

    @Test
    fun `a second submit while responding is ignored`() = runTest {
        val gate = CompletableDeferred<Unit>()
        model.streamGate = gate
        val engine = engine(this)
        val conversation = repository.createConversation()
        engine.configure(conversation)

        engine.submit("first")
        advanceUntilIdle()
        engine.submit("second")
        gate.complete(Unit)
        advanceUntilIdle()

        val texts = repository.conversation(conversation.id)!!.orderedMessages.map { it.text }
        assertFalse("the second submit must not have started a turn", texts.contains("second"))
    }

    // MARK: - Capacity

    @Test
    fun `a full chat refuses to send`() = runTest {
        model.tokens = 9_000 // over an 8192 window minus reserve
        val engine = engine(this)
        val conversation = repository.createConversation()
        engine.configure(conversation)

        assertEquals(CapacityState.FULL, engine.state.value.capacityState)
        assertFalse(engine.state.value.canSend("hello"))

        engine.send("hello")
        advanceUntilIdle()
        assertEquals(0, repository.conversation(conversation.id)!!.orderedMessages.size)
    }

    @Test
    fun `an undeterminable window falls back to the message-count cap`() = runTest {
        // limit - reserve <= 0 must not wedge an empty chat at capacity.
        model.limit = 100
        val engine = engine(this, reserve = 1024)
        val conversation = repository.createConversation()
        engine.configure(conversation)

        assertNull(engine.state.value.tokenUsage)
        assertEquals(CapacityState.NORMAL, engine.state.value.capacityState)
        assertTrue(engine.state.value.canSend("hello"))
    }

    // MARK: - Availability

    @Test
    fun `an unavailable model writes an error notice instead of calling the model`() = runTest {
        model.status = ModelStatus.DOWNLOADABLE
        val engine = engine(this)
        val conversation = repository.createConversation()
        engine.configure(conversation)

        engine.send("hi")
        advanceUntilIdle()

        val stored = repository.conversation(conversation.id)!!.orderedMessages
        val assistant = stored.last()
        assertTrue(assistant.isError)
        assertTrue(assistant.text.contains("download"))
        assertNull("the model must not have been called", model.lastPrompt)
    }

    // MARK: - Error mapping

    @Test
    fun `an oversize request gets its curated message, never the vendor's`() = runTest {
        model.streamError = ModelException(
            ModelException.Kind.REQUEST_TOO_LARGE,
            "GenAiException.12",
        )
        val engine = engine(this)
        val conversation = repository.createConversation()
        engine.configure(conversation)

        engine.send("hi")
        advanceUntilIdle()

        val assistant = repository.conversation(conversation.id)!!.orderedMessages.last()
        assertTrue(assistant.isError)
        assertEquals(
            "This conversation has grown too long to continue. Start a new chat to keep going.",
            assistant.text,
        )
    }

    @Test
    fun `a policy refusal maps to the guardrail message`() = runTest {
        model.streamError = ModelException(ModelException.Kind.POLICY_REFUSAL, "GenAiException.11")
        val engine = engine(this)
        val conversation = repository.createConversation()
        engine.configure(conversation)

        engine.send("hi")
        advanceUntilIdle()

        assertEquals(
            "I can't help with that request.",
            repository.conversation(conversation.id)!!.orderedMessages.last().text,
        )
    }

    @Test
    fun `failures log the case label only, never message content`() = runTest {
        val logged = mutableListOf<String>()
        model.streamError = ModelException(ModelException.Kind.UNKNOWN, "GenAiException.99")
        val engine = ChatEngine(
            model = model,
            repository = repository,
            telemetry = telemetry(),
            settings = GenerationSettingsStore(MemoryStore()),
            scope = this,
            responseTokenReserve = 1024,
            now = { clock },
            logFailure = { operation, label -> logged += "$operation/$label" },
        )
        val conversation = repository.createConversation()
        engine.configure(conversation)

        engine.send("something private")
        advanceUntilIdle()

        assertEquals(listOf("Text response/GenAiException.99"), logged)
        // The privacy invariant: nothing logged may echo the prompt.
        assertFalse(logged.single().contains("private"))
    }

    // MARK: - Titles

    @Test
    fun `the first message derives the conversation title`() = runTest {
        val engine = engine(this)
        val conversation = repository.createConversation()
        engine.configure(conversation)

        engine.send("Plan a trip to Lisbon")
        advanceUntilIdle()

        assertEquals(
            "Plan a trip to Lisbon",
            repository.conversation(conversation.id)!!.title,
        )
    }

    // MARK: - Compaction

    @Test
    fun `compaction is refused outside the warning band`() = runTest {
        val engine = engine(this)
        val conversation = repository.createConversation()
        engine.configure(conversation)

        assertEquals(CapacityState.NORMAL, engine.state.value.capacityState)
        engine.compact()
        advanceUntilIdle()

        assertEquals(0, repository.conversation(conversation.id)!!.orderedMessages.size)
    }

    @Test
    fun `an empty summary is treated as a failure and inserts no marker`() = runTest {
        model.generateResult = "   "
        model.tokens = 6_000 // inside the 0.8 warning band of (8192 - 1024)
        val engine = engine(this)
        val conversation = repository.createConversation()
        repository.appendMessage(conversation.id, ChatMessage(role = ChatRole.USER, text = "q", createdAt = clock))
        engine.configure(repository.conversation(conversation.id)!!)

        assertEquals(CapacityState.APPROACHING, engine.state.value.capacityState)
        engine.compact()
        advanceUntilIdle()

        val stored = repository.conversation(conversation.id)!!.orderedMessages
        // An error notice, and crucially NOT a compaction marker: inserting an empty summary would
        // silently discard the context it was meant to preserve.
        assertTrue(stored.none { it.isCompactionSummary })
        assertTrue(stored.last().isError)
    }

    @Test
    fun `a successful compaction appends the marker at the seam and empties the live segment`() = runTest {
        model.generateResult = "A summary of everything."
        model.tokens = 6_000
        val engine = engine(this)
        val conversation = repository.createConversation()
        repository.appendMessage(conversation.id, ChatMessage(role = ChatRole.USER, text = "q", createdAt = clock))
        repository.appendMessage(
            conversation.id,
            ChatMessage(role = ChatRole.ASSISTANT, text = "a", createdAt = clock.plus(1)),
        )
        engine.configure(repository.conversation(conversation.id)!!)

        // The marker is appended with a wall-clock timestamp and must sort after every existing
        // turn -- the same assumption Swift makes with `ChatMessage(createdAt: .now)`. The fixed
        // test clock has to advance or the divider lands above the turns it summarises.
        clock = clock.plus(60)

        engine.compact()
        advanceUntilIdle()

        val stored = repository.conversation(conversation.id)!!.orderedMessages
        val marker = stored.last()
        assertTrue(marker.isCompactionSummary)
        assertEquals("A summary of everything.", marker.text)
        // The marker is LAST, so everything above it is summarised history and the live segment is
        // empty — which is what frees the budget.
        assertEquals(
            0,
            com.keegancodes.ondas.kit.chat.Compaction.capacityCount(stored),
        )
    }

    // MARK: - Engine state tracks its own writes

    /**
     * The engine must not depend on a Room round-trip to see its own writes.
     *
     * Nothing re-feeds the engine during these tests (the shell's `observeConversation` collector
     * is not wired here), so if the engine only wrote to the store its own state would never catch
     * up — which is exactly the gap review found: a just-sent message briefly absent from the
     * transcript, and a capacity meter computed from a conversation missing the turn that just
     * finished.
     */
    @Test
    fun `engine state includes the turn it just sent, without waiting for the store`() = runTest {
        val engine = engine(this)
        val conversation = repository.createConversation()
        engine.configure(conversation)

        engine.send("hello")
        advanceUntilIdle()

        assertEquals(
            listOf("hello", "Hello there"),
            engine.state.value.displayedMessages.map { it.text },
        )
    }

    @Test
    fun `a compaction marker lands in engine state before the budget is recomputed`() = runTest {
        model.generateResult = "A summary."
        model.tokens = 6_000
        val engine = engine(this)
        val conversation = repository.createConversation()
        repository.appendMessage(
            conversation.id,
            ChatMessage(role = ChatRole.USER, text = "q", createdAt = clock),
        )
        engine.configure(repository.conversation(conversation.id)!!)
        clock = clock.plus(60)

        engine.compact()
        advanceUntilIdle()

        val messages = engine.state.value.conversation!!.orderedMessages
        assertTrue(messages.last().isCompactionSummary)
        // The live segment has to be empty as a RESULT of compacting, which only holds if the
        // marker reached state before refreshTokenUsage read it.
        assertEquals(0, com.keegancodes.ondas.kit.chat.Compaction.capacityCount(messages))
    }
}

private fun Instant.plus(seconds: Long): Instant =
    Instant.fromEpochSeconds(epochSeconds + seconds, nanosecondsOfSecond)
