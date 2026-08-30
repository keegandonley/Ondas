import { describe, expect, it } from "vitest";

import { ChatMessage } from "./ChatMessage";
import { ChatRole } from "./ChatRole";

/**
 * ADDED — `OndasTests/OndasTests.swift` has no `ChatMessage` or `ChatRole` cases. Both are ported
 * behaviour with a branch in them, so they get assertions rather than being taken on trust.
 */

describe("ChatMessage.isEmptyPlaceholder", () => {
  it("is true only for a contentless assistant bubble", () => {
    // The state the UI renders as a "thinking" indicator while the model works.
    expect(ChatMessage.isEmptyPlaceholder(ChatMessage.make({ role: "assistant" }))).toBe(true);
  });

  it("is false once the assistant has streamed any text", () => {
    expect(
      ChatMessage.isEmptyPlaceholder(ChatMessage.make({ role: "assistant", text: "H" })),
    ).toBe(false);
  });

  it("is false for a user turn", () => {
    // An empty user message is not a pending reply, so it must not render as one.
    expect(ChatMessage.isEmptyPlaceholder(ChatMessage.make({ role: "user" }))).toBe(false);
  });

  it("is false for a compaction marker whose summary has not arrived yet", () => {
    // The marker renders as a divider, never as a bubble — so it must never be mistaken for a
    // pending reply while the summarizer is still running.
    expect(
      ChatMessage.isEmptyPlaceholder(
        ChatMessage.make({ role: "assistant", isCompactionSummary: true }),
      ),
    ).toBe(false);
  });
});

describe("ChatMessage.make", () => {
  it("defaults text and both flags, and gives every message a distinct id", () => {
    const message = ChatMessage.make({ role: "user" });

    expect(message.text).toBe("");
    expect(message.isError).toBe(false);
    expect(message.isCompactionSummary).toBe(false);
    expect(message.id).not.toBe(ChatMessage.make({ role: "user" }).id);
  });
});

describe("ChatRole.fromRaw", () => {
  it("round-trips the raw values Swift persists", () => {
    expect(ChatRole.fromRaw("user")).toBe(ChatRole.user);
    expect(ChatRole.fromRaw("assistant")).toBe(ChatRole.assistant);
  });

  it("degrades an unrecognised value to user rather than throwing", () => {
    // Mirrors `ChatRole(rawValue:) ?? .user`: a message whose role we cannot parse is still a
    // message worth showing.
    expect(ChatRole.fromRaw("system")).toBe(ChatRole.user);
    expect(ChatRole.fromRaw("")).toBe(ChatRole.user);
  });
});
