package com.keegancodes.ondas.features.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.keegancodes.ondas.design.Theme
import com.keegancodes.ondas.kit.models.ChatMessage
import com.keegancodes.ondas.kit.models.ChatRole
import kotlinx.coroutines.launch

/**
 * The scrolling transcript — the port of `ChatView.transcript` (`ChatView.swift:106-186`).
 *
 * ## A `LazyColumn`, deliberately
 *
 * The Swift original is an explicitly non-lazy `VStack` with a long comment explaining why: on Mac
 * Catalyst a `LazyVStack` livelocked the main thread because lazy row placement depends on the
 * visible rect while placing rows changes the content-size estimate, and with row heights as mixed
 * as a divider next to an essay the estimate never converged inside one SwiftUI layout pass. That
 * is a SwiftUI ideal-size measurement problem and it has no Android counterpart — a `LazyColumn`
 * measures only what it shows and never asks for an ideal content size. Porting the workaround
 * would be cargo-culting a fix for a bug that does not exist here (PORTING.md § What does NOT
 * carry over from iOS).
 *
 * ## Sticky follow
 *
 * [autoScroll] follows streamed text to the bottom. It is released **only** by a user-driven
 * scroll more than [AT_BOTTOM_THRESHOLD] off the bottom, and re-engaged the instant the transcript
 * is back within it. That distinction is the whole point, and it is why a plain proximity gate
 * cannot express this: streamed text growing the content moves the transcript away from the bottom
 * too, and that must not hand control to the user.
 *
 * Swift attributes a scroll with `onScrollPhaseChange` (`.tracking` / `.interacting` /
 * `.decelerating`). The counterpart here is the nested-scroll connection below: programmatic
 * `LazyListState` scrolls do not dispatch nested-scroll deltas, so anything arriving through it is
 * the user's finger or the fling that follows it. `isScrollInProgress` is NOT usable for this —
 * it is true for our own auto-scroll as well.
 *
 * **Honest limit on the coverage.** `ChatContentTest` proves the follow happens and that a hand
 * scroll releases it, but mutating `isUserScrolling.value &&` out of the condition below — turning
 * it into the proximity gate Swift warns against — leaves the suite green. The reason is an
 * ordering accident of this platform rather than a hole in the port: `scrollToItem` is requested
 * from a composition-time effect and applied in the same measure pass that grew the row, so there
 * is no frame in which a proximity gate could see the gap. The guard is kept because that ordering
 * is not something this file controls, and it is what Swift's comment says the behaviour is — but
 * no test here can currently fail on it, and claiming otherwise would be worse than saying so.
 */
@Composable
internal fun Transcript(
    messages: List<ChatMessage>,
    isResponding: Boolean,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current

    var autoScroll by remember { mutableStateOf(true) }
    var showJumpButton by remember { mutableStateOf(false) }
    // Held as a plain MutableState rather than a delegated `var` because the nested-scroll object
    // below outlives a single composition and writes to it from outside the composable body.
    val isUserScrolling = remember { mutableStateOf(false) }

    val userScrollConnection = remember {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                // UserInput is the drag; SideEffect is the fling that continues it. Together they
                // are Swift's tracking/interacting/decelerating phases.
                if (source == NestedScrollSource.UserInput || source == NestedScrollSource.SideEffect) {
                    isUserScrolling.value = true
                }
                return Offset.Zero
            }
        }
    }
    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress }.collect { inProgress ->
            if (!inProgress) isUserScrolling.value = false
        }
    }

    // The trailing anchor Swift keeps at the end of its ScrollView, so "scroll to the bottom" is a
    // scroll to a real item rather than an estimate of the content height.
    val itemCount = messages.size + 1

    LaunchedEffect(listState, density) {
        val atBottom = with(density) { AT_BOTTOM_THRESHOLD.roundToPx() }
        val jumpVisible = with(density) { JUMP_BUTTON_THRESHOLD.roundToPx() }
        snapshotFlow { listState.distanceFromBottom() }.collect { distance ->
            if (distance <= atBottom) {
                // Back at the bottom (whether the user scrolled there or our own auto-scroll did)
                // — follow the generation again.
                if (!autoScroll) autoScroll = true
            } else if (isUserScrolling.value && autoScroll) {
                // The user scrolled away from the bottom: hand them control and stay put.
                // Growth from streamed text (not user-driven) never trips this.
                autoScroll = false
            }
            val shouldShowJump = distance > jumpVisible
            if (shouldShowJump != showJumpButton) showJumpButton = shouldShowJump
        }
    }

    var hasAppeared by remember { mutableStateOf(false) }
    LaunchedEffect(messages.size) {
        if (!hasAppeared) {
            // Swift's `.onAppear`: land at the bottom without animating in.
            hasAppeared = true
            listState.scrollToBottom(itemCount, messages.isNotEmpty(), animated = false)
        } else {
            // A new message (the user's send, then the reply placeholder): snap to it and resume
            // following the generation.
            autoScroll = true
            listState.scrollToBottom(itemCount, messages.isNotEmpty(), animated = true)
        }
    }

    val latestText = messages.lastOrNull()?.text ?: ""
    LaunchedEffect(latestText) {
        // Follow streamed/late-arriving text only while auto-scroll is engaged. Unanimated, to
        // stay glued smoothly to the growing text rather than stuttering per token.
        if (autoScroll) listState.scrollToBottom(itemCount, messages.isNotEmpty(), animated = false)
    }

    Box(modifier = modifier) {
        LazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxSize()
                .nestedScroll(userScrollConnection),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            val latest = messages.lastOrNull()
            items(items = messages, key = { it.id.toString() }) { message ->
                MessageRow(
                    message = message,
                    isResponding = isResponding,
                    latest = latest,
                    // Swift animates only on a message-count change, so new rows slide into place
                    // without animating every token update as the last message streams.
                    modifier = Modifier.animateItem(
                        placementSpec = spring(dampingRatio = 0.85f, stiffness = MESSAGE_SPRING_STIFFNESS),
                    ),
                )
            }
            item(key = BOTTOM_ANCHOR_KEY) { Spacer(Modifier.height(1.dp)) }
        }

        AnimatedVisibility(
            visible = showJumpButton,
            modifier = Modifier.align(Alignment.BottomEnd),
            enter = fadeIn(tween(JUMP_FADE_MILLIS)),
            exit = fadeOut(tween(JUMP_FADE_MILLIS)),
        ) {
            JumpToBottomButton(
                onClick = {
                    autoScroll = true
                    scope.launch {
                        listState.scrollToBottom(itemCount, messages.isNotEmpty(), animated = true)
                    }
                },
                modifier = Modifier.padding(end = 16.dp, bottom = 8.dp),
            )
        }
    }
}

