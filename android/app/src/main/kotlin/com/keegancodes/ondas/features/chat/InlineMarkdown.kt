package com.keegancodes.ondas.features.chat

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle

/**
 * The counterpart of Swift's
 * `AttributedString(markdown:options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))`
 * (`MessageBubble.swift:100-109`).
 *
 * "Inline only, preserving whitespace" means exactly what it does on iOS: emphasis, strong
 * emphasis, strikethrough, code spans, links and backslash escapes are interpreted; block
 * constructs (headings, lists, quotes, fenced code) are not, and every space and newline in the
 * source survives into the output. Model replies go through this on **every streamed update**, so
 * formatting appears the moment its closing marker arrives.
 *
 * ### What this is not
 *
 * Apple's parser is full CommonMark inline; this is a hand-written subset of it. The delimiters
 * above are covered, including nesting and the intra-word `_` rule, but the exotic corners of the
 * emphasis specification (multi-run `***`, punctuation-flanking edge cases) are resolved by the
 * simplest reading rather than by CommonMark's delimiter-stack algorithm. An unrecognised or
 * unclosed marker is emitted literally, which is the same thing the reader sees on iOS when the
 * fragment is incomplete — the doc comment on the Swift original names that case explicitly.
 *
 * Every path here is total: unmatched delimiters degrade to literal text rather than throwing. The
 * caller still wraps it (see [renderMessageText]) so that a defect here can only ever cost the
 * formatting, never the message.
 */
internal object InlineMarkdown {

    /**
     * Renders [source] as styled text. [linkStyle] is passed in because the color it needs comes
     * from the composition and this is a pure function.
     */
    fun render(source: String, linkStyle: SpanStyle): AnnotatedString = buildAnnotatedString {
        appendInline(source, linkStyle, depth = 0)
    }

    private val strongStyle = SpanStyle(fontWeight = FontWeight.Bold)
    private val emphasisStyle = SpanStyle(fontStyle = FontStyle.Italic)
    private val strongEmphasisStyle = SpanStyle(fontWeight = FontWeight.Bold, fontStyle = FontStyle.Italic)
    private val codeStyle = SpanStyle(fontFamily = FontFamily.Monospace)
    private val strikeStyle = SpanStyle(textDecoration = TextDecoration.LineThrough)

    /**
     * Bound on recursion through nested delimiters. Deeper than any real message and shallow
     * enough that a pathological input (`****…`) cannot exhaust the stack mid-stream.
     */
    private const val MAX_DEPTH = 8

    private const val ESCAPABLE = "\\`*_{}[]()#+-.!~>|"

    @Suppress("CyclomaticComplexMethod")
    private fun AnnotatedString.Builder.appendInline(text: String, linkStyle: SpanStyle, depth: Int) {
        if (depth >= MAX_DEPTH) {
            append(text)
            return
        }
        val literal = StringBuilder()
        var i = 0
        while (i < text.length) {
            val c = text[i]
            val consumed = when {
                c == '\\' && i + 1 < text.length && text[i + 1] in ESCAPABLE -> {
                    literal.append(text[i + 1])
                    2
                }

                c == '`' -> codeSpan(text, i, literal)
                c == '~' -> delimited(text, i, '~', 2, strikeStyle, linkStyle, depth, literal)
                c == '*' -> emphasis(text, i, '*', linkStyle, depth, literal)
                c == '_' -> emphasis(text, i, '_', linkStyle, depth, literal)
                c == '[' -> link(text, i, linkStyle, depth, literal)
                else -> {
                    literal.append(c)
                    1
                }
            }
            i += consumed
        }
        flush(literal)
    }

    /** Emits and clears the pending literal run, so styled spans land in source order. */
    private fun AnnotatedString.Builder.flush(literal: StringBuilder) {
        if (literal.isNotEmpty()) {
            append(literal.toString())
            literal.setLength(0)
        }
    }

    /**
     * A code span: the content is NOT parsed further, per CommonMark. Returns how many characters
     * of [text] were consumed.
     */
    private fun AnnotatedString.Builder.codeSpan(
        text: String,
        start: Int,
        literal: StringBuilder,
    ): Int {
        val run = runLength(text, start, '`')
        val close = findRun(text, start + run, '`', run)
        if (close < 0) {
            literal.append(text, start, start + run)
            return run
        }
        flush(literal)
        withStyle(codeStyle) { append(text.substring(start + run, close)) }
        return close + run - start
    }

