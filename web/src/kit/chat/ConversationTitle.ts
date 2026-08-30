import { Conversation } from "../models/Conversation";

/** Maximum characters in a derived title before it is truncated with an ellipsis. */
const maxLength = 40;

/**
 * Port of `Ondas/Services/ConversationTitle.swift`.
 *
 * Derives a short, human-readable conversation title from the first user message, so the sidebar
 * shows something meaningful without a separate model call.
 */
export const ConversationTitle = {
  /**
   * A single-line title built from `message`. Collapses whitespace, takes the first line, and
   * truncates on a word boundary when possible. Returns the default title for empty input.
   */
  derive(message: string): string {
    const collapsed = collapseWhitespace(firstLine(message));

    if (collapsed.length === 0) return Conversation.defaultTitle;

    const clusters = graphemes(collapsed);
    if (clusters.length <= maxLength) return collapsed;

    const truncated = clusters.slice(0, maxLength);
    // Prefer cutting at the last space so a word is not split mid-way. Swift compares the grapheme
    // DISTANCE from the start against `maxLength / 2` (`ConversationTitle.swift:27`), not a UTF-16
    // offset, so the comparison is made on the cluster array rather than on `lastIndexOf`'s index.
    // Every separator is an ASCII space by this point — `collapseWhitespace` put it there.
    const lastSpace = truncated.lastIndexOf(" ");
    if (lastSpace > Math.trunc(maxLength / 2)) {
      return `${truncated.slice(0, lastSpace).join("")}…`;
    }
    return `${truncated.join("")}…`;
  },
} as const;

/**
 * The first non-empty line. Mirrors Swift's `split(whereSeparator: \.isNewline).first`, which omits
 * empty subsequences — so leading newlines are skipped rather than yielding "".
 *
 * The class is exactly the set `Character.isNewline` reports true for: LF, VT, FF, CR, NEL, LINE
 * SEPARATOR and PARAGRAPH SEPARATOR. Written as escapes because four of the seven are invisible
 * control characters, and a literal one in source is unreviewable. CRLF is one Swift `Character`
 * and splits here into two pieces separated by an empty string, which the emptiness filter
 * discards — same result either way.
 */
function firstLine(message: string): string {
  for (const line of message.split(/[\n\v\f\r\u0085\u2028\u2029]/u)) {
    if (line.length > 0) return line;
  }
  return "";
}

/**
 * Equivalent of Swift's `split(whereSeparator: \.isWhitespace).joined(separator: " ")`.
 *
 * `\p{White_Space}` is the same Unicode property `Character.isWhitespace` consults. JS's `\s` is
 * NOT: it omits NEL (U+0085) and adds the BOM (U+FEFF), so a title containing either would collapse
 * differently from iOS.
 */
function collapseWhitespace(text: string): string {
  return text
    .split(/\p{White_Space}/u)
    .filter((part) => part.length > 0)
    .join(" ");
}

// Swift's `String.count` and `prefix(_:)` work in GRAPHEME CLUSTERS; JS's `length` and `slice` work
// in UTF-16 code units, and even spreading (`[...text]`) only gets as far as code POINTS. Using
// either would not merely count differently for emoji and combining marks — `slice(0, 40)` can cut
// a surrogate pair in half and put a broken character in the middle of a user-visible title. The
// Android port hit exactly this and reached for `BreakIterator`; `Intl.Segmenter` is the same unit.
// (The sibling Cadence port has a vault-recorded bug of this shape, where Swift counted unicode
// scalars and JS counted UTF-16 and the two silently disagreed.)
//
// One segmenter, built once: constructing an ICU segmenter per call is expensive, and this runs on
// the first message of every chat.
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (segment) => segment.segment);
}
