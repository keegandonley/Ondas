import type { ChatMessage } from "../models/ChatMessage";

/**
 * Port of `Ondas/Services/Compaction.swift`.
 *
 * Pure helpers for conversation compaction — the "Continue" flow that summarizes a full chat into a
 * divider and keeps going in the *same* conversation (same `id`, so the telemetry `session.id`
 * stays continuous). These operate on a conversation's already-ordered message list and hold no
 * model or storage dependencies, so they are unit-testable without the on-device model.
 *
 * Model of a compacted conversation: a compaction marker (`ChatMessage.isCompactionSummary`)
 * carries a summary of everything before it and is **appended at the end** of the chat when the
 * user taps Continue. So the marker renders as a divider right at the seam: every turn above it is
 * summarized history (still on screen, but no longer fed to the model), and the chat resumes below
 * it. The model continues from the summary alone — no verbatim tail is kept — which keeps the
 * divider legible at the bottom and the reduction unambiguous.
 */
export const Compaction = {
  /**
   * Index of the most recent compaction marker in an ordered message list, or `undefined` when the
   * conversation has never been compacted. (Swift returns `Int?`; `undefined` is the JS nil.)
   */
  lastMarkerIndex(ordered: readonly ChatMessage[]): number | undefined {
    const index = ordered.findLastIndex((message) => message.isCompactionSummary);
    return index >= 0 ? index : undefined;
  },

  /** The active summary (the last marker's text), or `undefined` when uncompacted. */
  activeSummary(ordered: readonly ChatMessage[]): string | undefined {
    const index = Compaction.lastMarkerIndex(ordered);
    return index === undefined ? undefined : ordered[index]?.text;
  },

  /**
   * The real (non-error, non-marker) turns after the last marker — all real turns when uncompacted.
   * This is exactly what still feeds the model, and what the capacity budget grows against, so a
   * compaction empties it and the chat is no longer stuck at capacity. It is also the set
   * summarized by the next compaction.
   */
  liveMessages(ordered: readonly ChatMessage[]): ChatMessage[] {
    const marker = Compaction.lastMarkerIndex(ordered);
    const start = marker === undefined ? 0 : marker + 1;
    return ordered.slice(start).filter(isRealTurn);
  },

  /**
   * The message count the capacity fallback compares against `Conversation.messageLimit`: the live
   * turns since the last compaction. (Token counting is the primary budget when available.)
   */
  capacityCount(ordered: readonly ChatMessage[]): number {
    return Compaction.liveMessages(ordered).length;
  },
} as const;

/**
 * A real chat turn: neither an app-generated error notice nor a compaction marker. Both are
 * excluded from everything the model sees and from the capacity budget.
 *
 * Module-private, as Swift's `private static func isRealTurn` is.
 */
function isRealTurn(message: ChatMessage): boolean {
  return !message.isError && !message.isCompactionSummary;
}
