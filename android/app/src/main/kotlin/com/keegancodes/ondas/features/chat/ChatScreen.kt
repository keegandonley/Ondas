package com.keegancodes.ondas.features.chat

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.keegancodes.ondas.chat.ChatEngine
import com.keegancodes.ondas.chat.ChatEngineState
import com.keegancodes.ondas.chat.DownloadProgress
import com.keegancodes.ondas.chat.ModelStatus
import com.keegancodes.ondas.design.Theme
import com.keegancodes.ondas.features.conversations.NEW_CHAT_ACTION
import com.keegancodes.ondas.kit.chat.CapacityState
import com.keegancodes.ondas.kit.chat.TokenUsage
import kotlinx.coroutines.launch
import java.text.NumberFormat

/**
 * A single conversation: a scrolling transcript with a message composer pinned to the bottom.
 * The port of `Ondas/Features/Chat/ChatView.swift`.
 *
 * Pointing the engine at a conversation (`configure`) belongs to the shell, which is what knows
 * which conversation is selected; everything else Swift hangs off the view's lifecycle is here.
 *
 * The image-mode composer toggle, the `/image` chip and the image bubble are NOT ported — image
 * generation is cut from Android v1 (PORTING.md § Known unported Swift).
 */
@Composable
public fun ChatScreen(
    engine: ChatEngine,
    onStartNewChat: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by engine.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()

    // Availability can change while backgrounded (the model finished downloading, or on-device AI
    // was turned off in system settings) — re-check on return so the banner reflects reality
    // without waiting for a conversation switch.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        scope.launch { engine.refreshAvailability() }
    }

    DisposableEffect(engine) {
        onDispose {
            // Leaving the conversation cancels any in-flight reply so it stops streaming into a
            // thread that is no longer on screen.
            engine.cancelActiveTurn()
        }
    }

    ChatContent(
        state = state,
        onSend = engine::submit,
        onStop = engine::cancelActiveTurn,
        onCompact = engine::compact,
        onStartNewChat = onStartNewChat,
        onDownloadModel = engine::startDownload,
        modifier = modifier,
    )
}

/**
 * The chat layout, with no engine behind it, so every state combination can be built by hand in a
 * test. Swift's `ChatView.body` minus the parts that only an engine can drive.
 */
@Composable
internal fun ChatContent(
    state: ChatEngineState,
    onSend: (String) -> Unit,
    onStop: () -> Unit,
    onCompact: () -> Unit,
    onStartNewChat: () -> Unit,
    onDownloadModel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val haptic = LocalHapticFeedback.current
    val lastTurn = state.lastTurn
    var signalledTurn by remember { mutableStateOf(lastTurn?.id) }
    LaunchedEffect(lastTurn) {
        // A soft tap when a reply completes, an error tap when the turn failed. `TurnSignal.id`
        // changes per turn, which is what makes it usable as a change trigger. Seeding
        // `signalledTurn` from the first composition keeps a re-entry into the screen from
        // buzzing for a turn that finished before it appeared, matching `.sensoryFeedback`.
        val turn = lastTurn
        if (turn != null && turn.id != signalledTurn) {
            haptic.performHapticFeedback(
                if (turn.failed) HapticFeedbackType.Reject else HapticFeedbackType.Confirm,
            )
        }
        signalledTurn = turn?.id
    }

    Column(modifier = modifier.fillMaxSize()) {
        Transcript(
            messages = state.displayedMessages,
            isResponding = state.isResponding,
            modifier = Modifier.weight(1f),
        )

        // Full takes precedence — its New Chat action works even when the model is down; then an
        // availability notice; then the non-blocking "getting long" warning; then the meter.
        val capacity = state.capacityState
        val availabilityMessage = state.availabilityMessage
        val usage = state.tokenUsage
        when {
            capacity == CapacityState.FULL -> CapacityFullBanner(onStartNewChat = onStartNewChat)

            availabilityMessage != null -> UnavailableBanner(
                message = availabilityMessage,
                status = state.modelStatus,
                progress = state.downloadProgress,
                onDownloadModel = onDownloadModel,
            )

            capacity == CapacityState.APPROACHING -> CapacityWarningBanner(
                isCompacting = state.isCompacting,
                isResponding = state.isResponding,
                onCompact = onCompact,
            )

            usage != null -> TokenMeter(usage)
        }

        Composer(state = state, onSend = onSend, onStop = onStop)
    }
}

