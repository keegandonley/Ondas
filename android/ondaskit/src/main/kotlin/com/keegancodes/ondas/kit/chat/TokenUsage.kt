package com.keegancodes.ondas.kit.chat

/**
 * A snapshot of how much of the on-device model's context window a conversation is using.
 * [used] and [limit] are token counts; [limit] is the context window minus a reserve kept free
 * for the model's reply.
 *
 * The arithmetic here is window-independent, which is why it ports unchanged even though Nano's
 * window (8192) is double the one the Swift app was tuned against. What does NOT port is the
 * reserve and the warning fraction's calibration — see [WARNING_FRACTION].
 */
public data class TokenUsage(
    public val used: Int,
    public val limit: Int,
) {
    /** 0..1 share of the usable budget consumed, for the meter's progress bar. */
    public val fraction: Double
        get() = if (limit > 0) minOf(1.0, used.toDouble() / limit.toDouble()) else 0.0

    /** True once the conversation has consumed its usable budget and can take no more turns. */
    public val isAtCapacity: Boolean
        get() = used >= limit

    /**
     * True in the warning band: near the budget but not yet full, so the chat still accepts input
     * while nudging the user to compact.
     */
    public val isApproachingCapacity: Boolean
        get() = fraction >= WARNING_FRACTION && !isAtCapacity

    public companion object {
        /**
         * Fraction of the budget at/after which the chat warns and offers compaction. Set below 1
         * so compaction is offered while there is still headroom to summarise the live turns in
         * one pass — once the window is truly full the summariser itself would overflow, so it is
         * not offered then.
         *
         * 0.8 is carried over from Swift, where it was calibrated against a ~4096-token window.
         * Nano's is 8192. PORTING.md § Awaiting approval A1 records Keegan's decision to
         * RE-DERIVE this from the compaction summariser's measured headroom at spec #92 rather
         * than inherit it — so treat this value as provisional, and do not build new behaviour
         * on the specific number.
         */
        public const val WARNING_FRACTION: Double = 0.8
    }
}

/**
 * How close a conversation is to the model's context budget, driving the composer and banners.
 * `APPROACHING` warns and offers compaction while still accepting input; `FULL` blocks input and
 * offers only a fresh chat — by then the conversation is too large to summarise reliably.
 */
public enum class CapacityState {
    NORMAL,
    APPROACHING,
    FULL,
}

/**
 * A marker of the most recently finished model turn, so the UI can fire a completion haptic.
 * [id] changes on every turn, making it usable as a change trigger; [failed] distinguishes an
 * error turn from a normal reply.
 */
public data class TurnSignal(
    public val id: Int,
    public val failed: Boolean,
)
