package com.keegancodes.ondas.data

import androidx.test.core.app.ApplicationProvider
import com.keegancodes.ondas.kit.models.ChatMessage
import com.keegancodes.ondas.kit.models.ChatRole
import com.keegancodes.ondas.kit.models.Conversation
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.UUID
import kotlin.time.Instant

@RunWith(RobolectricTestRunner::class)
class ConversationRepositoryTest {

    private lateinit var database: OndasDatabase
    private lateinit var repository: ConversationRepository
    private var clock: Instant = Instant.fromEpochSeconds(1_000)

    @Before
    fun setUp() {
        database = OndasDatabase.createInMemory(ApplicationProvider.getApplicationContext())
        repository = ConversationRepository(database.conversations(), now = { clock })
    }

    @After
    fun tearDown() {
        database.close()
    }

    private fun message(role: ChatRole, text: String, at: Instant, isError: Boolean = false) =
        ChatMessage(role = role, text = text, createdAt = at, isError = isError)

    @Test
    fun `conversations are observed newest activity first`() = runTest {
        val older = repository.createConversation()
        clock = Instant.fromEpochSeconds(2_000)
        val newer = repository.createConversation()

        val listed = repository.observeConversations().first()
        assertEquals(listOf(newer.id, older.id), listed.map { it.id })
    }

    @Test
    fun `appending a message bumps updatedAt so the list re-sorts`() = runTest {
        val first = repository.createConversation()
        clock = Instant.fromEpochSeconds(2_000)
        val second = repository.createConversation()

        // The older conversation gets new activity; it must move to the front.
        repository.appendMessage(
            first.id,
            message(ChatRole.USER, "hello", Instant.fromEpochSeconds(3_000)),
        )

        val listed = repository.observeConversations().first()
        assertEquals(listOf(first.id, second.id), listed.map { it.id })
    }

    @Test
    fun `deleting a conversation cascades to its messages`() = runTest {
        val conversation = repository.createConversation()
        repository.appendMessage(
            conversation.id,
            message(ChatRole.USER, "hi", Instant.fromEpochSeconds(1_001)),
        )
        assertEquals(1, database.conversations().messageCount(conversation.id.toString()))

        repository.deleteConversation(conversation.id)

        assertNull(repository.conversation(conversation.id))
        // The point of the test: the CASCADE is enforced by SQLite, and SQLite has foreign keys
        // OFF by default. Without the PRAGMA in OndasDatabase these rows survive as orphans.
        assertEquals(0, database.conversations().messageCount(conversation.id.toString()))
    }

    @Test
    fun `reuseEmptyOrCreate returns the existing empty thread instead of adding another`() = runTest {
        val first = repository.reuseEmptyOrCreate()
        val second = repository.reuseEmptyOrCreate()

        assertEquals(first.id, second.id)
        assertEquals(1, repository.observeConversations().first().size)
    }

    @Test
    fun `reuseEmptyOrCreate creates a new thread once the existing one has messages`() = runTest {
        val first = repository.reuseEmptyOrCreate()
        repository.appendMessage(
            first.id,
            message(ChatRole.USER, "hi", Instant.fromEpochSeconds(1_001)),
        )

        val second = repository.reuseEmptyOrCreate()

        assertNotEquals(first.id, second.id)
        assertEquals(2, repository.observeConversations().first().size)
    }

    @Test
    fun `a sub-millisecond placeholder offset survives the round trip and keeps turn order`() = runTest {
        // ChatEngine inserts the assistant placeholder at user.createdAt + 0.001s so the pair sorts
        // deterministically. Stored at millisecond resolution that offset is one tick and any
        // rounding collapses the two into the same instant, making order depend on insertion.
        val conversation = repository.createConversation()
        val userAt = Instant.fromEpochSeconds(5_000, 500_000)
        val assistantAt = Instant.fromEpochSeconds(5_000, 1_500_000) // +0.001s

        repository.appendMessage(conversation.id, message(ChatRole.USER, "q", userAt))
        repository.appendMessage(conversation.id, message(ChatRole.ASSISTANT, "a", assistantAt))

        val stored = repository.conversation(conversation.id)!!.orderedMessages
        assertEquals(listOf("q", "a"), stored.map { it.text })
        assertEquals(userAt, stored[0].createdAt)
        assertEquals(assistantAt, stored[1].createdAt)
        assertTrue(stored[1].createdAt > stored[0].createdAt)
    }

    @Test
    fun `messages round trip with their flags and roles intact`() = runTest {
        val conversation = repository.createConversation()
        repository.appendMessage(
            conversation.id,
            message(ChatRole.USER, "q", Instant.fromEpochSeconds(1_001)),
        )
        repository.appendMessage(
            conversation.id,
            message(ChatRole.ASSISTANT, "oops", Instant.fromEpochSeconds(1_002), isError = true),
        )
        repository.appendMessage(
            conversation.id,
            ChatMessage(
                role = ChatRole.ASSISTANT,
                text = "SUMMARY",
                createdAt = Instant.fromEpochSeconds(1_003),
                isCompactionSummary = true,
            ),
        )

        val stored = repository.conversation(conversation.id)!!.orderedMessages
        assertEquals(3, stored.size)
        assertEquals(ChatRole.USER, stored[0].role)
        assertTrue(stored[1].isError)
        assertTrue(stored[2].isCompactionSummary)
        // And the domain helpers still see through to the right answers.
        assertEquals("SUMMARY", com.keegancodes.ondas.kit.chat.Compaction.activeSummary(stored))
        assertEquals(0, com.keegancodes.ondas.kit.chat.Compaction.capacityCount(stored))
    }

    @Test
    fun `streaming updates rewrite the assistant turn in place`() = runTest {
        val conversation = repository.createConversation()
        val placeholder = ChatMessage(
            id = UUID.randomUUID(),
            role = ChatRole.ASSISTANT,
            text = "",
            createdAt = Instant.fromEpochSeconds(2_001),
        )
        repository.appendMessage(conversation.id, placeholder)
        repository.updateMessage(conversation.id, placeholder.copy(text = "streamed reply"))

        val stored = repository.conversation(conversation.id)!!.orderedMessages
        assertEquals(1, stored.size)
        assertEquals("streamed reply", stored.single().text)
    }

    @Test
    fun `a failed write logs instead of throwing`() = runTest {
        val failures = mutableListOf<String>()
        val repo = ConversationRepository(
            database.conversations(),
            now = { clock },
            logError = { message, _ -> failures += message },
        )
        // A message whose conversation does not exist violates the foreign key.
        repo.appendMessage(
            UUID.randomUUID(),
            message(ChatRole.USER, "orphan", Instant.fromEpochSeconds(1_001)),
        )
        assertEquals(1, failures.size)
        assertTrue(failures.single().startsWith("Persistence failed: append message"))
    }
}
