import type { CapacityConstants } from "./ChatEngine";

/**
 * The measured capacity constants for Chrome's on-device model.
 *
 * PORTING.md § Awaiting approval **D3** required these to be *re-derived* from the compaction
 * summariser's measured headroom rather than inherited from Swift or rescaled to the new window.
 * That measurement was taken on Chrome 152 / macOS on 2026-08-28, against the real
 * `SUMMARY_INSTRUCTIONS` and a synthetic alternating-turn transcript.
 *
 * ## What was measured
 *
 * Feed the summariser a growing transcript and find where it refuses:
 *
 * | Summariser body | Result |
 * |---|---|
 * | 6430 tokens | summarised (201-token summary) |
 * | **8570 tokens** | **summarised (132-token summary) — largest success** |
 * | 8998 tokens | `QuotaExceededError` |
 *
 * Context window: **9216**. So the summariser's one-pass ceiling sits between 8570 and 8998, and
 * 8570 is the largest value actually observed to work.
 *
 * ## What that implies, and why 0.8 survives
 *
 * The reserve and the warning fraction are both standing in for one question: *when the banner
 * offers compaction, can the summariser still condense the live segment in a single pass?*
 *
 *   limit         = 9216 − 1024 = 8192
 *   warning point = 0.8 × 8192  = 6554 tokens of context
 *
 * 6554 is comfortably below the 8570 ceiling — roughly 2000 tokens, about 23%, of margin. That
 * margin is not decoration: the measurement used one transcript shape, and prose that tokenises
 * less densely (code, non-Latin scripts, long URLs) will reach the ceiling at fewer *characters*.
 *
 * So Swift's 0.8 is kept — but it is now **kept because it was measured to be safe here**, not
 * inherited. That distinction matters: on Android the same exercise killed the inherited value
 * (see `android/PORTING.md` § A2, where measurement showed the ported temperature was illegal).
 * Here it survived. A number that is re-derived and lands on the same value is a different fact
 * from a number nobody checked.
 *
 * **Re-measure if the window changes.** Chrome ships model revisions with no version signal, so
 * `contextWindow` is read at runtime everywhere; these two constants are the only place a stale
 * assumption could hide. The probe route at `/probe` reproduces the measurement.
 */
export const MEASURED_CAPACITY: CapacityConstants = {
  /**
   * Swift's value, retained after measurement rather than by default.
   *
   * Observed replies in the spike ran 125–201 tokens, and chat replies are bounded by the "answer
   * conversationally and concisely" instruction, so 1024 is roughly five times the largest reply
   * actually seen. Lowering it would buy context the warning band does not need; raising it would
   * push the warning point down for no measured reason.
   */
  responseTokenReserve: 1024,
};
