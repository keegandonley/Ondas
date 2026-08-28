package com.keegancodes.ondas.kit.chat

import com.keegancodes.ondas.kit.telemetry.KeyValueStore

/**
 * The user-facing creativity dial for chat replies.
 *
 * The temperatures are NOT Swift's. Swift maps Precise 0.3, Creative 1.3, and Balanced to `nil`
 * meaning "the model's own default". Spec #88 established on device that ML Kit has no such
 * default — an omitted temperature is exactly greedy 0.0, proved by holding the prompt fixed and
 * varying the seed — and that the legal range is 0..1, which makes Creative's 1.3 an outright
 * `IllegalArgumentException` at request-build time.
 *
 * So only Precise ported unchanged. Balanced 0.7 and Creative 1.0 were chosen by Keegan
 * (2026-08-27) and are recorded as an approved divergence in PORTING.md. Do not "restore"
 * Balanced to an absent temperature: that would silently make it the most deterministic setting
 * of the three.
 */
public enum class ResponseStyle(
    public val raw: String,
    public val temperature: Float,
    public val title: String,
    public val detail: String,
) {
    PRECISE("precise", 0.3f, "Precise", "Lower temperature: more focused, consistent replies."),
    BALANCED("balanced", 0.7f, "Balanced", "A middle setting between focused and exploratory."),
    CREATIVE("creative", 1.0f, "Creative", "Higher temperature: more varied, exploratory replies."),
    ;

    public companion object {
        public val DEFAULT: ResponseStyle = BALANCED

        public fun fromRaw(raw: String?): ResponseStyle =
            entries.firstOrNull { it.raw == raw } ?: DEFAULT
    }
}

/** Persists the response style. Key matches the Swift original. */
public class GenerationSettingsStore(private val defaults: KeyValueStore) {

    public fun load(): ResponseStyle = ResponseStyle.fromRaw(defaults.string(KEY))

    public fun save(style: ResponseStyle) {
        defaults.putString(KEY, style.raw)
    }

    public companion object {
        public const val KEY: String = "generation.responseStyle"
    }
}