/**
 * One row: a compaction divider for a summary marker, otherwise a message bubble. Split out for
 * the same reason Swift splits it — the row's two shapes are unrelated and reading them inline
 * buries the condition.
 */
@Composable
private fun MessageRow(
    message: ChatMessage,
    isResponding: Boolean,
    latest: ChatMessage?,
    modifier: Modifier = Modifier,
) {
    if (message.isCompactionSummary) {
        CompactionDivider(modifier = modifier)
    } else {
        MessageBubble(
            message = message,
            isAwaitingResponse = isResponding && message.isEmptyPlaceholder,
            modifier = modifier,
            isStreaming = isStreaming(message, latest, isResponding),
        )
    }
}

/**
 * True while [message] is the in-flight assistant reply currently receiving streamed text.
 * [latest] is passed in so the caller's already-ordered copy is reused.
 */
private fun isStreaming(message: ChatMessage, latest: ChatMessage?, isResponding: Boolean): Boolean =
    isResponding &&
        message.role == ChatRole.ASSISTANT &&
        message.text.isNotEmpty() &&
        message.id == latest?.id

@Composable
private fun JumpToBottomButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val chevron = Theme.secondaryLabel
    Surface(
        onClick = onClick,
        modifier = modifier
            .size(36.dp)
            .semantics { contentDescription = JUMP_TO_BOTTOM_LABEL },
        shape = CircleShape,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        border = BorderStroke(1.dp, Theme.separator),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(
                imageVector = Icons.Filled.KeyboardArrowDown,
                contentDescription = null, // the Surface above carries the label
                tint = chevron,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

/**
 * Pixels between the end of the content and the bottom of the viewport.
 *
 * Returns [Int.MAX_VALUE] when the final item is not even visible: a lazy list cannot know the
 * height of content it has not measured, and every threshold here is "far from the bottom"
 * anyway, so the exact figure is not information the caller can use.
 */
private fun LazyListState.distanceFromBottom(): Int {
    val info = layoutInfo
    val last = info.visibleItemsInfo.lastOrNull() ?: return 0
    if (last.index < info.totalItemsCount - 1) return Int.MAX_VALUE
    val contentEnd = info.viewportEndOffset - info.afterContentPadding
    return (last.offset + last.size - contentEnd).coerceAtLeast(0)
}

/** Swift's `scrollToBottom`, including its `guard conversation.hasMessages`. */
private suspend fun LazyListState.scrollToBottom(itemCount: Int, hasMessages: Boolean, animated: Boolean) {
    if (!hasMessages || itemCount <= 0) return
    val target = itemCount - 1
    if (animated) animateScrollToItem(target) else scrollToItem(target)
}

/**
 * Slack for treating the transcript as "at the bottom" — small, so any deliberate scroll-up
 * releases auto-scroll, while sub-pixel layout jitter during streaming does not.
 */
private val AT_BOTTOM_THRESHOLD = 40.dp

/** How far from the bottom the user must be before the jump-to-bottom button appears. */
private val JUMP_BUTTON_THRESHOLD = 120.dp

internal const val JUMP_TO_BOTTOM_LABEL = "Scroll to latest message"

private const val BOTTOM_ANCHOR_KEY = "bottom-anchor"
private const val JUMP_FADE_MILLIS = 200

/** `spring(response: 0.35, dampingFraction: 0.85)` — stiffness is (2π / response)². */
private const val MESSAGE_SPRING_STIFFNESS = 322f
