package com.keegancodes.ondas.features.conversations

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import com.keegancodes.ondas.kit.models.ChatMessage
import com.keegancodes.ondas.kit.models.ChatRole
import com.keegancodes.ondas.kit.models.Conversation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.UUID
import kotlin.time.Instant

/**
 * Rendering coverage for the shared chrome: the app bar, the search field, the rows and the
 * empty state. On the sibling Cadence port this layer was owned by nobody, had no visual coverage
 * while ten feature screens did, and was the thing that shipped broken.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w411dp-h891dp")
class ConversationListScreenTest {

    @get:Rule
    val compose = createComposeRule()

    private fun conversation(
        title: String,
        vararg messages: ChatMessage,
    ) = Conversation(
        id = UUID.randomUUID(),
        title = title,
        createdAt = Instant.fromEpochSeconds(1_000),
        updatedAt = Instant.fromEpochSeconds(1_000),
        messages = messages.toList(),
    )

    private fun message(text: String, isCompactionSummary: Boolean = false, atSeconds: Long = 1) =
        ChatMessage(
            role = ChatRole.ASSISTANT,
            text = text,
            createdAt = Instant.fromEpochSeconds(atSeconds),
            isCompactionSummary = isCompactionSummary,
        )

    private fun render(
        state: ConversationListUiState,
        onSearchTextChange: (String) -> Unit = {},
        onSelect: (UUID) -> Unit = {},
        onDelete: (Int) -> Unit = {},
        onNewChat: () -> Unit = {},
        onOpenSettings: () -> Unit = {},
    ) {
        compose.setContent {
            MaterialTheme {
                ConversationListScreen(
                    state = state,
                    onSearchTextChange = onSearchTextChange,
                    onSelect = onSelect,
                    onDelete = onDelete,
                    onNewChat = onNewChat,
                    onOpenSettings = onOpenSettings,
                )
            }
        }
    }

    @Test
    fun `an empty library shows the No Chats Yet state with a working action`() {
        var started = false
        render(ConversationListUiState(isEmpty = true), onNewChat = { started = true })

        compose.onNodeWithText(EMPTY_TITLE).assertIsDisplayed()
        compose.onNodeWithText(EMPTY_DESCRIPTION).assertIsDisplayed()
        compose.onNodeWithTag(CONVERSATION_LIST_TAG).assertDoesNotExist()

        compose.onNodeWithText(NEW_CHAT_ACTION).performClick()
        assertTrue(started)
    }

    /**
     * A search that matches nothing must NOT claim there are no chats. The empty-state overlay is
     * conditioned on the unfiltered library, exactly as Swift's `.overlay` is; conditioning it on
     * the rendered list instead is the plausible-looking simplification this pins down.
     */
    @Test
    fun `a search that matches nothing shows an empty list, not the No Chats Yet state`() {
        render(
            ConversationListUiState(
                conversations = emptyList(),
                isEmpty = false,
                searchText = "nothing matches this",
            ),
        )

        compose.onNodeWithText(EMPTY_TITLE).assertDoesNotExist()
        compose.onNodeWithText(EMPTY_DESCRIPTION).assertDoesNotExist()
        compose.onNodeWithTag(CONVERSATION_LIST_TAG).assertExists()
    }

    @Test
    fun `a row shows the title and a one-line preview that skips compaction markers`() {
        val chat = conversation(
            "Poetry",
            message("an earlier turn", atSeconds = 1),
            message("Summary of the conversation so far", isCompactionSummary = true, atSeconds = 2),
        )
        render(ConversationListUiState(conversations = listOf(chat), isEmpty = false))

        compose.onNodeWithText("Poetry").assertIsDisplayed()
        // previewText picks the newest NON-compaction message.
        compose.onNodeWithText("an earlier turn").assertIsDisplayed()
        compose.onNodeWithText("Summary of the conversation so far").assertDoesNotExist()
    }

    @Test
    fun `the app bar exposes settings and new chat`() {
        var openedSettings = false
        var started = false
        render(
            ConversationListUiState(isEmpty = true),
            onNewChat = { started = true },
            onOpenSettings = { openedSettings = true },
        )

        compose.onNodeWithText(CHATS_TITLE).assertIsDisplayed()
        compose.onNodeWithContentDescription(SETTINGS_ACTION).performClick()
        assertTrue(openedSettings)
        compose.onNodeWithContentDescription(NEW_CHAT_ACTION).performClick()
        assertTrue(started)
    }

    @Test
    fun `typing in the search field reports the query and the prompt is Search chats`() {
        var query: String? = null
        render(ConversationListUiState(isEmpty = true), onSearchTextChange = { query = it })

        compose.onNodeWithText(SEARCH_PROMPT).assertIsDisplayed()
        compose.onNodeWithTag(SEARCH_FIELD_TAG).performTextInput("haiku")
        assertEquals("haiku", query)
    }

    @Test
    fun `tapping a row selects it`() {
        val chat = conversation("Poetry", message("hello"))
        var selected: UUID? = null
        render(
            ConversationListUiState(conversations = listOf(chat), isEmpty = false),
            onSelect = { selected = it },
        )

        compose.onNodeWithTag(rowTag(chat.id)).performClick()
        assertEquals(chat.id, selected)
    }

    /**
     * The delete callback carries the index into the RENDERED list. Rendering an already-filtered
     * list of two and long-pressing the second row must report index 1 — this is the composable
     * half of the delete-while-searching contract that
     * [ConversationListModelTest] pins on the model half.
     */
    @Test
    fun `the long-press menu deletes the row at its index in the rendered list`() {
        val first = conversation("Travel", message("flights"))
        val second = conversation("Poetry", message("haiku"))
        var deletedIndex: Int? = null
        render(
            ConversationListUiState(conversations = listOf(first, second), isEmpty = false),
            onDelete = { deletedIndex = it },
        )

        assertNull(deletedIndex)
        compose.onNodeWithTag(rowTag(second.id)).performTouchInput { longClick() }
        compose.onNodeWithText(DELETE_ACTION).performClick()
        assertEquals(1, deletedIndex)
    }
}
