/**
 * Port of the three value types at the top of `Ondas/Services/ChatEngine.swift` (lines 7-48).
 * The engine itself is spec W6; these are here because they are pure, and because
 * `Conversation.capacityState` depends on them (PORTING.md § Module graph maps `TokenUsage` to
 * `src/kit/chat/`). Same split Android made in `chat/TokenUsage.kt`.
 */

/**
 * A snapshot of how much of the on-device model's context window a conversation is using.
 * `used` and `limit` are token counts; `limit` is the context window minus a reserve kept free for
 * the model's reply. Drives the in-chat token meter and the token-based capacity cap.
 *
 * The arithmetic here is window-independent, which is why it ports unchanged even though Chrome's
 * window (9216, measured — see PORTING.md § The verified Prompt API surface) is more than double
 * the ~4096 the Swift app was tuned against. What does NOT port is the calibration of the reserve
 * and the warning fraction — see `warningFraction`.
 */
export interface TokenUsage {
  readonly used: number;
  readonly limit: number;
}

export const TokenUsage = {
  /**
   * Fraction of the budget at/after which the chat warns and offers compaction. Set below 1 so
   * compaction is offered while there is still headroom to summarize the live turns in one pass —
   * once the window is truly full the summarizer itself would overflow, so it is not offered then.
   *
   * PROVISIONAL. 0.8 is carried over from Swift, where it was calibrated against a ~4096-token
   * window; the web's is 9216. PORTING.md § Awaiting approval **D3** records that this must be
   * RE-DERIVED from the compaction summarizer's measured headroom during spec W6, not inherited
   * and not rescaled. Do not build new behaviour on the specific number. (`android/.../TokenUsage.kt`
   * carries the identical caveat for its own 8192 window.)
   */
  warningFraction: 0.8,

  /** 0...1 share of the usable budget consumed, for the meter's progress bar. */
  fraction(usage: TokenUsage): number {
    // Guards divide-by-zero when the context window cannot be determined.
    if (usage.limit <= 0) return 0;
    return Math.min(1, usage.used / usage.limit);
  },

  /** True once the conversation has consumed its usable token budget and can take no more turns. */
  isAtCapacity(usage: TokenUsage): boolean {
    return usage.used >= usage.limit;
  },

  /**
   * True in the warning band: near the budget but not yet full, so the chat still accepts input
   * while nudging the user to compact.
   */
  isApproachingCapacity(usage: TokenUsage): boolean {
    return TokenUsage.fraction(usage) >= TokenUsage.warningFraction && !TokenUsage.isAtCapacity(usage);
  },
} as const;

/**
 * How close a conversation is to the model's context budget, driving the composer and banner.
 * `approaching` warns and offers compaction while still accepting input; `full` blocks input and
 * offers only a fresh chat — by then the conversation is too large to summarize reliably.
 *
 * Swift's `enum CapacityState` has no raw values; string literals are the TypeScript encoding that
 * keeps the case names visible in a debugger and in a persisted snapshot.
 */
export type CapacityState = "normal" | "approaching" | "full";

export const CapacityState = {
  normal: "normal",
  approaching: "approaching",
  full: "full",
} as const;

/**
 * A marker of the most recently finished model turn, so the UI can react to completion. `id`
 * changes on every turn (making it a usable change trigger); `failed` distinguishes an error turn
 * from a normal reply.
 *
 * Swift drives `sensoryFeedback` off this — a haptic. The web has no equivalent guaranteed
 * affordance, but the type is the engine's turn-completion signal regardless of what the UI does
 * with it, so it ports here and spec W7 decides the presentation.
 */
export interface TurnSignal {
  readonly id: number;
  readonly failed: boolean;
}
