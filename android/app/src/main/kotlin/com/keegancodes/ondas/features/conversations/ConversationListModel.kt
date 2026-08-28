package com.keegancodes.ondas.features.conversations

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.keegancodes.ondas.data.ConversationRepository
import com.keegancodes.ondas.kit.models.Conversation
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * Everything the conversation list renders, in one snapshot.
 *
 * [conversations] is the FILTERED list — the one the UI draws and the one deletion indexes into.
 * [isEmpty] is the emptiness of the *unfiltered* query, because Swift's empty-state overlay is
 * conditioned on `conversations.isEmpty` and not on the search result: a search that matches
 * nothing shows an empty list, not "No Chats Yet".
 */
public data class ConversationListUiState(
    val conversations: List<Conversation> = emptyList(),
    val isEmpty: Boolean = true,
    val searchText: String = "",
    val selectedId: UUID? = null,
)

/**
 * Narrows conversations by the search field.
 *
 * Deliberately in memory rather than a `LIKE` query, which is what Swift does: the sort is a live
 * reactive query and re-issuing it per keystroke would fight it, and at personal chat-history
 * scale the whole set is already resident. Titles AND message text are searched, case-insensitively.
 *
 * Reads [Conversation.messages] rather than `orderedMessages` — membership does not care about
 * order, so there is no reason to pay for the sort. (Swift carries the same note.)
 */
internal fun filterConversations(
    conversations: List<Conversation>,
    query: String,
): List<Conversation> {
    val trimmed = query.trim()
    if (trimmed.isEmpty()) return conversations
    return conversations.filter { conversation ->
        conversation.title.contains(trimmed, ignoreCase = true) ||
            conversation.messages.any { it.text.contains(trimmed, ignoreCase = true) }
    }
}

/**
 * The state behind `ConversationListView`: the live sorted query, the search field, the selection,
 * and the three mutations the list can perform.
 *
 * A `ViewModel` rather than plain `remember`d state so the search text and selection survive a
 * configuration change — the counterpart of SwiftUI keeping `@State` across a rotation, which it
 * does for free.
 */
public class ConversationListModel(
    private val repository: ConversationRepository,
    /** Overridable so a test can drive the same scope its virtual clock controls. */
    private val scope: CoroutineScope? = null,
) : ViewModel() {

    private val workScope: CoroutineScope get() = scope ?: viewModelScope

    private val _state = MutableStateFlow(ConversationListUiState())
    public val state: StateFlow<ConversationListUiState> = _state.asStateFlow()

    /** The unfiltered query result, newest activity first. Kept so filtering can be re-derived. */
    private var allConversations: List<Conversation> = emptyList()
    private var searchText: String = ""
    private var selectedId: UUID? = null

    init {
        workScope.launch {
            repository.observeConversations().collect { conversations ->
                allConversations = conversations
                recompute()
            }
        }
    }

    public fun setSearchText(text: String) {
        searchText = text
        recompute()
    }

    public fun select(id: UUID?) {
        selectedId = id
        recompute()
    }

    /**
     * Deletes the row at [index] **of the rendered (filtered) list**.
     *
     * The index has to resolve against the same array the list draws, not the unfiltered query —
     * otherwise deleting while a search is active removes a different conversation than the one
     * swiped. Swift's `deleteConversations(at:)` carries exactly this note.
     */
    public fun deleteAt(index: Int) {
        val target = _state.value.conversations.getOrNull(index) ?: return
        delete(target)
    }

    /**
     * Deletes a conversation.
     *
     * The selection is cleared **first and synchronously**, before the row is removed. If the
     * deleted conversation is the open one, the detail pane is still observing it; tearing the
     * pane down in this frame means nothing reads a conversation that is about to stop existing.
     * Swift defers the delete a main-actor hop for the same reason, where leaving the detail up
     * is an outright crash.
     */
    public fun delete(conversation: Conversation) {
        if (conversation.id == selectedId) select(null)
        workScope.launch { repository.deleteConversation(conversation.id) }
    }

    /**
     * Starts a chat, reusing an existing empty thread rather than accumulating identical
     * "New Chat" rows — repeated taps (and the capacity banner's action) converge on one draft.
     */
    public fun startNewConversation() {
        workScope.launch { select(repository.reuseEmptyOrCreate().id) }
    }

    private fun recompute() {
        _state.value = ConversationListUiState(
            conversations = filterConversations(allConversations, searchText),
            isEmpty = allConversations.isEmpty(),
            searchText = searchText,
            selectedId = selectedId,
        )
    }
}
