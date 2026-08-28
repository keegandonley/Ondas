package com.keegancodes.ondas.ui

import androidx.activity.ComponentActivity
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.junit4.AndroidComposeTestRule
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import com.keegancodes.ondas.chat.ChatEngine
import com.keegancodes.ondas.chat.DownloadProgress
import com.keegancodes.ondas.chat.ModelStatus
import com.keegancodes.ondas.chat.OnDeviceModel
import com.keegancodes.ondas.data.ConversationRepository
import com.keegancodes.ondas.data.OndasDatabase
import com.keegancodes.ondas.features.conversations.CHATS_TITLE
import com.keegancodes.ondas.features.conversations.ConversationListModel
import com.keegancodes.ondas.features.conversations.SETTINGS_ACTION
import com.keegancodes.ondas.features.conversations.rowTag
import com.keegancodes.ondas.features.settings.SETTINGS_TITLE
import com.keegancodes.ondas.features.settings.SettingsController
import com.keegancodes.ondas.features.settings.TELEMETRY_LABEL
import com.keegancodes.ondas.kit.chat.GenerationSettingsStore
import com.keegancodes.ondas.kit.models.ChatMessage
import com.keegancodes.ondas.kit.models.ChatRole
import com.keegancodes.ondas.kit.models.Conversation
import com.keegancodes.ondas.kit.telemetry.KeyValueStore
import com.keegancodes.ondas.kit.telemetry.OtlpExporter
import com.keegancodes.ondas.kit.telemetry.SecretStore
import com.keegancodes.ondas.kit.telemetry.TelemetryService
import com.keegancodes.ondas.kit.telemetry.TelemetrySettingsStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import okhttp3.Call
import okhttp3.Request
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.time.Instant

/**
 * The shell: the adaptive list/detail scaffold, the settings presentation, and the selection
 * lifecycle. `NavigationSplitView` gives SwiftUI two columns on a tablet and a push stack on a
 * phone from one declaration, so both window sizes are exercised here rather than only the one
 * that happens to be the default.
 */
@RunWith(RobolectricTestRunner::class)
class OndasAppTest {

    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private lateinit var database: OndasDatabase
    private lateinit var repository: ConversationRepository
    private val preferences = MemoryStore()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    @Before
    fun setUp() {
        database = OndasDatabase.createInMemory(ApplicationProvider.getApplicationContext())
        repository = ConversationRepository(database.conversations())
    }

    @After
    fun tearDown() {
        scope.cancel()
        database.close()
    }

    private fun seed(title: String, text: String): Conversation = runBlocking {
        val conversation = repository.createConversation()
        repository.rename(conversation.id, title)
        repository.appendMessage(
            conversation.id,
            ChatMessage(
                role = ChatRole.USER,
                text = text,
                createdAt = Instant.fromEpochSeconds(1_000),
            ),
        )
        repository.conversation(conversation.id)!!
    }

    private fun AndroidComposeTestRule<*, ComponentActivity>.renderApp() {
        val telemetry = TelemetryService(OtlpExporter("1.0", NoNetwork), modelName = { "fake-model" })
        val listModel = ConversationListModel(repository, scope)
        val settings = SettingsController(
            telemetrySettings = TelemetrySettingsStore(preferences, MemorySecrets()),
            generationSettings = GenerationSettingsStore(preferences),
            telemetry = telemetry,
            scope = scope,
        )
        setContent {
            MaterialTheme {
                OndasApp(
                    listModel = listModel,
                    repository = repository,
                    settings = settings,
                    createEngine = {
                        ChatEngine(
                            model = FakeModel,
                            repository = repository,
                            telemetry = telemetry,
                            settings = GenerationSettingsStore(preferences),
                            scope = scope,
                            responseTokenReserve = 1024,
                        )
                    },
                )
            }
        }
    }

    // -- two panes -----------------------------------------------------------------------------

    @Test
    @Config(qualifiers = "w840dp-h1280dp")
    fun `a wide window shows the list beside a Pick a Chat detail column`() {
        seed("Poetry", "write me a haiku")
        compose.renderApp()
        compose.waitForIdle()

        compose.onNodeWithText(CHATS_TITLE).assertExists()
        compose.onNodeWithText("Poetry").assertExists()
        compose.onNodeWithText(NO_SELECTION_TITLE).assertExists()
        compose.onNodeWithText(NO_SELECTION_DESCRIPTION).assertExists()
    }

