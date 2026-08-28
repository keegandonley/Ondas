package com.keegancodes.ondas.features.chat

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import com.keegancodes.ondas.chat.ChatEngineState
import com.keegancodes.ondas.chat.DownloadProgress
import com.keegancodes.ondas.chat.ModelStatus
import com.keegancodes.ondas.kit.chat.TokenUsage
import com.keegancodes.ondas.kit.chat.TurnSignal
import com.keegancodes.ondas.kit.models.ChatMessage
import com.keegancodes.ondas.kit.models.ChatRole
import com.keegancodes.ondas.kit.models.Conversation
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.time.Instant

/**
 * The chat layout, driven by hand-built [ChatEngineState] values.
 *
 * ## Why the clock is manual in every test
 *
 * `mainClock.autoAdvance` is off throughout. Two things on this screen animate forever — the
 * thinking indicator's pulsing dots and the compaction spinner — and `waitForIdle` (which every
 * finder calls) advances the clock until the composition is idle, which with an infinite animation
 * is never. Driving the clock by hand also makes the streaming caret's blink assertable at an
 * exact moment instead of whenever the test happened to look.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w411dp-h891dp")
class ChatContentTest {

    @get:Rule
    val compose = createComposeRule()

    private var compacted = 0
    private var started = 0
    private var stopped = 0
    private var downloaded = 0
    private var sent = mutableListOf<String>()

    private fun show(state: ChatEngineState, advanceMillis: Long = 1_000) {
        compose.mainClock.autoAdvance = false
        compose.setContent {
            MaterialTheme {
                ChatContent(
                    state = state,
                    onSend = { sent += it },
                    onStop = { stopped++ },
                    onCompact = { compacted++ },
                    onStartNewChat = { started++ },
                    onDownloadModel = { downloaded++ },
                )
            }
        }
        compose.mainClock.advanceTimeBy(advanceMillis)
    }

    // MARK: - Banner precedence

    @Test
    fun `a full chat outranks the availability banner, so New Chat still works`() {
        // The ordering that matters most: `.full` is checked FIRST precisely so its New Chat
        // action is reachable when the model is unavailable and every other path is a dead end.
        show(
            state(
                usage = TokenUsage(used = 100, limit = 100),
                availabilityMessage = UNSUPPORTED_MESSAGE,
            ),
        )

        compose.onNodeWithText("This chat is full.").assertIsDisplayed()
        compose.onNodeWithText("New Chat").assertIsDisplayed()
        compose.onNodeWithText(UNSUPPORTED_MESSAGE).assertDoesNotExist()
    }

    @Test
    fun `New Chat on the full banner calls back`() {
        show(state(usage = TokenUsage(used = 100, limit = 100)))

        compose.onNodeWithText("New Chat").performClick()

        assert(started == 1) { "expected one new-chat callback, got $started" }
    }

    @Test
    fun `the availability banner outranks the approaching warning`() {
        show(
            state(
                usage = TokenUsage(used = 80, limit = 100),
                availabilityMessage = UNSUPPORTED_MESSAGE,
            ),
        )

        compose.onNodeWithText(UNSUPPORTED_MESSAGE).assertIsDisplayed()
        compose.onNodeWithText("This chat is getting long.").assertDoesNotExist()
        compose.onNodeWithText("Context").assertDoesNotExist()
    }

    @Test
    fun `the approaching warning outranks the token meter`() {
        show(state(usage = TokenUsage(used = 80, limit = 100)))

        compose.onNodeWithText("This chat is getting long.").assertIsDisplayed()
        compose.onNodeWithText("Context").assertDoesNotExist()
    }

    @Test
    fun `the token meter shows below the warning band`() {
        show(state(usage = TokenUsage(used = 50, limit = 100)))

        compose.onNodeWithText("Context").assertIsDisplayed()
        compose.onNodeWithText("50 / 100 tokens").assertIsDisplayed()
    }

    // MARK: - Compaction

    @Test
    fun `the compact button is disabled while a reply is streaming`() {
        // The composer stays enabled at `.approaching`, so a reply can be in flight while this
        // banner is up. `compact()` refuses in that state; without the disable the button is
        // tappable and silently does nothing.
        show(state(usage = TokenUsage(used = 80, limit = 100), isResponding = true))

        compose.onNodeWithText("Compact").assertIsNotEnabled()
    }

    @Test
    fun `the compact button is enabled and calls back when idle`() {
        show(state(usage = TokenUsage(used = 80, limit = 100)))

        compose.onNodeWithText("Compact").assertIsEnabled().performClick()

        assert(compacted == 1) { "expected one compact callback, got $compacted" }
    }

    @Test
    fun `the banner reports progress while compacting instead of offering the button`() {
        show(state(usage = TokenUsage(used = 80, limit = 100), isCompacting = true))

        compose.onNodeWithText("Compacting the conversation…").assertIsDisplayed()
        compose.onNodeWithText("Compact").assertDoesNotExist()
    }

    // MARK: - Composer

    @Test
    fun `a full chat locks the composer and the send button`() {
        show(state(usage = TokenUsage(used = 100, limit = 100)))

        compose.onNodeWithTag(COMPOSER_FIELD_TAG).assertIsNotEnabled()
        compose.onNodeWithContentDescription(SEND_LABEL).assertIsNotEnabled()
    }

    @Test
    fun `the send button is disabled until the draft has content`() {
        show(state())

        compose.onNodeWithContentDescription(SEND_LABEL).assertIsNotEnabled()

        compose.onNodeWithTag(COMPOSER_FIELD_TAG).performTextInput("hello")
        // Recomposition is driven by the frame clock, and this suite drives that by hand.
        compose.mainClock.advanceTimeBy(100)

        compose.onNodeWithContentDescription(SEND_LABEL).assertIsEnabled().performClick()
        assert(sent == listOf("hello")) { "expected the draft to be sent, got $sent" }
    }

    @Test
    fun `while responding the button becomes a stop control and stays tappable`() {
        // `canSend` is false while responding, so gating the button on it alone would strand a
        // runaway generation with no way to halt it.
        show(state(isResponding = true))

        compose.onNodeWithContentDescription(SEND_LABEL).assertDoesNotExist()
        compose.onNodeWithContentDescription(STOP_LABEL).assertIsEnabled().performClick()

        assert(stopped == 1) { "expected one stop callback, got $stopped" }
    }

    // MARK: - Transcript

    @Test
    fun `assistant markdown is parsed and user text stays verbatim`() {
        show(
            state(
                messages = listOf(
                    message(ChatRole.USER, "**not bold** here", 0),
                    message(ChatRole.ASSISTANT, "**bold** here", 1),
                ),
            ),
        )

        compose.onNodeWithText("bold here").assertIsDisplayed()
        compose.onNodeWithText("**not bold** here").assertIsDisplayed()
    }

    @Test
    fun `a compaction summary renders as a divider, never as a bubble`() {
        show(
            state(
                messages = listOf(
                    message(ChatRole.USER, "hello", 0),
                    message(ChatRole.ASSISTANT, "a summary of everything above", 1)
                        .copy(isCompactionSummary = true),
                ),
            ),
        )

        compose.onNodeWithContentDescription(COMPACTION_ACCESSIBILITY_LABEL).assertIsDisplayed()
        compose.onNodeWithText("a summary of everything above").assertDoesNotExist()
        compose.onNodeWithText(COMPACTION_LABEL.uppercase(), useUnmergedTree = true).assertExists()
    }

    @Test
    fun `the thinking indicator shows only for an empty placeholder while responding`() {
        val messages = listOf(
            message(ChatRole.USER, "hello", 0),
            message(ChatRole.ASSISTANT, "", 1),
        )

        show(state(messages = messages, isResponding = true))
        compose.onNodeWithContentDescription(THINKING_LABEL).assertIsDisplayed()
    }

    @Test
    fun `the thinking indicator is absent once the turn is over`() {
        val messages = listOf(
            message(ChatRole.USER, "hello", 0),
            message(ChatRole.ASSISTANT, "", 1),
        )

        show(state(messages = messages, isResponding = false))
        compose.onNodeWithContentDescription(THINKING_LABEL).assertDoesNotExist()
    }

    @Test
    fun `the streaming caret blinks on the reply itself`() {
        // The caret is concatenated into the same text node rather than overlaid, so it wraps with
        // the last line. That is exactly why it shows up in this node's text.
        val messages = listOf(
            message(ChatRole.USER, "hello", 0),
            message(ChatRole.ASSISTANT, "Hi there", 1),
        )
        show(state(messages = messages, isResponding = true), advanceMillis = 16)

        compose.onNodeWithText("Hi there ▍").assertIsDisplayed()

        compose.mainClock.advanceTimeBy(700)
        compose.onNodeWithText("Hi there").assertIsDisplayed()
    }

    @Test
    fun `a finished reply carries no caret`() {
        val messages = listOf(
            message(ChatRole.USER, "hello", 0),
            message(ChatRole.ASSISTANT, "Hi there", 1),
        )
        show(state(messages = messages, isResponding = false), advanceMillis = 16)

        compose.onNodeWithText("Hi there").assertIsDisplayed()
    }

    @Test
    fun `scrolling up by hand reveals the jump-to-bottom button`() {
        // The button is the visible half of the sticky-follow state: it appears only once the
        // transcript is well clear of the bottom, and only a user-driven scroll gets it there.
        val messages = (0 until 30).map { index ->
            message(if (index % 2 == 0) ChatRole.USER else ChatRole.ASSISTANT, "message $index", index.toLong())
        }
        show(state(messages = messages))

        compose.onNodeWithContentDescription(JUMP_TO_BOTTOM_LABEL).assertDoesNotExist()

        compose.onNode(hasScrollAction()).performTouchInput { swipeDown() }
        compose.mainClock.advanceTimeBy(1_000)

        compose.onNodeWithContentDescription(JUMP_TO_BOTTOM_LABEL).assertIsDisplayed()
    }

    @Test
    fun `streamed growth keeps the transcript glued to the bottom`() {
        // A reply growing by several screenfuls must not run off below the viewport: auto-scroll
        // follows it down, so the jump button never appears.
        //
        // HONEST LIMIT: this fails when the follow itself is removed, but NOT when the user-scroll
        // attribution is mutated away into a plain proximity gate. `scrollToItem` is requested at
        // composition time and applied in the same measure pass that grows the row, so there is no
        // frame in which a proximity gate could observe the gap and release the follow. See the
        // note in `Transcript`'s KDoc.
        var reply by mutableStateOf("short")
        val history = (0 until 12).map { message(ChatRole.USER, "message $it", it.toLong()) }
        compose.mainClock.autoAdvance = false
        compose.setContent {
            MaterialTheme {
                ChatContent(
                    state = state(
                        messages = history + message(ChatRole.ASSISTANT, reply, 99),
                        isResponding = true,
                    ),
                    onSend = { sent += it },
                    onStop = { stopped++ },
                    onCompact = { compacted++ },
                    onStartNewChat = { started++ },
                    onDownloadModel = { downloaded++ },
                )
            }
        }
        compose.mainClock.advanceTimeBy(1_000)
        compose.onNodeWithContentDescription(JUMP_TO_BOTTOM_LABEL).assertDoesNotExist()

        reply = List(40) { "streamed line $it" }.joinToString("\n")
        compose.mainClock.advanceTimeBy(1_000)

        compose.onNodeWithContentDescription(JUMP_TO_BOTTOM_LABEL).assertDoesNotExist()
    }

    // MARK: - Model download (Android-only, PORTING.md mandatory drift 2)

    @Test
    fun `a downloadable model offers a download button`() {
        show(state(availabilityMessage = MODEL_DOWNLOADABLE_MESSAGE, modelStatus = ModelStatus.DOWNLOADABLE))

        compose.onNodeWithText("Download").assertIsDisplayed().performClick()

        assert(downloaded == 1) { "expected one download callback, got $downloaded" }
    }

    @Test
    fun `an unsupported device is not offered a download`() {
        show(state(availabilityMessage = UNSUPPORTED_MESSAGE))

        compose.onNodeWithText(UNSUPPORTED_MESSAGE).assertIsDisplayed()
        compose.onNodeWithText("Download").assertDoesNotExist()
    }

    @Test
    fun `a download in flight replaces the button with progress`() {
        show(
            state(
                availabilityMessage = MODEL_DOWNLOADABLE_MESSAGE,
                modelStatus = ModelStatus.DOWNLOADABLE,
                downloadProgress = DownloadProgress.Progress(bytesDownloaded = 5, totalBytes = 10),
            ),
        )

        compose.onNodeWithText("Download").assertDoesNotExist()
    }

    @Test
    fun `a failed download reports the reason and offers a retry`() {
        show(
            state(
                availabilityMessage = MODEL_DOWNLOADABLE_MESSAGE,
                modelStatus = ModelStatus.DOWNLOADABLE,
                downloadProgress = DownloadProgress.Failed("No room on the device."),
            ),
        )

        compose.onNodeWithText("No room on the device.").assertIsDisplayed()
        compose.onNodeWithText("Retry").assertIsDisplayed().performClick()

        assert(downloaded == 1) { "expected one download callback, got $downloaded" }
    }

    // MARK: - Fixtures

    private fun state(
        messages: List<ChatMessage> = listOf(message(ChatRole.USER, "hello", 0)),
        isResponding: Boolean = false,
        isCompacting: Boolean = false,
        availabilityMessage: String? = null,
        modelStatus: ModelStatus? = null,
        downloadProgress: DownloadProgress? = null,
        usage: TokenUsage? = null,
        lastTurn: TurnSignal? = null,
    ) = ChatEngineState(
        conversation = Conversation(messages = messages),
        isResponding = isResponding,
        isCompacting = isCompacting,
        availabilityMessage = availabilityMessage,
        modelStatus = modelStatus,
        downloadProgress = downloadProgress,
        tokenUsage = usage,
        lastTurn = lastTurn,
    )

    private fun message(role: ChatRole, text: String, secondsFromEpoch: Long) = ChatMessage(
        role = role,
        text = text,
        createdAt = Instant.fromEpochSeconds(1_000 + secondsFromEpoch),
    )

    private companion object {
        const val UNSUPPORTED_MESSAGE =
            "This device doesn't support on-device AI, so chat isn't available."
        const val THINKING_LABEL = "Assistant is typing"
    }
}
