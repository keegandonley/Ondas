import { describe, expect, it } from "vitest";

import { Conversation } from "./Conversation";
import { ChatMessage } from "./ChatMessage";
import type { ChatRole } from "./ChatRole";

/**
 * Ports `compactionSuggestedCountSitsBelowTheHardCap` (`OndasTests/OndasTests.swift:87-90`) and
 * `conversationCapacityStateCrossesApproachingThenFull` (`:185-193`), plus ADDED cases marked
 * below for the computed properties Swift never covered (`previewText`, `latestMessage`,
 * `orderedMessages`, `reuseEmptyOrCreate`'s pure half) — they are ported behaviour, so they get
 * assertions here.
 */

function msg(
  role: ChatRole,
  text: string,
  at: number,
  options: { isError?: boolean; isCompactionSummary?: boolean } = {},
): ChatMessage {
  return ChatMessage.make({ role, text, createdAt: new Date(at * 1000), ...options });
}

/** Swift's `conversation(liveMessages:)`: a thread holding `count` real, non-marker turns. */
function conversation(liveMessages: number): Conversation {
  const thread = Conversation.make({ createdAt: new Date(0) });
  thread.messages = Array.from({ length: liveMessages }, (_, index) =>
    msg("user", `m${index}`, index),
  );
  return thread;
}

describe("Conversation capacity constants", () => {
  it("keeps the compaction-suggested count below the hard cap", () => {
    expect(Conversation.compactionSuggestedCount).toBe(32);
    expect(Conversation.compactionSuggestedCount).toBeLessThan(Conversation.messageLimit);
  });
});

describe("Conversation.capacityState", () => {
  it("crosses approaching, then full", () => {
    // The message-count fallback path (used when a token count is unavailable): normal below the
    // suggested count, approaching from it up to the hard cap, full at the cap.
    expect(Conversation.capacityState(conversation(31))).toBe("normal");
    expect(Conversation.capacityState(conversation(Conversation.compactionSuggestedCount))).toBe(
      "approaching",
    );
    expect(Conversation.capacityState(conversation(Conversation.messageLimit - 1))).toBe(
      "approaching",
    );
    expect(Conversation.capacityState(conversation(Conversation.messageLimit))).toBe("full");
    expect(Conversation.capacityState(conversation(Conversation.messageLimit + 5))).toBe("full");
  });

  /**
   * ADDED (no Swift counterpart). The reason `capacityState` counts through `Compaction` rather
   * than `messages.count`: a full chat that has just been compacted must be usable again. Counting
   * every stored message would leave it permanently `full` — a chat you can never continue.
   */
  it("returns to normal after a full conversation is compacted", () => {
    const thread = conversation(Conversation.messageLimit);
    expect(Conversation.capacityState(thread)).toBe("full");

    thread.messages = [
      ...thread.messages,
      msg("assistant", "SUMMARY", Conversation.messageLimit, { isCompactionSummary: true }),
    ];

    expect(Conversation.capacityState(thread)).toBe("normal");
  });
});

/** ADDED (no Swift counterpart). */
describe("Conversation list-row helpers", () => {
  it("orders messages chronologically without mutating the stored array", () => {
    const thread = Conversation.make({ createdAt: new Date(0) });
    const first = msg("user", "a", 0);
    const second = msg("assistant", "b", 1);
    const third = msg("user", "c", 2);
    // Deliberately out of order, the way an unsorted store hands them back.
    thread.messages = [third, first, second];

    expect(Conversation.orderedMessages(thread).map(({ text }) => text)).toEqual(["a", "b", "c"]);
    // `Array.prototype.sort` reorders in place; sorting `messages` directly would rewrite the
    // conversation every time a row rendered.
    expect(thread.messages.map(({ text }) => text)).toEqual(["c", "a", "b"]);
  });

  it("previews the latest real turn, skipping compaction markers", () => {
    const thread = Conversation.make({ createdAt: new Date(0) });
    thread.messages = [
      msg("user", "first", 0),
      msg("assistant", "second", 1),
      msg("assistant", "SUMMARY", 2, { isCompactionSummary: true }),
    ];

    expect(Conversation.latestMessage(thread)?.text).toBe("second");
    expect(Conversation.previewText(thread)).toBe("second");
  });

  it("previews the placeholder copy when a thread has no messages", () => {
    const thread = Conversation.make();

    expect(Conversation.hasMessages(thread)).toBe(false);
    expect(Conversation.latestMessage(thread)).toBeUndefined();
    expect(Conversation.previewText(thread)).toBe(Conversation.noMessagesPreviewText);
  });

  it("defaults a new thread to the default title", () => {
    expect(Conversation.make().title).toBe(Conversation.defaultTitle);
    expect(Conversation.make({ title: "Named" }).title).toBe("Named");
    // `updatedAt` starts at `createdAt` so an untouched thread sorts by when it was made.
    const thread = Conversation.make({ createdAt: new Date(1234) });
    expect(thread.updatedAt.getTime()).toBe(thread.createdAt.getTime());
  });
});

/**
 * ADDED (no Swift counterpart). The pure half of `reuseEmptyOrCreate` — the "don't accumulate empty
 * rows on repeated New Chat taps" policy. The insert half lands with the store in spec W5.
 */
describe("Conversation.reusableEmpty", () => {
  it("returns the first thread with no messages", () => {
    const used = conversation(2);
    const empty = Conversation.make({ createdAt: new Date(1000) });

    expect(Conversation.reusableEmpty([used, empty])).toBe(empty);
  });

  it("returns undefined when every thread has messages", () => {
    expect(Conversation.reusableEmpty([conversation(1), conversation(3)])).toBeUndefined();
    expect(Conversation.reusableEmpty([])).toBeUndefined();
  });
});
