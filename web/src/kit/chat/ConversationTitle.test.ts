import { describe, expect, it } from "vitest";

import { ConversationTitle } from "./ConversationTitle";
import { Conversation } from "../models/Conversation";

/**
 * Ports the `// MARK: ConversationTitle` cases of `OndasTests/OndasTests.swift` (lines 11-30),
 * one for one, plus two ADDED cases marked below. The added pair covers a divergence that only
 * exists on this platform — grapheme clusters vs UTF-16 code units — and is the same pair
 * `android/.../OndasKitTest.kt` had to add for the same reason.
 */

/**
 * Swift's `String.count`. `title.length` would count UTF-16 code units, so a test written with it
 * would pass for the wrong reason on the emoji cases below.
 */
function characterCount(text: string): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return Array.from(segmenter.segment(text)).length;
}

describe("ConversationTitle.derive", () => {
  it("derives a title from a short message", () => {
    expect(ConversationTitle.derive("Hello there")).toBe("Hello there");
  });

  it("collapses whitespace and takes the first line", () => {
    expect(ConversationTitle.derive("  Plan a   trip\nsecond line")).toBe("Plan a trip");
    // Swift splits on `Character.isWhitespace`, which is the Unicode White_Space property — not
    // just U+0020. A tab, a NO-BREAK SPACE and an IDEOGRAPHIC SPACE all collapse to one space.
    expect(ConversationTitle.derive("a\t b\u00A0c\u3000d")).toBe("a b c d");
  });

  it("truncates a long message on a word boundary", () => {
    const long = "Please help me write a detailed itinerary for a long summer vacation abroad";
    const title = ConversationTitle.derive(long);

    expect(characterCount(title)).toBeLessThanOrEqual(41); // 40 chars + ellipsis
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toContain("  ");
    // Beyond the Swift assertions: the exact cut. The 40-character prefix ends mid-"itinerary",
    // and the last space before it is at index 31 — past `maxLength / 2`, so the word is dropped
    // rather than split.
    expect(title).toBe("Please help me write a detailed…");
  });

  /**
   * ADDED (no Swift counterpart). The exact boundary of `guard collapsed.count > maxLength`
   * (`ConversationTitle.swift:22`): 40 characters is not too long, 41 is. Without this the
   * `<=`/`<` off-by-one passes every other case in this file while putting an ellipsis on a title
   * that fits.
   */
  it("leaves a message of exactly the maximum length alone", () => {
    const exactly40 = "0123456789".repeat(4);
    expect(exactly40).toHaveLength(40);
    expect(ConversationTitle.derive(exactly40)).toBe(exactly40);

    // One more character, and with no space to cut on it is a hard cut plus an ellipsis.
    expect(ConversationTitle.derive(`${exactly40}x`)).toBe(`${exactly40}…`);
  });

  it("falls back to the default title for an empty message", () => {
    expect(ConversationTitle.derive("   ")).toBe(Conversation.defaultTitle);
  });

  /**
   * ADDED (no Swift counterpart). Swift's `prefix(40)` walks grapheme clusters; a JS `slice(0, 40)`
   * walks UTF-16 code units and would cut a surrogate pair in half, putting U+FFFD in a title.
   *
   * The leading "a" is load-bearing: each rocket is 2 code units, so without it a naive
   * `slice(0, 40)` lands neatly on a pair boundary and the bug hides. Offset by one and index 40
   * falls INSIDE a pair, which is what splits it.
   */
  it("never splits a surrogate pair when truncating", () => {
    const title = ConversationTitle.derive(`a${"🚀".repeat(50)}`);

    expect(title.endsWith("…")).toBe(true);
    // 40 clusters kept: the "a" plus 39 whole rockets. No lone surrogate anywhere.
    expect(title).toBe(`a${"🚀".repeat(39)}…`);
    // `\p{Cs}` matches a surrogate only when it is UNPAIRED — in `u` mode a well-formed pair is a
    // single astral code point, not two surrogates — so this is precisely the "broken character"
    // assertion, and it fails on a naive `slice(0, 40)`.
    expect(/\p{Cs}/u.test(title)).toBe(false);
  });

  /**
   * ADDED (no Swift counterpart). Counting in the same unit Swift does. 30 astronauts are 30 Swift
   * `Character`s — under the 40 limit, so no ellipsis — yet they are 120 UTF-16 code units and 90
   * code points, so both `length` and `[...text]` would wrongly truncate.
   */
  it("counts emoji as single characters, not code units", () => {
    const title = ConversationTitle.derive("🧑‍🚀".repeat(30));

    expect(title.endsWith("…")).toBe(false);
    expect(title).toBe("🧑‍🚀".repeat(30));
  });
});
