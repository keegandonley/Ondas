package com.keegancodes.ondas.features.chat

import androidx.test.core.app.ApplicationProvider
import com.keegancodes.ondas.chat.ChatEngine
import com.keegancodes.ondas.chat.DownloadProgress
import com.keegancodes.ondas.chat.ModelStatus
import com.keegancodes.ondas.chat.OnDeviceModel
import com.keegancodes.ondas.data.ConversationRepository
import com.keegancodes.ondas.data.OndasDatabase
import com.keegancodes.ondas.kit.chat.GenerationSettingsStore
import com.keegancodes.ondas.kit.telemetry.KeyValueStore
import com.keegancodes.ondas.kit.telemetry.OtlpExporter
import com.keegancodes.ondas.kit.telemetry.TelemetryService
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import kotlin.time.Instant

/**
 * Guards the one coupling in this screen that would fail silently.
 *
 * `ChatEngineState` exposes the availability *message* but not the [ModelStatus] behind it, so
 * [UnavailableBanner] can only tell "the model needs downloading" from "this device cannot run it"
 * by comparing against the exact string `ChatEngine` produces. If that string is ever reworded,
 * nothing throws and nothing looks wrong — the Download button just stops appearing on the devices
 * that need it, which is every fresh Pixel (spec #88 measured `DOWNLOADABLE` on a new Pixel 11).
 *
 * These two tests turn that into a build failure. The real fix is for `ChatEngineState` to carry
 * the status; that file is not this spec's to change.
 */
@RunWith(RobolectricTestRunner::class)
class ModelDownloadBannerContractTest {

    private lateinit var database: OndasDatabase
    private lateinit var repository: ConversationRepository
    private val clock = Instant.fromEpochSeconds(1_000)

    private class FakeModel(var status: ModelStatus) : OnDeviceModel {
        override suspend fun status(): ModelStatus = status
        override fun download(): Flow<DownloadProgress> = flow { emit(DownloadProgress.Completed) }
        override suspend fun tokenLimit(): Int = 8192
        override suspend fun countTokens(systemPrompt: String, body: String): Int = 10
        override suspend fun baseModelName(): String = "fake-model"
        override fun stream(
            systemPrompt: String,
            prefix: String?,
            prompt: String,
            temperature: Float,
        ): Flow<String> = flow { emit("") }

        override suspend fun generate(systemPrompt: String, prompt: String, temperature: Float): String = ""
    }

    private class MemoryStore : KeyValueStore {
        private val map = mutableMapOf<String, Any>()
        override fun string(key: String) = map[key] as? String
        override fun boolean(key: String) = map[key] as? Boolean ?: false
        override fun putString(key: String, value: String) { map[key] = value }
        override fun putBoolean(key: String, value: Boolean) { map[key] = value }
    }

    @Before
    fun setUp() {
        database = OndasDatabase.createInMemory(ApplicationProvider.getApplicationContext())
        repository = ConversationRepository(database.conversations(), now = { clock })
    }

    @After
    fun tearDown() = database.close()

    @Test
    fun `the download button's trigger is exactly what ChatEngine emits for DOWNLOADABLE`() = runTest {
        val engine = engine(ModelStatus.DOWNLOADABLE)

        engine.refreshAvailability()

        assertEquals(MODEL_DOWNLOADABLE_MESSAGE, engine.state.value.availabilityMessage)
    }

    @Test
    fun `an unsupported device produces a different message, so it gets no download button`() = runTest {
        val engine = engine(ModelStatus.UNAVAILABLE)

        engine.refreshAvailability()

        val message = engine.state.value.availabilityMessage
        assertNotEquals(MODEL_DOWNLOADABLE_MESSAGE, message)
        // And it is still a banner, not silence — an unsupported device must say so.
        assertNotEquals(null, message)
    }

    private fun kotlinx.coroutines.test.TestScope.engine(status: ModelStatus) = ChatEngine(
        model = FakeModel(status),
        repository = repository,
        telemetry = TelemetryService(OtlpExporter("1.0", OkHttpClient()), modelName = { "fake-model" }),
        settings = GenerationSettingsStore(MemoryStore()),
        scope = this,
        responseTokenReserve = 1024,
        now = { clock },
    )
}
