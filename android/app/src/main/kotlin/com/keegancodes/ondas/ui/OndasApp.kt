package com.keegancodes.ondas.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.Scaffold
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.ui.text.style.TextOverflow
import com.keegancodes.ondas.kit.models.Conversation
import androidx.compose.material3.adaptive.layout.AnimatedPane
import androidx.compose.material3.adaptive.layout.ListDetailPaneScaffoldRole
import androidx.compose.material3.adaptive.navigation.NavigableListDetailPaneScaffold
import androidx.compose.material3.adaptive.navigation.rememberListDetailPaneScaffoldNavigator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.keegancodes.ondas.chat.ChatEngine
import com.keegancodes.ondas.data.ConversationRepository
import com.keegancodes.ondas.features.chat.ChatScreen
import com.keegancodes.ondas.features.conversations.ConversationListModel
import com.keegancodes.ondas.features.conversations.ConversationListScreen
import com.keegancodes.ondas.features.settings.SettingsController
import com.keegancodes.ondas.features.settings.SettingsSheet
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * The app shell: the counterpart of `OndasApp`'s single `WindowGroup { ConversationListView() }`
 * plus the `NavigationSplitView` inside it.
 *
 * SwiftUI gets two columns on iPad/Mac and a push stack on iPhone from one declaration;
 * [NavigableListDetailPaneScaffold] is the Android statement of the same thing — it reads the
 * window size class, shows one pane or two accordingly, and wires the system back gesture to pop
 * the detail on a phone.
 *
 * The parameters are passed in rather than resolved from a container so the whole shell — app bar,
 * two-pane behaviour, settings presentation, selection lifecycle — can be exercised under
 * Robolectric without AICore.
 */
@OptIn(ExperimentalMaterial3AdaptiveApi::class)
@Composable
public fun OndasApp(
    listModel: ConversationListModel,
    repository: ConversationRepository,
    settings: SettingsController,
    /** Builds the engine for the conversation the detail pane has just opened. */
    createEngine: () -> ChatEngine,
    modifier: Modifier = Modifier,
) {
    val state by listModel.state.collectAsStateWithLifecycle()
    val navigator = rememberListDetailPaneScaffoldNavigator<String>()
    val scope = rememberCoroutineScope()
    var showSettings by rememberSaveable { mutableStateOf(false) }

    // Selection is owned by the list model, not by the navigator: deleting the open conversation
    // has to be able to clear it synchronously, and the navigator's own navigation is suspending.
    // The navigator is driven FROM the selection so the two cannot disagree.
    LaunchedEffect(state.selectedId) {
        val selected = state.selectedId
        if (selected != null) {
            navigator.navigateTo(ListDetailPaneScaffoldRole.Detail, selected.toString())
        } else if (navigator.canNavigateBack()) {
            // Single-pane: the conversation that was showing is gone, so pop back to the list.
            navigator.navigateBack()
        }
    }

    NavigableListDetailPaneScaffold(
        navigator = navigator,
        modifier = modifier,
        listPane = {
            AnimatedPane {
                ConversationListScreen(
                    state = state,
                    onSearchTextChange = listModel::setSearchText,
                    onSelect = { id ->
                        listModel.select(id)
                        // Also navigate explicitly. On a phone the back gesture pops the detail
                        // while the selection stays put (as it does on iPhone), so tapping the
                        // SAME row again does not change `selectedId` and the effect above would
                        // not re-fire — the second tap would do nothing at all.
                        scope.launch {
                            navigator.navigateTo(ListDetailPaneScaffoldRole.Detail, id.toString())
                        }
                    },
                    onDelete = listModel::deleteAt,
                    onNewChat = listModel::startNewConversation,
                    onOpenSettings = { showSettings = true },
                )
            }
        },
        detailPane = {
            AnimatedPane {
                val selected = state.selectedId
                if (selected == null) {
                    NoSelectionState()
                } else {
                    // Keyed on the conversation id: switching chats builds a fresh engine rather
                    // than reconfiguring the one that may still be streaming. Swift does the same
                    // with `.id(conversation.id)` on the detail view.
                    key(selected) {
                        ConversationDetailPane(
                            conversationId = selected,
                            repository = repository,
                            createEngine = createEngine,
                            onStartNewChat = listModel::startNewConversation,
                            // Only single-pane shows a back affordance: on a two-pane tablet the
                            // list is already on screen, exactly as NavigationSplitView behaves.
                            onBack = if (navigator.canNavigateBack()) {
                                { scope.launch { navigator.navigateBack() } }
                            } else {
                                null
                            },
                        )
                    }
                }
            }
        },
    )

    if (showSettings) {
        SettingsSheet(controller = settings, onDismiss = { showSettings = false })
    }
}

