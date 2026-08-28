package com.keegancodes.ondas.features.conversations

import androidx.test.core.app.ApplicationProvider
import com.keegancodes.ondas.data.ConversationRepository
import com.keegancodes.ondas.data.OndasDatabase
import com.keegancodes.ondas.kit.models.ChatMessage
import com.keegancodes.ondas.kit.models.ChatRole
import com.keegancodes.ondas.kit.models.Conversation
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.UUID
import kotlin.time.Duration.Companion.seconds
import kotlin.time.Instant

@RunWith(RobolectricTestRunner::class)
class ConversationListModelTest {

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

    /** Creates a conversation with a title and messages, at a distinct, increasing `updatedAt`. */
    private suspend fun seed(title: String, vararg texts: String): Conversation {
        clock += 1.seconds
        val conversation = repository.createConversation()
        repository.rename(conversation.id, title)
        texts.forEach { text ->
            clock += 1.seconds
            repository.appendMessage(
                conversation.id,
                ChatMessage(role = ChatRole.USER, text = text, createdAt = clock),
            )
        }
        return conversation
    }

    private fun CoroutineScope.model() = ConversationListModel(repository, this)

    /**
     * Waits for the model's view of the store to settle.
     *
     * NOT `advanceUntilIdle()`: Room's suspend DAO functions and its invalidation-tracker flows
     * run on Room's OWN executors, outside the test scheduler's virtual time, so advancing virtual
     * time returns while the database work is still in flight. (The same trap spec #92 hit, noted
     * in PORTING.md.) Suspending on the state flow instead waits for the real emission.
     */
    private suspend fun ConversationListModel.awaitUnfilteredCount(count: Int) {
        state.first { it.conversations.size == count }
    }

    // -- filtering -----------------------------------------------------------------------------

    @Test
    fun `search matches conversation titles and message text, case-insensitively`() = runTest {
        seed("Poetry", "write me a haiku")
        seed("Groceries", "milk and eggs")
        seed("HAIKU club", "unrelated body")
        val model = backgroundScope.model()
        model.awaitUnfilteredCount(3)

        model.setSearchText("haiku")
        assertEquals(
            setOf("HAIKU club", "Poetry"),
            model.state.value.conversations.map { it.title }.toSet(),
        )

        model.setSearchText("MILK")
        assertEquals(listOf("Groceries"), model.state.value.conversations.map { it.title })
    }

    @Test
    fun `a blank query shows every conversation`() = runTest {
        seed("Poetry", "haiku")
        seed("Groceries", "milk")
        val model = backgroundScope.model()
        model.awaitUnfilteredCount(2)

        model.setSearchText("   ")
        assertEquals(2, model.state.value.conversations.size)
    }

    @Test
    fun `isEmpty reports the unfiltered list so a search miss does not claim there are no chats`() =
        runTest {
            seed("Poetry", "haiku")
            val model = backgroundScope.model()
            model.awaitUnfilteredCount(1)

            model.setSearchText("nothing matches this")
            assertTrue(model.state.value.conversations.isEmpty())
            // The empty-state overlay is conditioned on this, and Swift conditions it on the
            // unfiltered query too.
            assertEquals(false, model.state.value.isEmpty)
        }

    // -- deletion ------------------------------------------------------------------------------

    /**
     * The regression this exists for: indexing a delete into the raw query instead of the rendered
     * (filtered) list. Both lists are non-empty and their element at index 0 differs, so the naive
     * implementation deletes a visible-but-unsearched conversation and this fails.
     */
    @Test
    fun `deleting while searching removes the searched row, not the one at that index unfiltered`() =
        runTest {
            val oldest = seed("Poetry", "write me a haiku")
            seed("Groceries", "milk and eggs")
            val newest = seed("Travel", "flights to Lisbon")
            val model = backgroundScope.model()
            model.awaitUnfilteredCount(3)

            // Unfiltered order is newest-first: Travel, Groceries, Poetry. Filtered is just Poetry,
            // so index 0 means two different conversations in the two lists.
            model.setSearchText("haiku")
            assertEquals(listOf("Poetry"), model.state.value.conversations.map { it.title })

            model.deleteAt(0)
            model.state.first { !it.isEmpty && it.conversations.isEmpty() }

            assertNull("the searched conversation was deleted", repository.conversation(oldest.id))
            assertNotNull("the newest was left alone", repository.conversation(newest.id))
        }

    /**
     * Deleting the OPEN conversation must clear the selection first, in the same turn, so nothing
     * is still pointed at a conversation that is about to stop existing. Asserted before the
     * delete coroutine runs: moving the clear inside the `launch` fails here.
     */
    @Test
    fun `deleting the open conversation clears the selection before the row is removed`() = runTest {
        val conversation = seed("Poetry", "haiku")
        val model = backgroundScope.model()
        model.awaitUnfilteredCount(1)

        model.select(conversation.id)
        assertEquals(conversation.id, model.state.value.selectedId)

        model.deleteAt(0)
        // No await: the delete coroutine has not run yet, and the selection must already be gone.
        assertNull(model.state.value.selectedId)
        assertNotNull(repository.conversation(conversation.id))

        model.awaitUnfilteredCount(0)
        assertNull(repository.conversation(conversation.id))
    }

    @Test
    fun `deleting a conversation that is not open leaves the selection alone`() = runTest {
        val kept = seed("Poetry", "haiku")
        seed("Groceries", "milk")
        val model = backgroundScope.model()
        model.awaitUnfilteredCount(2)

        model.select(kept.id)
        // Index 0 unfiltered is the newest, i.e. Groceries -- not the selected one.
        model.deleteAt(0)
        assertEquals(kept.id, model.state.value.selectedId)

        model.awaitUnfilteredCount(1)
        assertNotNull(repository.conversation(kept.id))
    }

    @Test
    fun `deleting past the end of the rendered list is a no-op`() = runTest {
        seed("Poetry", "haiku")
        val model = backgroundScope.model()
        model.awaitUnfilteredCount(1)

        model.deleteAt(5)
        assertEquals(1, model.state.value.conversations.size)
    }

    // -- new chat ------------------------------------------------------------------------------

    @Test
    fun `new chat reuses an existing empty conversation rather than adding another`() = runTest {
        val empty = repository.reuseEmptyOrCreate()
        val model = backgroundScope.model()
        model.awaitUnfilteredCount(1)

        model.startNewConversation()
        model.state.first { it.selectedId != null }

        assertEquals(empty.id, model.state.value.selectedId)
        assertEquals(1, model.state.value.conversations.size)
    }

    @Test
    fun `new chat creates and selects a conversation when none is empty`() = runTest {
        seed("Poetry", "haiku")
        val model = backgroundScope.model()
        model.awaitUnfilteredCount(1)

        model.startNewConversation()
        model.state.first { it.selectedId != null }

        val selected: UUID? = model.state.value.selectedId
        assertNotNull(selected)
        model.awaitUnfilteredCount(2)
        assertEquals(Conversation.DEFAULT_TITLE, repository.conversation(selected!!)?.title)
    }
}
