import { describe, expect, it } from "vitest";

import { Compaction } from "./Compaction";
import { ChatMessage } from "../models/ChatMessage";
import type { ChatRole } from "../models/ChatRole";

/**
 * Ports the `// MARK: Compaction` cases of `OndasTests/OndasTests.swift` (lines 129-176), one for
 * one. Swift's `conversationCapacityStateCrossesApproachingThenFull` (`:185`) reads `Conversation`,
 * so it is ported in `models/Conversation.test.ts`.
 */

/** Swift's `msg(_:_:at:)` helper: a message at a fixed offset so ordered arrays are unambiguous. */
function msg(
  role: ChatRole,
  text: string,
  at: number,
  options: { isError?: boolean; isCompactionSummary?: boolean } = {},
): ChatMessage {
  return ChatMessage.make({
    role,
    text,
    createdAt: new Date(at * 1000),
    ...options,
  });
}

const texts = (messages: readonly ChatMessage[]): string[] => messages.map(({ text }) => text);

describe("Compaction", () => {
  it("treats every real turn as live when uncompacted", () => {
    const ordered = [msg("user", "a", 0), msg("assistant", "b", 1)];

    expect(Compaction.activeSummary(ordered)).toBeUndefined();
    expect(Compaction.capacityCount(ordered)).toBe(2);
    expect(texts(Compaction.liveMessages(ordered))).toEqual(["a", "b"]);
  });

  it("excludes error notices from live messages and capacity", () => {
    const ordered = [
      msg("user", "a", 0),
      msg("assistant", "oops", 1, { isError: true }),
      msg("assistant", "b", 2),
    ];

    expect(Compaction.capacityCount(ordered)).toBe(2);
    expect(texts(Compaction.liveMessages(ordered))).toEqual(["a", "b"]);
  });

  it("counts only turns after the marker once compacted", () => {
    // The divider is appended at the seam; the live segment is every real turn following the last
    // marker (turns above it are summarized history and no longer feed the model).
    const ordered = [
      ...[0, 1, 2].map((index) =>
        msg(index % 2 === 0 ? "user" : "assistant", `old${index}`, index),
      ),
      msg("assistant", "SUMMARY", 3, { isCompactionSummary: true }),
      msg("user", "next-user", 4),
      msg("assistant", "next-reply", 5),
    ];

    expect(Compaction.activeSummary(ordered)).toBe("SUMMARY");
    // Only post-marker turns count toward capacity — the compacted chat is no longer stuck.
    expect(Compaction.capacityCount(ordered)).toBe(2);
    expect(texts(Compaction.liveMessages(ordered))).toEqual(["next-user", "next-reply"]);
    // The marker's own summary is never replayed as a message.
    expect(texts(Compaction.liveMessages(ordered))).not.toContain("SUMMARY");
  });

  it("empties the live segment on a fresh compaction", () => {
    // Immediately after compaction (marker appended at the end, nothing after it yet) the live
    // segment is empty, so capacity resets to zero and the model continues from the summary.
    const ordered = [
      ...[0, 1, 2, 3].map((index) =>
        msg(index % 2 === 0 ? "user" : "assistant", `m${index}`, index),
      ),
      msg("assistant", "SUMMARY", 4, { isCompactionSummary: true }),
    ];

    expect(Compaction.activeSummary(ordered)).toBe("SUMMARY");
    expect(Compaction.capacityCount(ordered)).toBe(0);
    expect(Compaction.liveMessages(ordered)).toEqual([]);
  });

  /**
   * ADDED (no Swift counterpart). Swift's `lastIndex(where:)` scans backwards, so the *last* marker
   * wins when a chat has been compacted more than once — the case a forwards `findIndex` would get
   * wrong while still passing every single-marker test above.
   */
  it("uses the most recent marker when a chat has been compacted twice", () => {
    const ordered = [
      msg("user", "a", 0),
      msg("assistant", "FIRST SUMMARY", 1, { isCompactionSummary: true }),
      msg("user", "b", 2),
      msg("assistant", "SECOND SUMMARY", 3, { isCompactionSummary: true }),
      msg("user", "c", 4),
    ];

    expect(Compaction.lastMarkerIndex(ordered)).toBe(3);
    expect(Compaction.activeSummary(ordered)).toBe("SECOND SUMMARY");
    expect(texts(Compaction.liveMessages(ordered))).toEqual(["c"]);
  });
});