/**
 * Hosts one conversation's [ChatEngine].
 *
 * Two effects, mirroring `ChatView`'s two:
 *
 * - `.task(id: conversation.id)` becomes the first emission of the conversation flow, which
 *   `configure`s the engine. Subsequent emissions go to `onConversationChanged` instead: SwiftData
 *   mutates the same object in place and SwiftUI observes it, whereas here every write produces a
 *   new immutable [com.keegancodes.ondas.kit.models.Conversation] that has to be handed over.
 *   Re-`configure`ing on each emission would re-run availability and token counting on every
 *   persisted streaming chunk, which is not what `.task(id:)` does.
 * - `.onDisappear { engine.cancelActiveTurn() }` becomes the `DisposableEffect`, so a reply stops
 *   streaming into a conversation that is no longer on screen.
 */
@Composable
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
private fun ConversationDetailPane(
    conversationId: UUID,
    repository: ConversationRepository,
    createEngine: () -> ChatEngine,
    onStartNewChat: () -> Unit,
    onBack: (() -> Unit)?,
) {
    val engine = remember(conversationId) { createEngine() }

    LaunchedEffect(engine, conversationId) {
        var configured = false
        repository.observeConversation(conversationId).collect { conversation ->
            if (conversation == null) return@collect
            if (configured) {
                engine.onConversationChanged(conversation)
            } else {
                configured = true
                engine.configure(conversation)
            }
        }
    }

    DisposableEffect(engine) {
        onDispose { engine.cancelActiveTurn() }
    }

    val engineState by engine.state.collectAsStateWithLifecycle()

    // `.navigationTitle(conversation.title)` + `.navigationBarTitleDisplayMode(.inline)`
    // (ChatView.swift:73-74). SwiftUI's NavigationSplitView supplies this bar for free when the
    // detail is pushed; Compose does not, so it has to be drawn. It was missing entirely until a
    // screenshot on a real phone showed a chat with no title and no way back.
    Scaffold(
        modifier = Modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = engineState.conversation?.title ?: Conversation.DEFAULT_TITLE,
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(
                                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = "Back to chats",
                            )
                        }
                    }
                },
            )
        },
    ) { padding ->
        ChatScreen(
            engine = engine,
            onStartNewChat = onStartNewChat,
            modifier = Modifier.fillMaxSize().padding(padding),
        )
    }
}

/** `ContentUnavailableView("Pick a Chat", …)` — the empty detail column on a two-pane layout. */
@Composable
private fun NoSelectionState(modifier: Modifier = Modifier) {
    Surface(modifier = modifier.fillMaxSize()) {
        Column(
            modifier = Modifier.fillMaxSize().padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = NO_SELECTION_TITLE,
                style = MaterialTheme.typography.headlineSmall,
                textAlign = TextAlign.Center,
            )
            Text(
                text = NO_SELECTION_DESCRIPTION,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 8.dp),
            )
        }
    }
}

internal const val NO_SELECTION_TITLE: String = "Pick a Chat"
internal const val NO_SELECTION_DESCRIPTION: String =
    "Select a conversation or start a new one."