/**
 * A slim live meter of how much of the model's context window this conversation is using. The bar
 * shifts from accent to orange as the chat approaches the warning band, at which point
 * [CapacityWarningBanner] replaces the meter entirely — so the ramp lives within `[0, 0.8)`.
 */
@Composable
private fun TokenMeter(usage: TokenUsage) {
    val formatter = remember { NumberFormat.getIntegerInstance() }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Theme.bar)
            .padding(horizontal = 16.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = "Context",
                style = MaterialTheme.typography.labelSmall,
                color = Theme.secondaryLabel,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = "${formatter.format(usage.used)} / ${formatter.format(usage.limit)} tokens",
                // Swift's `.monospacedDigit()`: the count changes constantly and proportional
                // digits make it jitter.
                style = MaterialTheme.typography.labelSmall.copy(fontFeatureSettings = "tnum"),
                color = Theme.secondaryLabel,
            )
        }
        LinearProgressIndicator(
            progress = { usage.fraction.toFloat() },
            modifier = Modifier.fillMaxWidth(),
            color = meterColor(usage.fraction),
        )
    }
}

/** The meter is only shown below the warning band, so the ramp is scaled to that range. */
@Composable
private fun meterColor(fraction: Double): Color =
    if (fraction < METER_WARM_FRACTION) Theme.userBubble else Theme.meterWarning

/**
 * Non-blocking nudge shown as the chat nears the context budget. The user can keep chatting;
 * compaction summarizes the older turns into a divider and continues in the same conversation,
 * which is offered here — while there is still room to summarize — rather than once the chat is
 * full. This branch only renders when the model is available, so the button needs no extra gate.
 */
