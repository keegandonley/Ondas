package com.keegancodes.ondas.features.chat

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.StartOffset
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.keegancodes.ondas.design.Theme
import com.keegancodes.ondas.kit.models.ChatMessage
import com.keegancodes.ondas.kit.models.ChatRole
import kotlinx.coroutines.delay

/**
 * One message: a trailing-aligned accent bubble for the user, a leading-aligned neutral bubble for
 * the assistant. The port of `Ondas/Features/Chat/MessageBubble.swift`.
 *
 * The image branch — the generated-image view, the Save-to-Photos/Share context menu and the
 * Photos permission alert — is NOT ported; image generation is cut from Android v1
 * (PORTING.md § Known unported Swift), so `hasImage` can never be true and the branch is absent
 * rather than dead.
 *
 * @param isAwaitingResponse the assistant's placeholder while the model is still working, shown as
 *   a typing indicator instead of an empty bubble.
 * @param isStreaming this assistant message is actively receiving streamed text, so a blinking
 *   caret trails the content.
 */
@Composable
internal fun MessageBubble(
    message: ChatMessage,
    isAwaitingResponse: Boolean,
    modifier: Modifier = Modifier,
    isStreaming: Boolean = false,
) {
    val isUser = message.role == ChatRole.USER
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        // Swift's `Spacer(minLength: 40)` on the opposite side: the bubble may grow to the full
        // width less 40, never edge to edge.
        Box(
            modifier = Modifier.padding(
                start = if (isUser) OPPOSITE_EDGE_INSET else 0.dp,
                end = if (isUser) 0.dp else OPPOSITE_EDGE_INSET,
            ),
        ) {
            // Cross-fade the thinking dots into the reply as the first token lands.
            Crossfade(targetState = isAwaitingResponse, animationSpec = tween(CROSSFADE_MILLIS), label = "bubble") { awaiting ->
                if (awaiting) {
                    Column(
                        modifier = Modifier
                            .clip(Theme.bubbleShape)
                            .background(Theme.assistantBubble)
                            .padding(horizontal = 14.dp, vertical = 12.dp),
                    ) {
                        ThinkingIndicator()
                    }
                } else {
                    BubbleContent(message = message, isUser = isUser, isStreaming = isStreaming)
                }
            }
        }
    }
}

@Composable
private fun BubbleContent(message: ChatMessage, isUser: Boolean, isStreaming: Boolean) {
    val linkStyle = SpanStyle(
        color = MaterialTheme.colorScheme.primary,
        textDecoration = TextDecoration.Underline,
    )
    // Parse the markdown here rather than inside the blink, so a caret tick does not re-parse the
    // reply — the same split Swift makes by hoisting `renderedText` out of its `TimelineView`.
    val rendered = remember(message.text, isUser, linkStyle) {
        renderMessageText(text = message.text, isUser = isUser, linkStyle = linkStyle)
    }
    val caretVisible = rememberCaretVisible(isStreaming)
    val display = if (isStreaming && caretVisible) {
        buildAnnotatedString {
            append(rendered)
            append(CARET)
        }
    } else {
        rendered
    }

    Column(
        modifier = Modifier
            .clip(Theme.bubbleShape)
            .background(if (isUser) Theme.userBubble else Theme.assistantBubble)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (message.text.isNotEmpty()) {
            SelectionContainer {
                Text(
                    text = display,
                    color = if (isUser) Theme.onUserBubble else Theme.onAssistantBubble,
                    style = MaterialTheme.typography.bodyLarge,
                )
            }
        }
    }
}

/**
 * Model replies may contain Markdown; user-authored text is always shown verbatim.
 *
 * The `runCatching` is Swift's `try?`: an unparseable reply degrades to plain text rather than
 * taking the message with it. [InlineMarkdown] is written to be total, so this is a backstop, not
 * the expected path — an unclosed marker is handled inside the parser and stays readable.
 */
internal fun renderMessageText(text: String, isUser: Boolean, linkStyle: SpanStyle): AnnotatedString =
    if (isUser) {
        AnnotatedString(text)
    } else {
        runCatching { InlineMarkdown.render(text, linkStyle) }.getOrElse { AnnotatedString(text) }
    }

/**
 * The caret's on/off phase while a reply streams.
 *
 * Swift drives this from a `TimelineView(.periodic(by: 0.6))` whose tick parity decides visibility,
 * which is a 0.6s-on / 0.6s-off square wave. There is no TimelineView here, so the wave is produced
 * directly. Returns false when not streaming so the caret cannot linger after the turn ends.
 */
@Composable
private fun rememberCaretVisible(isStreaming: Boolean): Boolean {
    var visible by remember { mutableStateOf(true) }
    LaunchedEffect(isStreaming) {
        if (!isStreaming) {
            visible = true
            return@LaunchedEffect
        }
        while (true) {
            delay(CARET_BLINK_MILLIS)
            visible = !visible
        }
    }
    return isStreaming && visible
}

/** Three dots that pulse while the model composes a reply. */
@Composable
private fun ThinkingIndicator(modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "thinking")
    Row(
        modifier = modifier.semantics(mergeDescendants = true) {
            contentDescription = "Assistant is typing"
        },
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        repeat(DOT_COUNT) { index ->
            val dotAlpha by transition.animateFloat(
                initialValue = 1f,
                targetValue = 0.3f,
                animationSpec = infiniteRepeatable(
                    animation = tween(durationMillis = 600, easing = FastOutSlowInEasing),
                    repeatMode = RepeatMode.Reverse,
                    // Swift staggers with `.delay(index * 0.2)` on a `repeatForever` animation,
                    // which offsets the START of the repeating cycle. A `delayMillis` on the tween
                    // would instead pause on every iteration and change the rhythm.
                    initialStartOffset = StartOffset(index * 200),
                ),
                label = "dot$index",
            )
            Box(
                modifier = Modifier
                    .size(7.dp)
                    .alpha(dotAlpha)
                    .background(Theme.secondaryLabel, CircleShape),
            )
        }
    }
}

/**
 * The blinking caret, concatenated into the same text node rather than overlaid, so it wraps
 * naturally at the end of the last line.
 */
private const val CARET = " ▍"

private const val CARET_BLINK_MILLIS = 600L
private const val CROSSFADE_MILLIS = 200
private const val DOT_COUNT = 3
private val OPPOSITE_EDGE_INSET = 40.dp
