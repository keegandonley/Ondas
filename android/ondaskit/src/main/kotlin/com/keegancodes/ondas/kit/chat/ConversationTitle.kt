package com.keegancodes.ondas.kit.chat

import com.keegancodes.ondas.kit.models.Conversation
import java.text.BreakIterator

/**
 * Derives a short, human-readable conversation title from the first user message, so the list
 * shows something meaningful without a separate model call.
 */
public object ConversationTitle {
    /** Maximum characters in a derived title before it is truncated with an ellipsis. */
    private const val MAX_LENGTH = 40

    /**
     * A single-line title built from [message]. Collapses whitespace, takes the first line, and
     * truncates on a word boundary when possible. Returns the default title for empty input.
     */
    public fun derive(message: String): String {
        val collapsed = collapseWhitespace(firstLine(message))
        if (collapsed.isEmpty()) return Conversation.DEFAULT_TITLE
        if (graphemeCount(collapsed) <= MAX_LENGTH) return collapsed

        val truncated = graphemePrefix(collapsed, MAX_LENGTH)
        // Prefer cutting at the last space so a word is not split mid-way. Swift compares
        // grapheme DISTANCE from the start, not a UTF-16 index, so the count is taken the same
        // way here rather than from lastIndexOf's raw offset.
        val lastSpace = truncated.lastIndexOf(' ')
        if (lastSpace > 0 && graphemeCount(truncated.substring(0, lastSpace)) > MAX_LENGTH / 2) {
            return truncated.substring(0, lastSpace) + "…"
        }
        return truncated + "…"
    }

    /**
     * The first non-empty line. Mirrors Swift's `split(whereSeparator: \.isNewline).first`, which
     * omits empty subsequences — so leading newlines are skipped rather than yielding "".
     */
    private fun firstLine(message: String): String {
        val builder = StringBuilder()
        var started = false
        for (ch in message) {
            if (isNewline(ch)) {
                if (started) break else continue
            }
            started = true
            builder.append(ch)
        }
        return builder.toString()
    }

    /**
     * The characters Swift's `Character.isNewline` reports true for: LF, VT, FF, CR, NEL,
     * LINE SEPARATOR and PARAGRAPH SEPARATOR. Written as escapes because four of the seven are
     * invisible control characters, and a literal one in source is unreviewable.
     */
    private fun isNewline(ch: Char): Boolean =
        ch == '\u000A' || ch == '\u000B' || ch == '\u000C' || ch == '\u000D' ||
            ch == '\u0085' || ch == '\u2028' || ch == '\u2029'

    /** Equivalent of Swift's `split(whereSeparator: \.isWhitespace).joined(separator: " ")`. */
    private fun collapseWhitespace(text: String): String {
        val builder = StringBuilder()
        var pendingSpace = false
        for (ch in text) {
            if (ch.isWhitespace()) {
                if (builder.isNotEmpty()) pendingSpace = true
            } else {
                if (pendingSpace) {
                    builder.append(' ')
                    pendingSpace = false
                }
                builder.append(ch)
            }
        }
        return builder.toString()
    }

    // Swift's `String.count` and `prefix(_:)` work in GRAPHEME CLUSTERS; Kotlin's `length` and
    // `substring` work in UTF-16 code units. Using the latter would not merely count differently
    // for emoji and combining marks -- it could cut a surrogate pair in half and produce a broken
    // character in the middle of a user-visible title. BreakIterator gives the same unit Swift
    // uses. (The sibling Cadence port has a vault-recorded bug of exactly this shape, where Swift
    // counted unicode scalars and JS counted UTF-16 and the two silently disagreed.)

    private fun graphemeCount(text: String): Int {
        val iterator = BreakIterator.getCharacterInstance()
        iterator.setText(text)
        var count = 0
        while (iterator.next() != BreakIterator.DONE) count++
        return count
    }

    private fun graphemePrefix(text: String, count: Int): String {
        val iterator = BreakIterator.getCharacterInstance()
        iterator.setText(text)
        var end = iterator.next()
        var taken = 1
        while (taken < count && end != BreakIterator.DONE) {
            end = iterator.next()
            taken++
        }
        return if (end == BreakIterator.DONE) text else text.substring(0, end)
    }
}
