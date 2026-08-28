package com.keegancodes.ondas.chat

import kotlinx.coroutines.flow.Flow

/**
 * The on-device model, behind an interface.
 *
 * Swift talks to `SystemLanguageModel` directly because a `LanguageModelSession` is cheap to build
 * and Apple's types are available in the test host. Neither is true here: Gemini Nano exists only
 * where AICore does, so an interface is the only way [ChatEngine]'s turn orchestration — the
 * cancellation discipline, the capacity model, the compaction generation guard, every part of it
 * that encodes a fixed bug — can be tested without a physical device.
 */
public interface OnDeviceModel {

    public suspend fun status(): ModelStatus

    /** Emits progress while AICore fetches the model. Terminal states end the flow. */
    public fun download(): Flow<DownloadProgress>

    /** The model's full context window, before any reply reserve is held back. */
    public suspend fun tokenLimit(): Int

    /**
     * Tokens the given request would occupy. Counts the system instruction too, verified in the
     * spec #88 spike (18 tokens bare, 34 with an instruction attached).
     */
    public suspend fun countTokens(systemPrompt: String, body: String): Int

    /**
     * Streams a reply. **Chunks are DELTAS**, not cumulative snapshots — spec #88 verified this on
     * device, and it is the single most consequential difference from Apple's `ResponseStream`,
     * where each snapshot carries the whole reply so far. Callers concatenate.
     */
    public fun stream(
        systemPrompt: String,
        prefix: String?,
        prompt: String,
        temperature: Float,
    ): Flow<String>

    /** One-shot generation, used by the compaction summariser. */
    public suspend fun generate(systemPrompt: String, prompt: String, temperature: Float): String

    /** Reported to telemetry as `llm.model_name`. */
    public suspend fun baseModelName(): String
}

/** Mirrors ML Kit's `FeatureStatus`. */
public enum class ModelStatus { UNAVAILABLE, DOWNLOADABLE, DOWNLOADING, AVAILABLE }

public sealed interface DownloadProgress {
    public data object Started : DownloadProgress
    public data class Progress(val bytesDownloaded: Long, val totalBytes: Long?) : DownloadProgress
    public data object Completed : DownloadProgress
    public data class Failed(val message: String?) : DownloadProgress
}

/**
 * A model failure, already classified. Keeps [ChatEngine] free of ML Kit types so it stays testable,
 * and gives the curated-message mapping something stable to switch on.
 *
 * The cases are the ML Kit error codes that Ondas has a curated message for, catalogued on device
 * in spec #88. Note `POLICY_REFUSAL` (code 11) exists and is easy to trigger — an early spike run
 * hit it on "write a one-sentence story about a fox".
 */
public class ModelException(
    public val kind: Kind,
    public val diagnosticLabel: String,
    cause: Throwable? = null,
) : Exception(null, cause) {
    public enum class Kind {
        REQUEST_TOO_LARGE,
        POLICY_REFUSAL,
        NOT_AVAILABLE,
        BUSY,
        BACKGROUND_BLOCKED,
        QUOTA_EXCEEDED,
        NEEDS_SYSTEM_UPDATE,
        NOT_ENOUGH_DISK_SPACE,
        UNKNOWN,
    }
}
