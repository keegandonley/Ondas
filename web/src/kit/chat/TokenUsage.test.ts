import { describe, expect, it } from "vitest";

import { TokenUsage } from "./TokenUsage";

/**
 * Ports the `// MARK: TokenUsage` cases of `OndasTests/OndasTests.swift` (lines 56-85), one for
 * one. The limits are Swift's 3072 rather than the web's measured 9216 window on purpose: the
 * arithmetic is window-independent, and keeping the numbers identical keeps the two suites
 * line-comparable. (`compactionSuggestedCountSitsBelowTheHardCap`, filed under the same MARK in
 * Swift, asserts on `Conversation` constants and is ported in `models/Conversation.test.ts`.)
 */
describe("TokenUsage", () => {
  it("fraction is the ratio of used to limit", () => {
    expect(TokenUsage.fraction({ used: 768, limit: 3072 })).toBe(0.25);
  });

  it("fraction clamps to one when over the limit", () => {
    expect(TokenUsage.fraction({ used: 4000, limit: 3072 })).toBe(1);
  });

  it("fraction is zero when the limit is zero", () => {
    // Guards against divide-by-zero if the context window cannot be determined.
    expect(TokenUsage.fraction({ used: 100, limit: 0 })).toBe(0);
  });

  it("is at capacity when used reaches the limit", () => {
    expect(TokenUsage.isAtCapacity({ used: 3072, limit: 3072 })).toBe(true);
    expect(TokenUsage.isAtCapacity({ used: 3073, limit: 3072 })).toBe(true);
    expect(TokenUsage.isAtCapacity({ used: 3071, limit: 3072 })).toBe(false);
  });

  it("is approaching capacity in the warning band only", () => {
    // The band opens at warningFraction (0.8 → 2457/3072 ≈ 0.7998, 2458 ≈ 0.8001)…
    expect(TokenUsage.isApproachingCapacity({ used: 2457, limit: 3072 })).toBe(false);
    expect(TokenUsage.isApproachingCapacity({ used: 2458, limit: 3072 })).toBe(true);
    // …and closes again at full: an at-capacity chat is `full`, not `approaching`.
    expect(TokenUsage.isApproachingCapacity({ used: 3072, limit: 3072 })).toBe(false);
    expect(TokenUsage.isApproachingCapacity({ used: 3200, limit: 3072 })).toBe(false);
  });
});