    @Test
    @Config(qualifiers = "w840dp-h1280dp")
    fun `selecting a conversation replaces the placeholder with the chat pane`() {
        val conversation = seed("Poetry", "write me a haiku")
        compose.renderApp()
        compose.waitForIdle()

        compose.onNodeWithTag(rowTag(conversation.id)).performClick()
        compose.waitForIdle()

        compose.onNodeWithText(NO_SELECTION_TITLE).assertDoesNotExist()
        // The list column is still there beside it -- this is the two-pane layout.
        compose.onNodeWithText(CHATS_TITLE).assertExists()
    }

    // -- one pane ------------------------------------------------------------------------------

    @Test
    @Config(qualifiers = "w411dp-h891dp")
    fun `a phone window shows only the list until a conversation is picked`() {
        val conversation = seed("Poetry", "write me a haiku")
        compose.renderApp()
        compose.waitForIdle()

        compose.onNodeWithText(CHATS_TITLE).assertExists()
        // Single pane: no detail column, so no placeholder either.
        compose.onNodeWithText(NO_SELECTION_TITLE).assertDoesNotExist()

        compose.onNodeWithTag(rowTag(conversation.id)).performClick()
        compose.waitForIdle()

        // The list is pushed off; the chat is what is on screen.
        compose.onNodeWithText(CHATS_TITLE).assertDoesNotExist()
    }

    /**
     * On a phone the system back gesture pops the detail while the SELECTION stays put, the way
     * `NavigationSplitView` behaves on iPhone. Tapping the same row again therefore does not change
     * `selectedId`, so re-opening it cannot be left to a selection-keyed effect — the second tap
     * would silently do nothing.
     */
    @Test
    @Config(qualifiers = "w411dp-h891dp")
    fun `re-tapping the conversation just backed out of opens it again`() {
        val conversation = seed("Poetry", "write me a haiku")
        compose.renderApp()
        compose.waitForIdle()

        compose.onNodeWithTag(rowTag(conversation.id)).performClick()
        compose.waitForIdle()
        compose.onNodeWithText(CHATS_TITLE).assertDoesNotExist()

        compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.waitForIdle()
        compose.onNodeWithText(CHATS_TITLE).assertExists()

        compose.onNodeWithTag(rowTag(conversation.id)).performClick()
        compose.waitForIdle()
        compose.onNodeWithText(CHATS_TITLE).assertDoesNotExist()
    }

    // -- settings ------------------------------------------------------------------------------

    @Test
    @Config(qualifiers = "w411dp-h891dp")
    fun `the app bar gear opens the settings sheet`() {
        compose.renderApp()
        compose.waitForIdle()

        compose.onNodeWithText(SETTINGS_TITLE).assertDoesNotExist()
        compose.onNodeWithContentDescription(SETTINGS_ACTION).performClick()
        compose.waitForIdle()

        compose.onNodeWithText(SETTINGS_TITLE).assertExists()
        compose.onNodeWithText(TELEMETRY_LABEL).assertExists()
    }

    /** Never consulted beyond availability here; the chat surface has its own suite. */
    private object FakeModel : OnDeviceModel {
        override suspend fun status(): ModelStatus = ModelStatus.AVAILABLE
        override fun download(): Flow<DownloadProgress> = flow { emit(DownloadProgress.Completed) }
        override suspend fun tokenLimit(): Int = 8192
        override suspend fun countTokens(systemPrompt: String, body: String): Int = 10
        override fun stream(
            systemPrompt: String,
            prefix: String?,
            prompt: String,
            temperature: Float,
        ): Flow<String> = flow { emit("hello") }
        override suspend fun generate(
            systemPrompt: String,
            prompt: String,
            temperature: Float,
        ): String = "SUMMARY"
        override suspend fun baseModelName(): String = "fake-model"
    }

    private object NoNetwork : Call.Factory {
        override fun newCall(request: Request): Call =
            throw AssertionError("a unit test must not open a connection")
    }

    private class MemoryStore : KeyValueStore {
        private val map = mutableMapOf<String, Any>()
        override fun string(key: String) = map[key] as? String
        override fun boolean(key: String) = map[key] as? Boolean ?: false
        override fun putString(key: String, value: String) { map[key] = value }
        override fun putBoolean(key: String, value: Boolean) { map[key] = value }
    }

    private class MemorySecrets : SecretStore {
        private val map = mutableMapOf<String, String>()
        override fun secret(account: String): String? = map[account]
        override fun setSecret(value: String?, account: String) {
            if (value.isNullOrEmpty()) map.remove(account) else map[account] = value
        }
    }
}
