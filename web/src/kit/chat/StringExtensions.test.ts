import { describe, expect, it } from "vitest";

import { isBlank } from "./StringExtensions";

/**
 * ADDED — `OndasTests/OndasTests.swift` has no `String.isBlank` case. It gates every send, so the
 * boundary is worth pinning: a message of only whitespace must not start a turn, and a message
 * with any content must not be swallowed.
 */
describe("isBlank", () => {
  it("is true for empty and whitespace-only strings", () => {
    expect(isBlank("")).toBe(true);
    expect(isBlank("   ")).toBe(true);
    expect(isBlank("\t\n \r\n")).toBe(true);
    // U+00A0 NO-BREAK SPACE and U+2028 LINE SEPARATOR: both are in Foundation's
    // `.whitespacesAndNewlines`, and a composer full of them is still an empty message. Written as
    // escapes because a literal one in source is unreviewable.
    expect(isBlank("\u00A0\u2028")).toBe(true);
    // U+0085 NEL is in `.whitespacesAndNewlines` but NOT in JS's `\s`. This assertion is what
    // stops the implementation being "simplified" to `/^\s*$/`.
    expect(isBlank("\u0085")).toBe(true);
  });

  it("is false as soon as there is anything to send", () => {
    expect(isBlank("hi")).toBe(false);
    expect(isBlank("  hi  ")).toBe(false);
    expect(isBlank("🚀")).toBe(false);
    // U+FEFF is the mirror image of the NEL case: `String.prototype.trim` strips it, Foundation's
    // `.whitespacesAndNewlines` does not. So this assertion is what stops the implementation being
    // "simplified" to `text.trim().length === 0`, which would silently disagree with iOS.
    expect(isBlank("\uFEFF")).toBe(false);
  });
});