@Composable
private fun CapacityWarningBanner(isCompacting: Boolean, isResponding: Boolean, onCompact: () -> Unit) {
    BannerRow {
        Text(
            text = if (isCompacting) "Compacting the conversation…" else "This chat is getting long.",
            style = MaterialTheme.typography.bodySmall,
            color = Theme.secondaryLabel,
            modifier = Modifier.weight(1f),
        )
        Button(
            onClick = onCompact,
            // `compact()` also refuses while a reply is streaming, and the composer stays enabled
            // at `.approaching` — so without this the button would be tappable but a silent no-op.
            enabled = !(isResponding || isCompacting),
        ) {
            if (isCompacting) {
                CircularProgressIndicator(
                    modifier = Modifier.size(16.dp),
                    strokeWidth = 2.dp,
                    color = LocalContentColor.current,
                )
            } else {
                Text(text = "Compact", style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

/**
 * Blocking banner once the chat has filled the context budget: the conversation is now too large
 * to summarize reliably, so the only path forward is a fresh chat.
 */
@Composable
private fun CapacityFullBanner(onStartNewChat: () -> Unit) {
    BannerRow {
        Text(
            text = "This chat is full.",
            style = MaterialTheme.typography.bodySmall,
            color = Theme.secondaryLabel,
            modifier = Modifier.weight(1f),
        )
        Button(onClick = onStartNewChat) {
            // The shell's constant, not a re-typed literal: this button and the list's New Chat
            // action must always read the same.
            Text(text = NEW_CHAT_ACTION, style = MaterialTheme.typography.labelLarge)
        }
    }
}

/**
 * The availability notice, plus the model-download affordance.
 *
 * **Android-only, and mandatory (PORTING.md § Mandatory drifts 2).** iOS's
 * `SystemLanguageModel.availability` has three unavailable reasons and no download flow: the model
 * is either present or it is not. ML Kit reports `DOWNLOADABLE` on a fresh device — a brand-new
 * Pixel 11 reports exactly that (spec #88) — and the app has to fetch Nano before the first
 * message can be sent. There is no Swift counterpart to port, so this is new UI.
 */
@Composable
private fun UnavailableBanner(
    message: String,
    /**
     * The model's own status, NOT a string comparison against [message]. Recognising the
     * downloadable case by matching user-facing copy means rewording that copy silently removes
     * the button from every device that needs it.
     */
    status: ModelStatus?,
    progress: DownloadProgress?,
    onDownloadModel: () -> Unit,
) {
    val failure = progress as? DownloadProgress.Failed
    BannerRow {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                text = failure?.message ?: message,
                style = MaterialTheme.typography.bodySmall,
                color = Theme.secondaryLabel,
            )
            when (progress) {
                is DownloadProgress.Progress -> {
                    val total = progress.totalBytes
                    if (total != null && total > 0) {
                        LinearProgressIndicator(
                            progress = { (progress.bytesDownloaded.toFloat() / total).coerceIn(0f, 1f) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    } else {
                        LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    }
                }

                DownloadProgress.Started,
                DownloadProgress.Completed,
                -> LinearProgressIndicator(modifier = Modifier.fillMaxWidth())

                is DownloadProgress.Failed, null -> Unit
            }
        }
        if (status == ModelStatus.DOWNLOADABLE && (progress == null || failure != null)) {
            Button(onClick = onDownloadModel) {
                Text(
                    text = if (failure != null) "Retry" else "Download",
                    style = MaterialTheme.typography.labelLarge,
                )
            }
        }
    }
}

/** The shared frame of all three banners: SwiftUI's `.bar` background and 16/8 padding. */
@Composable
private fun BannerRow(content: @Composable RowScope.() -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Theme.bar)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

@Composable
private fun Composer(state: ChatEngineState, onSend: (String) -> Unit, onStop: () -> Unit) {
    // `rememberSaveable`, not `remember`: MainActivity declares no `configChanges`, so a rotation
    // destroys and recreates the whole Compose tree and a plain `remember` drops whatever the user
    // had typed but not sent. Swift's composer survives rotation for free.
    var draft by rememberSaveable { mutableStateOf("") }
    val haptic = LocalHapticFeedback.current
    val canSend = state.canSend(draft)

    fun send() {
        if (!canSend) return
        val outgoing = draft
        draft = ""
        // A light tap when the user sends.
        haptic.performHapticFeedback(HapticFeedbackType.ContextClick)
        onSend(outgoing)
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Theme.bar)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        Box(
            modifier = Modifier
                .weight(1f)
                .clip(CircleShape)
                .background(Theme.assistantBubble)
                .padding(horizontal = 14.dp, vertical = COMPOSER_VERTICAL_PADDING),
            contentAlignment = Alignment.CenterStart,
        ) {
            BasicTextField(
                value = draft,
                onValueChange = { draft = it },
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = COMPOSER_FIELD_HEIGHT)
                    .testTag(COMPOSER_FIELD_TAG),
                enabled = !state.isComposerDisabled,
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = Theme.onAssistantBubble),
                cursorBrush = SolidColor(Theme.userBubble),
                maxLines = COMPOSER_MAX_LINES,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                // The counterpart of Swift's `.onSubmit(send)`: the on-screen keyboard's Send key
                // sends, and multiline growth comes from the field itself.
                keyboardActions = KeyboardActions(onSend = { send() }),
                decorationBox = { innerTextField ->
                    if (draft.isEmpty()) {
                        Text(
                            text = COMPOSER_PLACEHOLDER,
                            style = MaterialTheme.typography.bodyLarge,
                            color = Theme.secondaryLabel,
                        )
                    }
                    innerTextField()
                },
            )
        }

        ComposerActionButton(
            isResponding = state.isResponding,
            canSend = canSend,
            onSend = ::send,
            onStop = onStop,
        )
    }
}

/**
 * Send, or stop while a reply is streaming.
 *
 * The stop control is **always** tappable — it is the escape hatch for a runaway generation, and
 * the engine keeps whatever text arrived before the cancel.
 */
@Composable
private fun ComposerActionButton(
    isResponding: Boolean,
    canSend: Boolean,
    onSend: () -> Unit,
    onStop: () -> Unit,
) {
    val enabled = if (isResponding) true else canSend
    val fill = Theme.userBubble.let { if (enabled) it else it.copy(alpha = DISABLED_ALPHA) }
    val glyph = Theme.onUserBubble
    IconButton(
        onClick = { if (isResponding) onStop() else onSend() },
        enabled = enabled,
        modifier = Modifier
            .size(COMPOSER_ROW_HEIGHT)
            .semantics {
                contentDescription = if (isResponding) STOP_LABEL else SEND_LABEL
            },
    ) {
        // The filled circle is the button, the glyph sits inside it -- Swift's
        // `arrow.up.circle.fill` / `stop.circle.fill`.
        //
        // Send uses the icon library. Stop is still drawn, and deliberately: `Stop` is NOT in
        // material-icons-core (verified against the artifact, not assumed) -- it lives only in
        // material-icons-EXTENDED, which is a far larger dependency to pull in for one square.
        // `Close` was rejected as a substitute because an X means dismiss, not stop.
        Box(contentAlignment = Alignment.Center) {
            Canvas(modifier = Modifier.size(COMPOSER_GLYPH_SIZE)) {
                drawCircle(color = fill)
                if (isResponding) drawStopSquare(glyph)
            }
            if (!isResponding) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.Send,
                    contentDescription = null, // the IconButton above carries the label
                    tint = glyph,
                    modifier = Modifier.size(COMPOSER_GLYPH_SIZE * 0.5f),
                )
            }
        }
    }
}

