package com.keegancodes.ondas.chat

import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.prompt.GenerateContentRequest
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.GenerativeModel
import com.google.mlkit.genai.prompt.PromptPrefix
import com.google.mlkit.genai.prompt.SystemInstruction
import com.google.mlkit.genai.prompt.TextPart
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/**
 * [OnDeviceModel] on ML Kit's GenAI Prompt API (Gemini Nano).
 *
 * Everything surprising here was established on device in the spec #88 spike; see
 * PORTING.md § "Spec #88 findings" before changing any of it.
 */
public class MlKitModel(
    private val client: GenerativeModel = Generation.getClient(),
) : OnDeviceModel {

    override suspend fun status(): ModelStatus = when (client.checkStatus()) {
        FeatureStatus.AVAILABLE -> ModelStatus.AVAILABLE
        FeatureStatus.DOWNLOADABLE -> ModelStatus.DOWNLOADABLE
        FeatureStatus.DOWNLOADING -> ModelStatus.DOWNLOADING
        else -> ModelStatus.UNAVAILABLE
    }

    override fun download(): Flow<DownloadProgress> = client.download().map { status ->
        when (status) {
            is DownloadStatus.DownloadStarted -> DownloadProgress.Started
            is DownloadStatus.DownloadProgress ->
                DownloadProgress.Progress(status.totalBytesDownloaded, null)
            is DownloadStatus.DownloadCompleted -> DownloadProgress.Completed
            is DownloadStatus.DownloadFailed -> DownloadProgress.Failed(status.toString())
            else -> DownloadProgress.Started
        }
    }

    override suspend fun tokenLimit(): Int = translating { client.getTokenLimit() }

    override suspend fun countTokens(systemPrompt: String, body: String): Int = translating {
        val request = if (systemPrompt.isEmpty()) {
            GenerateContentRequest.Builder(TextPart(body)).build()
        } else {
            GenerateContentRequest.Builder(SystemInstruction(systemPrompt), TextPart(body)).build()
        }
        client.countTokens(request).totalTokens
    }

    override fun stream(
        systemPrompt: String,
        prefix: String?,
        prompt: String,
        temperature: Float,
    ): Flow<String> =
        client.generateContentStream(request(systemPrompt, prefix, prompt, temperature))
            // DELTAS, not cumulative snapshots. The caller concatenates.
            .map { response -> response.candidates.firstOrNull()?.text.orEmpty() }

    override suspend fun generate(
        systemPrompt: String,
        prompt: String,
        temperature: Float,
    ): String = translating {
        client.generateContent(request(systemPrompt, null, prompt, temperature))
            .candidates.firstOrNull()?.text.orEmpty()
    }

    override suspend fun baseModelName(): String = translating { client.getBaseModelName() }

    private fun request(
        systemPrompt: String,
        prefix: String?,
        prompt: String,
        temperature: Float,
    ): GenerateContentRequest =
        GenerateContentRequest.Builder(SystemInstruction(systemPrompt), TextPart(prompt)).apply {
            // Legal range is 0..1, enforced with an IllegalArgumentException at BUILD time -- note
            // that is not a GenAiException, so a catch written for the ML Kit error type misses it.
            // Coerced rather than trusted: ResponseStyle is in range today, and a future style that
            // is not should not crash the app.
            this.temperature = temperature.coerceIn(0f, 1f)
            // The stable leading portion of the conversation, so AICore can reuse its intermediate
            // state instead of reprocessing the whole history every turn (~25-30% faster measured).
            if (!prefix.isNullOrEmpty()) promptPrefix = PromptPrefix(prefix)
        }.build()

    /** Maps ML Kit's error codes onto the classified [ModelException] the engine switches on. */
    private inline fun <T> translating(body: () -> T): T = try {
        body()
    } catch (error: GenAiException) {
        throw ModelException(kindOf(error.errorCode), labelOf(error.errorCode), error)
    }

    private fun kindOf(code: Int): ModelException.Kind = when (code) {
        GenAiException.ErrorCode.REQUEST_TOO_LARGE -> ModelException.Kind.REQUEST_TOO_LARGE
        POLICY_CHECK_FAILED -> ModelException.Kind.POLICY_REFUSAL
        GenAiException.ErrorCode.NOT_AVAILABLE -> ModelException.Kind.NOT_AVAILABLE
        GenAiException.ErrorCode.BUSY -> ModelException.Kind.BUSY
        GenAiException.ErrorCode.BACKGROUND_USE_BLOCKED -> ModelException.Kind.BACKGROUND_BLOCKED
        GenAiException.ErrorCode.PER_APP_BATTERY_USE_QUOTA_EXCEEDED -> ModelException.Kind.QUOTA_EXCEEDED
        GenAiException.ErrorCode.NEEDS_SYSTEM_UPDATE -> ModelException.Kind.NEEDS_SYSTEM_UPDATE
        GenAiException.ErrorCode.NOT_ENOUGH_DISK_SPACE -> ModelException.Kind.NOT_ENOUGH_DISK_SPACE
        else -> ModelException.Kind.UNKNOWN
    }

    /** A stable, CONTENT-FREE label. Never include the message: it can echo prompt fragments. */
    private fun labelOf(code: Int): String = "GenAiException.$code"

    private companion object {
        /**
         * "Generated response doesn't pass certain policy check." The counterpart of Apple's
         * `.guardrailViolation` / `.refusal`, and there is no named constant for it in the SDK.
         * Easier to hit than expected — it fired on "write a one-sentence story about a fox".
         */
        const val POLICY_CHECK_FAILED = 11
    }
}