    /** `*x*` / `_x_` (emphasis) and `**x**` / `__x__` (strong). */
    private fun AnnotatedString.Builder.emphasis(
        text: String,
        start: Int,
        marker: Char,
        linkStyle: SpanStyle,
        depth: Int,
        literal: StringBuilder,
    ): Int {
        val run = minOf(runLength(text, start, marker), 3)
        // CommonMark forbids intra-word `_` so that snake_case survives as typed. `*` has no such
        // restriction, which is why the two markers are not interchangeable.
        if (marker == '_' && start > 0 && text[start - 1].isLetterOrDigit()) {
            literal.append(text, start, start + run)
            return run
        }
        val style = when (run) {
            3 -> strongEmphasisStyle
            2 -> strongStyle
            else -> emphasisStyle
        }
        return delimited(text, start, marker, run, style, linkStyle, depth, literal)
    }

    /**
     * The shared shape of `**x**`, `*x*` and `~~x~~`: a delimiter run, content, the same run again.
     * Content is re-parsed so delimiters nest.
     */
    @Suppress("LongParameterList")
    private fun AnnotatedString.Builder.delimited(
        text: String,
        start: Int,
        marker: Char,
        run: Int,
        style: SpanStyle,
        linkStyle: SpanStyle,
        depth: Int,
        literal: StringBuilder,
    ): Int {
        val actualRun = minOf(runLength(text, start, marker), run)
        if (actualRun < run) {
            literal.append(text, start, start + actualRun)
            return actualRun
        }
        val contentStart = start + run
        val close = findClose(text, contentStart, marker, run)
        // An empty span (`**` immediately closed) is not emphasis; nor is an unclosed run, which
        // stays literal so a half-arrived stream chunk still reads correctly.
        if (close <= contentStart) {
            literal.append(text, start, contentStart)
            return run
        }
        flush(literal)
        withStyle(style) { appendInline(text.substring(contentStart, close), linkStyle, depth + 1) }
        return close + run - start
    }

    /** `[label](url)`. The label is parsed; the destination is taken verbatim. */
    private fun AnnotatedString.Builder.link(
        text: String,
        start: Int,
        linkStyle: SpanStyle,
        depth: Int,
        literal: StringBuilder,
    ): Int {
        val labelEnd = findLabelEnd(text, start + 1)
        if (labelEnd < 0 || labelEnd + 1 >= text.length || text[labelEnd + 1] != '(') {
            literal.append('[')
            return 1
        }
        val urlEnd = text.indexOf(')', labelEnd + 2)
        if (urlEnd < 0) {
            literal.append('[')
            return 1
        }
        val url = text.substring(labelEnd + 2, urlEnd)
        flush(literal)
        withLink(LinkAnnotation.Url(url)) {
            withStyle(linkStyle) {
                appendInline(text.substring(start + 1, labelEnd), linkStyle, depth + 1)
            }
        }
        return urlEnd + 1 - start
    }

    /** Index of the `]` closing the label opened before [from], honouring nesting. -1 if absent. */
    private fun findLabelEnd(text: String, from: Int): Int {
        var open = 0
        var i = from
        while (i < text.length) {
            when {
                text[i] == '\\' -> i++
                text[i] == '[' -> open++
                text[i] == ']' -> if (open == 0) return i else open--
            }
            i++
        }
        return -1
    }

    /** How many consecutive [marker] characters start at [start]. */
    private fun runLength(text: String, start: Int, marker: Char): Int {
        var i = start
        while (i < text.length && text[i] == marker) i++
        return i - start
    }

    /**
     * The closing delimiter for an emphasis/strikethrough span: a run of [marker] of at least
     * [run], not preceded by whitespace (so `a * b * c` stays literal), and — for `_` — not
     * followed by a word character.
     */
    private fun findClose(text: String, from: Int, marker: Char, run: Int): Int {
        var i = from
        while (i < text.length) {
            if (text[i] == '\\') {
                i += 2
                continue
            }
            if (text[i] == marker && runLength(text, i, marker) >= run) {
                val precededByContent = i > from && !text[i - 1].isWhitespace()
                val after = i + run
                val closesWord = marker != '_' || after >= text.length || !text[after].isLetterOrDigit()
                if (precededByContent && closesWord) return i
                i += runLength(text, i, marker)
                continue
            }
            i++
        }
        return -1
    }

    /** The next run of at least [len] [marker] characters at or after [from]. -1 if absent. */
    private fun findRun(text: String, from: Int, marker: Char, len: Int): Int {
        var i = from
        while (i < text.length) {
            if (text[i] == marker) {
                val length = runLength(text, i, marker)
                if (length >= len) return i
                i += length
            } else {
                i++
            }
        }
        return -1
    }
}