/** `stop.circle.fill`'s inner square. */
private fun DrawScope.drawStopSquare(color: Color) {
    val side = size.minDimension * 0.34f
    drawRoundRect(
        color = color,
        topLeft = Offset((size.width - side) / 2f, (size.height - side) / 2f),
        size = Size(side, side),
        cornerRadius = CornerRadius(side * 0.15f),
    )
}

/** `arrow.up.circle.fill`'s inner arrow. */
private fun DrawScope.drawUpArrow(color: Color) {
    val stroke = size.minDimension * 0.09f
    val centerX = size.width / 2f
    drawLine(
        color = color,
        start = Offset(centerX, size.height * 0.70f),
        end = Offset(centerX, size.height * 0.32f),
        strokeWidth = stroke,
        cap = StrokeCap.Round,
    )
    drawLine(
        color = color,
        start = Offset(size.width * 0.32f, size.height * 0.48f),
        end = Offset(centerX, size.height * 0.30f),
        strokeWidth = stroke,
        cap = StrokeCap.Round,
    )
    drawLine(
        color = color,
        start = Offset(centerX, size.height * 0.30f),
        end = Offset(size.width * 0.68f, size.height * 0.48f),
        strokeWidth = stroke,
        cap = StrokeCap.Round,
    )
}

/**
 * The exact banner text `ChatEngine` produces for `ModelStatus.DOWNLOADABLE`, and the only way
 * this screen can tell a downloadable model from an unsupported one: `ChatEngineState` exposes the
 * message but not the status behind it.
 *
 * The coupling is a real one and it is silent if it breaks — the Download button would simply stop
 * appearing on a device that needs it. `ChatContentTest.the download button's trigger matches what
 * ChatEngine actually emits` drives a real engine to `DOWNLOADABLE` and asserts this string, so a
 * reworded message fails a test instead of shipping a dead-end banner.
 */
/** Re-exported from [ChatEngine] so the copy has exactly one home. */
internal val MODEL_DOWNLOADABLE_MESSAGE: String = ChatEngine.MODEL_DOWNLOADABLE_MESSAGE

internal const val SEND_LABEL = "Send message"
internal const val STOP_LABEL = "Stop generating"
internal const val COMPOSER_PLACEHOLDER = "Message"

/**
 * The composer's input field. A tag rather than a label: the field's accessible content is the
 * draft the user typed, and giving it a `contentDescription` to make it findable would replace
 * that announcement with a constant.
 */
internal const val COMPOSER_FIELD_TAG = "composer-field"

/** Baseline height of the composer's single-line input. */
private val COMPOSER_FIELD_HEIGHT = 24.dp

/** Vertical padding inside the input capsule, doubled for top+bottom. */
private val COMPOSER_VERTICAL_PADDING = 9.dp

/** Full height of the single-line input capsule; the send button is sized to match. */
private val COMPOSER_ROW_HEIGHT = COMPOSER_FIELD_HEIGHT + COMPOSER_VERTICAL_PADDING * 2

private val COMPOSER_GLYPH_SIZE = 32.dp
private const val COMPOSER_MAX_LINES = 6
private const val DISABLED_ALPHA = 0.38f
private const val METER_WARM_FRACTION = 0.6
