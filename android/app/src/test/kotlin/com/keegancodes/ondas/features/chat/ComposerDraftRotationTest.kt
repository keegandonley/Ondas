package com.keegancodes.ondas.features.chat

import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTextInput
import com.keegancodes.ondas.chat.ChatEngineState
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
 * The composer draft must survive a configuration change.
 *
 * `MainActivity` declares no `configChanges`, so a rotation destroys and recreates the whole
 * Compose tree. A plain `remember` drops whatever the user had typed but not sent — a regression
 * against Swift, where the composer survives rotation for free.
 *
 * Found in review, not by a test: nothing in the suite exercised a recreate cycle at all, which is
 * why a whole class of state-restoration bugs could pass unnoticed.
 *
 * Note there are TWO `StateRestorationTester` classes. The one in `...ui.test.junit4` takes the
 * test rule and has `emulateSavedInstanceStateRestore()`; the one in `...ui.test` takes a
 * `ComposeUiTest` and does not.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w411dp-h891dp")
class ComposerDraftRotationTest {

    @get:Rule
    val compose = createComposeRule()

    private fun state() = ChatEngineState(
        conversation = Conversation(
            createdAt = Instant.fromEpochSeconds(0),
            messages = listOf(
                ChatMessage(
                    role = ChatRole.USER,
                    text = "hello",
                    createdAt = Instant.fromEpochSeconds(1),
                ),
            ),
        ),
    )

    @Test
    fun `an unsent draft survives a configuration change`() {
        val restorer = StateRestorationTester(compose)
        restorer.setContent {
            ChatContent(
                state = state(),
                onSend = {},
                onStop = {},
                onCompact = {},
                onStartNewChat = {},
                onDownloadModel = {},
            )
        }

        compose.onNodeWithTag("composer-field").performTextInput("half a thought")
        compose.waitForIdle()

        restorer.emulateSavedInstanceStateRestore()

        compose.onNodeWithTag("composer-field").assertTextContains("half a thought")
    }
}
