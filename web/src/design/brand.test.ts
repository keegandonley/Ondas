import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import brandSource from "./brandSource.json";

/**
 * The web app icon is DERIVED from the iOS master, never hand-cut.
 *
 * `android/PORTING.md` § Known unported Swift is explicit about this: Scalene generates every
 * Android brand asset from the one iOS master through a measurement-verified generator, because a
 * hand-drawn approximation drifts and nobody notices. The same rule applies here, but a web build
 * has no generator step to hang the check on — so the derivation is recorded in
 * `brandSource.json` and asserted here instead.
 *
 * If this fails with a checksum mismatch, the iOS icon changed and the web icons are stale.
 * Regenerate with the command in `brandSource.json` and update the checksum. Do NOT edit the
 * checksum on its own to make this pass — that is the drift the test exists to catch.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** PNG dimensions live in the IHDR chunk: width at byte 16, height at byte 20, both big-endian. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  const signature = bytes.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") throw new Error(`${path} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("web brand assets are derived from the iOS master", () => {
  it("the recorded master checksum still matches the file on disk", () => {
    const master = readFileSync(resolve(repoRoot, brandSource.source));
    expect(createHash("sha256").update(master).digest("hex")).toBe(brandSource.sha256);
  });

  it.each(brandSource.derived)("$path is $size x $size", ({ path, size }) => {
    expect(pngSize(resolve(repoRoot, path))).toStrictEqual({ width: size, height: size });
  });
});
