package com.keegancodes.ondas.features.chat

import androidx.compose.ui.test.junit4.createComposeRule
import com.keegancodes.ondas.chat.ChatEngineState
import com.keegancodes.ondas.chat.ModelStatus
import com.keegancodes.ondas.design.OndasTheme
import com.keegancodes.ondas.kit.chat.TokenUsage
import com.keegancodes.ondas.kit.models.ChatMessage
import com.keegancodes.ondas.kit.models.ChatRole
import com.keegancodes.ondas.kit.models.Conversation
import com.keegancodes.ondas.testing.PHONE_QUALIFIERS
import com.keegancodes.ondas.testing.ROBOLECTRIC_SDK
import com.keegancodes.ondas.testing.captureToPng
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.time.Instant

/**
 * Renders the chat screen's meaningful states to PNGs so they can be looked at without a device.
 *
 * These assert only that a non-blank image was produced — the value is the artifact in
 * `app/build/screenshots/`, not the assertion. A test that tried to assert "looks right" would
 * either be a pixel-diff needing golden files, or a lie.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = PHONE_QUALIFIERS, sdk = [ROBOLECTRIC_SDK])
class ChatScreenshotTest {

    @get:Rule
    val compose = createComposeRule()

    private fun at(seconds: Long) = Instant.fromEpochSeconds(seconds)

    private fun conversation(vararg messages: ChatMessage) = Conversation(
        title = "Plan a trip to Lisbon",
        createdAt = at(0),
        messages = messages.toList(),
    )

    private val exchange = arrayOf(
        ChatMessage(role = ChatRole.USER, text = "hello", createdAt = at(1)),
        ChatMessage(
            role = ChatRole.ASSISTANT,
            text = "Hello there! How can I help you today?",
            createdAt = at(2),
        ),
        ChatMessage(role = ChatRole.USER, text = "what are you?", createdAt = at(3)),
        ChatMessage(
            role = ChatRole.ASSISTANT,
            text = "I'm **Ondas**, a helpful assistant running entirely on your device.",
            createdAt = at(4),
        ),
    )

    private fun capture(name: String, state: ChatEngineState) {
        val file = compose.captureToPng(name) {
            OndasTheme {
                ChatContent(
                    state = state,
                    onSend = {},
                    onStop = {},
                    onCompact = {},
                    onStartNewChat = {},
                    onDownloadModel = {},
                )
            }
        }
        assertTrue("no image written for $name", file.exists() && file.length() > 0)
    }

    @Test
    fun `a normal conversation with the token meter`() {
        capture(
            "chat-normal",
            ChatEngineState(
                conversation = conversation(*exchange),
                tokenUsage = TokenUsage(used = 89, limit = 7168),
            ),
        )
    }

    @Test
    fun `the capacity warning band, offering compaction`() {
        capture(
            "chat-approaching",
            ChatEngineState(
                conversation = conversation(*exchange),
                tokenUsage = TokenUsage(used = 6000, limit = 7168),
            ),
        )
    }

    @Test
    fun `a full chat, composer locked`() {
        capture(
            "chat-full",
            ChatEngineState(
                conversation = conversation(*exchange),
                tokenUsage = TokenUsage(used = 7200, limit = 7168),
            ),
        )
    }

    @Test
    fun `the model-download banner a fresh device sees`() {
        capture(
            "chat-downloadable",
            ChatEngineState(
                conversation = conversation(),
                availabilityMessage = MODEL_DOWNLOADABLE_MESSAGE,
                modelStatus = ModelStatus.DOWNLOADABLE,
            ),
        )
    }

    @Test
    fun `a compacted conversation, divider at the seam`() {
        capture(
            "chat-compacted",
            ChatEngineState(
                conversation = conversation(
                    *exchange,
                    ChatMessage(
                        role = ChatRole.ASSISTANT,
                        text = "The user asked about Ondas and how it works.",
                        createdAt = at(5),
                        isCompactionSummary = true,
                    ),
                ),
                tokenUsage = TokenUsage(used = 120, limit = 7168),
            ),
        )
    }

    @Test
    fun `a streaming reply mid-flight`() {
        val placeholder = ChatMessage(role = ChatRole.ASSISTANT, text = "", createdAt = at(5))
        capture(
            "chat-streaming",
            ChatEngineState(
                conversation = conversation(*exchange, placeholder),
                isResponding = true,
                streamingMessageId = placeholder.id,
                streamingText = "Lisbon is a great choice — the light in",
                tokenUsage = TokenUsage(used = 300, limit = 7168),
            ),
        )
    }
}
