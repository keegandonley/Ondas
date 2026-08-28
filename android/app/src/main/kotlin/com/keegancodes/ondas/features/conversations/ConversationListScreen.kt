package com.keegancodes.ondas.features.conversations

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.keegancodes.ondas.kit.models.Conversation
import java.util.UUID

/**
 * The sidebar of `ConversationListView`: a searchable list of chats with the app's primary
 * navigation chrome.
 *
 * Stateless on purpose — every piece of state arrives in [state] and every mutation leaves through
 * a callback, so the search/delete/empty-state behaviour is testable without a database.
 *
 * ## What is NOT here, and why
 * The Gallery toolbar button and the bottom-bar "Generate Image" action are absent: image
 * generation is cut from v1 (PORTING.md § Known unported Swift). They are absent rather than
 * disabled, the same way `Conversation.previewText`'s image branch is.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun ConversationListScreen(
    state: ConversationListUiState,
    onSearchTextChange: (String) -> Unit,
    onSelect: (UUID) -> Unit,
    /** Index into the RENDERED list — see [ConversationListModel.deleteAt]. */
    onDelete: (Int) -> Unit,
    onNewChat: () -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(CHATS_TITLE) },
                navigationIcon = {
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Filled.Settings, contentDescription = SETTINGS_ACTION)
                    }
                },
                actions = {
                    IconButton(onClick = onNewChat) {
                        Icon(Icons.Filled.Edit, contentDescription = NEW_CHAT_ACTION)
                    }
                },
            )
        },
    ) { insets ->
        Column(modifier = Modifier.padding(insets).fillMaxSize()) {
            SearchField(
                value = state.searchText,
                onValueChange = onSearchTextChange,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp),
            )
            if (state.isEmpty) {
                // Conditioned on the UNFILTERED list, as Swift's `.overlay` is: a search that
                // matches nothing leaves an empty list, it does not claim there are no chats.
                EmptyState(onNewChat = onNewChat, modifier = Modifier.fillMaxSize())
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize().testTag(CONVERSATION_LIST_TAG),
                    contentPadding = PaddingValues(bottom = 16.dp),
                ) {
                    itemsIndexed(
                        items = state.conversations,
                        key = { _, conversation -> conversation.id },
                    ) { index, conversation ->
                        ConversationRow(
                            conversation = conversation,
                            isSelected = conversation.id == state.selectedId,
                            onClick = { onSelect(conversation.id) },
                            onDelete = { onDelete(index) },
                        )
                    }
                }
            }
        }
    }
}

/**
 * One row: title plus a one-line preview of the latest message.
 *
 * No thumbnail branch — `Conversation.latestImageMessage` has no Android counterpart with image
 * generation cut.
 *
 * Delete is offered two ways, mirroring Swift's pair: a trailing swipe (the platform-idiomatic
 * gesture, standing in for `.swipeActions`) and a long-press menu (standing in for
 * `.contextMenu`, which is a right-click on Catalyst and a long-press on iOS). Both call the same
 * callback, so neither path can drift from the other.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
private fun ConversationRow(
    conversation: Conversation,
    isSelected: Boolean,
    onClick: () -> Unit,
    onDelete: () -> Unit,
) {
    var menuExpanded by remember { mutableStateOf(false) }
    val dismissState = rememberSwipeToDismissBoxState()

    SwipeToDismissBox(
        state = dismissState,
        enableDismissFromStartToEnd = false,
        enableDismissFromEndToStart = true,
        // The non-deprecated settle callback; `confirmValueChange` is deprecated in material3
        // 1.4.0 and vetoing from it is no longer the supported shape.
        onDismiss = { onDelete() },
        backgroundContent = {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(MaterialTheme.colorScheme.errorContainer)
                    .padding(horizontal = 20.dp),
                contentAlignment = Alignment.CenterEnd,
            ) {
                Icon(
                    Icons.Filled.Delete,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onErrorContainer,
                )
            }
        },
    ) {
        Box {
            ListItem(
                headlineContent = {
                    Text(
                        text = conversation.title,
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                supportingContent = {
                    Text(
                        // Already skips compaction markers -- see Conversation.latestMessage.
                        text = conversation.previewText,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                colors = if (isSelected) {
                    ListItemDefaults.colors(
                        containerColor = MaterialTheme.colorScheme.secondaryContainer,
                    )
                } else {
                    ListItemDefaults.colors()
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .combinedClickable(
                        onClick = onClick,
                        onLongClick = { menuExpanded = true },
                    )
                    .testTag(rowTag(conversation.id)),
            )
            DropdownMenu(expanded = menuExpanded, onDismissRequest = { menuExpanded = false }) {
                DropdownMenuItem(
                    text = { Text(DELETE_ACTION) },
                    onClick = {
                        menuExpanded = false
                        onDelete()
                    },
                    leadingIcon = { Icon(Icons.Filled.Delete, contentDescription = null) },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SearchField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.testTag(SEARCH_FIELD_TAG),
        singleLine = true,
        placeholder = { Text(SEARCH_PROMPT) },
        leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
        trailingIcon = {
            if (value.isNotEmpty()) {
                IconButton(onClick = { onValueChange("") }) {
                    Icon(Icons.Filled.Clear, contentDescription = CLEAR_SEARCH_ACTION)
                }
            }
        },
    )
}

/** `ContentUnavailableView("No Chats Yet", …)`, with its New Chat action. */
@Composable
private fun EmptyState(onNewChat: () -> Unit, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = EMPTY_TITLE,
            style = MaterialTheme.typography.headlineSmall,
            textAlign = TextAlign.Center,
        )
        Text(
            text = EMPTY_DESCRIPTION,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 8.dp, bottom = 20.dp),
        )
        Button(onClick = onNewChat) { Text(NEW_CHAT_ACTION) }
    }
}

// Copy is held as constants so the tests assert against the same strings the UI renders rather
// than against a second, drifting transcription of them.
internal const val CHATS_TITLE: String = "Chats"
internal const val SEARCH_PROMPT: String = "Search chats"
internal const val SETTINGS_ACTION: String = "Settings"
internal const val NEW_CHAT_ACTION: String = "New Chat"
internal const val DELETE_ACTION: String = "Delete"
internal const val CLEAR_SEARCH_ACTION: String = "Clear search"
internal const val EMPTY_TITLE: String = "No Chats Yet"
internal const val EMPTY_DESCRIPTION: String =
    "Start a new conversation to chat with the on-device model."

internal const val CONVERSATION_LIST_TAG: String = "conversationList"
internal const val SEARCH_FIELD_TAG: String = "conversationSearchField"

internal fun rowTag(id: UUID): String = "conversationRow:$id"
