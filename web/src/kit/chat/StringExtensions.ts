/**
 * Port of `Ondas/Support/StringExtensions.swift`.
 *
 * Swift adds this as a `String` extension; TypeScript has no counterpart worth reaching for
 * (patching `String.prototype` from a library module is how two ports of the same helper start
 * fighting), so it is a free function.
 *
 * Placement: `Support/` has no mapped web directory in PORTING.md § Module graph, and this has to
 * stay in the pure layer because its callers — `ChatEngine` (spec W6) and the composer (W7) — sit
 * in two different ones. It lives beside them in `src/kit/chat/` rather than growing a one-file
 * `src/kit/support/`.
 */

/**
 * True when the string is empty or only whitespace/newlines. Centralizes the "trim and check empty"
 * pattern used by the composer and the chat engine.
 *
 * `\p{White_Space}` is the Unicode property behind Foundation's `.whitespacesAndNewlines`. JS's
 * `String.prototype.trim` uses a slightly different set — it also strips the BOM (U+FEFF) — so the
 * test is written explicitly rather than as `text.trim().length === 0`.
 */
export function isBlank(text: string): boolean {
  return /^\p{White_Space}*$/u.test(text);
}
