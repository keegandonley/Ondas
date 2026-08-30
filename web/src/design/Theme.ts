/**
 * Port of `Ondas/Support/Theme.swift`.
 *
 * Swift's Theme is three lines — an accent, a bubble background, a corner radius — because
 * everything else in the SwiftUI code is a *semantic system role*: `.primary`, `.secondary`,
 * `.tertiary`, `.separator`, `.bar`, `.orange`. The OS resolves those per appearance.
 *
 * The web has no such roles, so each one has to be written out per colour scheme. That makes
 * this file bigger than its Swift counterpart without being less faithful — the extra entries
 * are the values iOS was already supplying.
 *
 * TWO DIFFERENT KINDS OF VALUE LIVE HERE, and they have different guarantees:
 *
 *   1. `accentLight` / `accentDark` are Ondas's OWN brand asset. They are pinned:
 *      `Theme.test.ts` reads Ondas/Resources/Assets.xcassets/AccentColor.colorset/Contents.json
 *      in place and fails if these drift from it. Never hand-edit them.
 *
 *   2. Everything else is a TRANSCRIPTION of an Apple semantic system colour (systemBackground,
 *      secondarySystemBackground, label, secondaryLabel, tertiaryLabel, separator, systemOrange).
 *      Those live in the OS, not in this repo, so there is nothing to pin them to and no test
 *      can catch drift in them. They are documented per entry with the role they stand in for.
 *      Treat them as a considered approximation, not as verified truth — and if Apple restyles
 *      a role, this file will not know.
 */
export const Theme = {
  /** AccentColor, light appearance. Derived from the iOS master; asserted by Theme.test.ts. */
  accentLight: "#665CF2",
  /** AccentColor, dark appearance. Derived from the iOS master; asserted by Theme.test.ts. */
  accentDark: "#8B82F9",

  /**
   * `Theme.bubbleCornerRadius` in Swift. The SwiftUI shape is
   * `RoundedRectangle(cornerRadius: 20, style: .continuous)` — a squircle, not a plain rounded
   * rect. CSS `border-radius` is the plain form. Android shipped the plain form too and
   * web/PORTING.md records that as a divergence, not an approval. A superellipse is achievable
   * on the web (SVG/`corner-shape`) if the chat UI spec decides to close the gap.
   */
  bubbleCornerRadius: 20,

  /** Generated-image card radius in Swift is `bubbleCornerRadius - 6`. Image gen is cut; kept
   * for the arithmetic's provenance only if it ever returns. */
  imageCornerRadius: 14,
} as const;

/**
 * The semantic roles SwiftUI resolved for free, transcribed per appearance.
 *
 * `userBubble` is the accent (Swift: `Theme.userBubble = Color.accentColor`) and
 * `onUserBubble` is `Color.white` (MessageBubble.swift's `.foregroundStyle(isUser ? .white : .primary)`).
 */
export interface ThemePalette {
  /** iOS `systemBackground`. */
  background: string;
  /** Swift `Theme.userBubble` — the accent. */
  userBubble: string;
  /** Swift's explicit `Color.white` on the user bubble. */
  onUserBubble: string;
  /** Swift `Theme.assistantBubble` — iOS `secondarySystemBackground`. Also the composer capsule. */
  assistantBubble: string;
  /** SwiftUI `.primary`. iOS `label`. */
  label: string;
  /** SwiftUI `.secondary`. iOS `secondaryLabel`. */
  secondaryLabel: string;
  /** SwiftUI `.tertiary`. iOS `tertiaryLabel`. Used by the compaction divider. */
  tertiaryLabel: string;
  /** SwiftUI `.separator`. The compaction divider's hairlines and the jump button's border. */
  separator: string;
  /** SwiftUI `.bar` — the material behind the banners, the token meter and the composer. */
  bar: string;
  /**
   * The token meter's warning tint. Swift uses `.orange`; Android named it outright as
   * `0xFFFF9500`. These are iOS `systemOrange` light/dark.
   */
  meterWarning: string;
  /**
   * Destructive actions — Delete, Delete all chats.
   *
   * Added for the rebuilt Settings sheet. Every other entry here transcribes a role the SwiftUI
   * code NAMES; this one transcribes a role it names only indirectly, through
   * `Button(role: .destructive)`, which the OS resolves to `systemRed`. Recorded as such because
   * it is one step further from the source than its neighbours — but the alternative was the
   * Settings sheet tinting a destructive action with the token meter's orange, which reads as a
   * warning rather than a danger.
   */
  destructive: string;
}

export const lightPalette: ThemePalette = {
  background: "#FFFFFF",
  userBubble: Theme.accentLight,
  onUserBubble: "#FFFFFF",
  assistantBubble: "#F2F2F7",
  label: "#000000",
  secondaryLabel: "rgba(60, 60, 67, 0.6)",
  tertiaryLabel: "rgba(60, 60, 67, 0.3)",
  separator: "rgba(60, 60, 67, 0.29)",
  bar: "#F9F9F9",
  meterWarning: "#FF9500",
  destructive: "#FF3B30",
};

export const darkPalette: ThemePalette = {
  background: "#000000",
  userBubble: Theme.accentDark,
  onUserBubble: "#FFFFFF",
  assistantBubble: "#1C1C1E",
  label: "#FFFFFF",
  secondaryLabel: "rgba(235, 235, 245, 0.6)",
  tertiaryLabel: "rgba(235, 235, 245, 0.3)",
  separator: "rgba(84, 84, 88, 0.65)",
  bar: "#1C1C1E",
  meterWarning: "#FF9F0A",
  destructive: "#FF453A",
};

/** sRGB float components as Xcode stores them, 0...1. */
export interface AssetColorComponents {
  red: number;
  green: number;
  blue: number;
}

/**
 * Converts an Xcode asset-catalog sRGB component triple to a `#RRGGBB` string.
 *
 * Xcode writes components as decimal strings in 0...1. Rounding (not truncating) is what
 * reproduces the values a designer reads off the swatch: 0.361 x 255 is 92.055 and 0.510 x 255
 * is 130.05 — both round down, but 0.545 x 255 is 138.975 and 0.976 x 255 is 248.88, which
 * truncate to the wrong byte and shift the brand.
 */
export function hexFromAssetComponents({ red, green, blue }: AssetColorComponents): string {
  const byte = (component: number): string =>
    Math.round(component * 255)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${byte(red)}${byte(green)}${byte(blue)}`;
}
