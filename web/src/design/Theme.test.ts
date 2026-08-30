import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Theme, darkPalette, hexFromAssetComponents, lightPalette } from "./Theme";
import type { ThemePalette } from "./Theme";

/**
 * The accent colour is the brand, and `android/PORTING.md` § Known unported Swift is explicit
 * that Android's brand assets are to be generated from the iOS master rather than hand-cut.
 * This test applies the same rule to the web: it reads the Xcode asset catalog IN PLACE — never
 * a copy — so editing the iOS accent without editing `Theme.ts` fails the web build, and
 * vice versa. That is the `contracts/` pattern applied to a brand token.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const accentColorset = resolve(
  repoRoot,
  "Ondas/Resources/Assets.xcassets/AccentColor.colorset/Contents.json",
);

interface AssetEntry {
  appearances?: { appearance: string; value: string }[];
  color: { components: { red: string; green: string; blue: string; alpha: string } };
}

function componentsFor(appearance: "light" | "dark") {
  const catalog = JSON.parse(readFileSync(accentColorset, "utf8")) as { colors: AssetEntry[] };
  const matches = catalog.colors.filter((candidate) =>
    appearance === "dark"
      ? // Exactly the dark-luminosity entry, and nothing else. Matching on "has a luminosity
        // dimension equal to dark" would also match a future high-contrast dark variant, and
        // `.find()` would then silently return whichever came first in the array. Shipping the
        // wrong brand colour because of JSON key order is not a failure mode worth allowing.
        candidate.appearances?.length === 1 &&
        candidate.appearances[0]?.appearance === "luminosity" &&
        candidate.appearances[0]?.value === "dark"
      : // The light appearance is the universal entry: no `appearances` key at all.
        candidate.appearances === undefined,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${appearance} entry in ${accentColorset}, found ${matches.length}. ` +
        `The asset catalog shape changed — update componentsFor() rather than loosening it.`,
    );
  }
  const entry = matches[0]!;
  return {
    red: Number(entry.color.components.red),
    green: Number(entry.color.components.green),
    blue: Number(entry.color.components.blue),
  };
}

describe("hexFromAssetComponents", () => {
  it("rounds rather than truncates each component", () => {
    // 0.545 x 255 = 138.975 -> 0x8B. Truncating would give 138 (0x8A) and shift the brand.
    expect(hexFromAssetComponents({ red: 0.545, green: 0.51, blue: 0.976 })).toBe("#8B82F9");
  });

  it("pads a single-digit byte", () => {
    expect(hexFromAssetComponents({ red: 0, green: 0.02, blue: 1 })).toBe("#0005FF");
  });
});

describe("Theme accent matches the iOS asset catalog", () => {
  it("light appearance", () => {
    expect(hexFromAssetComponents(componentsFor("light"))).toBe(Theme.accentLight);
  });

  it("dark appearance", () => {
    expect(hexFromAssetComponents(componentsFor("dark"))).toBe(Theme.accentDark);
  });
});

describe("Theme geometry matches Support/Theme.swift", () => {
  it("bubble corner radius", () => {
    expect(Theme.bubbleCornerRadius).toBe(20);
  });
});

/**
 * `app/globals.css` restates the accent as a CSS custom property, because `var(--ondas-accent)`
 * is what the rendered app actually reads — `Theme.ts` is never imported by a stylesheet. That
 * duplication is the drift risk: without this block, `globals.css` could hold a stale colour
 * while every other test passed, and the comment at the top of that file claiming the two move
 * together would be false.
 */
const globalsCss = resolve(dirname(fileURLToPath(import.meta.url)), "../../app/globals.css");

const DARK_BLOCK_MARKER = "@media (prefers-color-scheme: dark)";

/** `secondaryLabel` -> `--ondas-secondary-label`. Mechanical, so the test covers every key. */
function customPropertyName(paletteKey: string): string {
  return `--ondas-${paletteKey.replace(/[A-Z]/g, (upper) => `-${upper.toLowerCase()}`)}`;
}

/** Colour syntax differs harmlessly between the two files (case, `rgba` spacing). */
function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Splits the stylesheet at the `prefers-color-scheme: dark` block and returns the custom
 * properties declared in each half. Anything before the marker is the light cascade; anything
 * after is the dark override.
 */
function declaredTokens(): { light: Map<string, string>; dark: Map<string, string> } {
  const css = readFileSync(globalsCss, "utf8");
  const splitAt = css.indexOf(DARK_BLOCK_MARKER);
  if (splitAt === -1) {
    throw new Error(`${globalsCss} no longer contains a ${DARK_BLOCK_MARKER} block.`);
  }
  const collect = (region: string): Map<string, string> =>
    new Map(
      [...region.matchAll(/(--ondas-[a-z-]+)\s*:\s*([^;]+);/g)].map((match) => [
        match[1]!,
        normalise(match[2]!),
      ]),
    );
  return { light: collect(css.slice(0, splitAt)), dark: collect(css.slice(splitAt)) };
}

/**
 * The palettes are ~20 hand-written colour values duplicated across two files. That is exactly
 * the shape of duplication that drifts silently — the app would keep rendering, just with one
 * stale colour. Asserting EVERY key (rather than only the accent) is what makes the duplication
 * safe to have.
 */
describe("globals.css matches the palettes", () => {
  const paletteKeys = Object.keys(lightPalette) as (keyof ThemePalette)[];

  it("covers every ThemePalette key in both cascades", () => {
    const { light, dark } = declaredTokens();
    const expected = paletteKeys.map(customPropertyName).sort();
    // `--ondas-accent` is the brand token and is not a palette role, so it is asserted
    // separately below; exclude it here rather than loosening the comparison to a subset check.
    const declaredLight = [...light.keys()].filter((k) => k !== "--ondas-accent").sort();
    const declaredDark = [...dark.keys()].filter((k) => k !== "--ondas-accent").sort();

    expect(declaredLight).toStrictEqual(expected);
    expect(declaredDark).toStrictEqual(expected);
  });

  it.each(paletteKeys)("light %s", (key) => {
    expect(declaredTokens().light.get(customPropertyName(key))).toBe(normalise(lightPalette[key]));
  });

  it.each(paletteKeys)("dark %s", (key) => {
    expect(declaredTokens().dark.get(customPropertyName(key))).toBe(normalise(darkPalette[key]));
  });

  it("declares the brand accent in both cascades", () => {
    const { light, dark } = declaredTokens();
    expect(light.get("--ondas-accent")).toBe(normalise(Theme.accentLight));
    expect(dark.get("--ondas-accent")).toBe(normalise(Theme.accentDark));
  });
});
