package com.keegancodes.ondas.features.chat

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The inline-Markdown parser that stands in for
 * `AttributedString(markdown:options: .inlineOnlyPreservingWhitespace)`.
 *
 * A plain JUnit suite: nothing here touches Android, and the assertions are about the parse rather
 * than the pixels. What the transcript does with the result is covered by `ChatContentTest`.
 */
class InlineMarkdownTest {

    private val linkStyle = SpanStyle(color = Color.Blue, textDecoration = TextDecoration.Underline)

    private fun render(source: String) = InlineMarkdown.render(source, linkStyle)

    @Test
    fun `strong emphasis strips its markers and bolds the content`() {
        val result = render("say **this** loudly")

        assertEquals("say this loudly", result.text)
        assertEquals(FontWeight.Bold, styleAt(result, result.text.indexOf("this")).fontWeight)
        // The surrounding text is untouched.
        assertEquals(null, styleAt(result, 0).fontWeight)
    }

    @Test
    fun `single markers are emphasis, not strong`() {
        val result = render("*quietly*")

        assertEquals("quietly", result.text)
        assertEquals(FontStyle.Italic, styleAt(result, 0).fontStyle)
        assertEquals(null, styleAt(result, 0).fontWeight)
    }

    @Test
    fun `a triple run is both`() {
        val result = render("***both***")

        assertEquals("both", result.text)
        assertEquals(FontWeight.Bold, styleAt(result, 0).fontWeight)
        assertEquals(FontStyle.Italic, styleAt(result, 0).fontStyle)
    }

    @Test
    fun `an unclosed marker stays literal so a half-arrived chunk still reads`() {
        // The case the Swift doc comment names: markdown is re-parsed on every streamed update, so
        // the opening marker of a bold run arrives whole turns before its closing one.
        assertEquals("**still typing", render("**still typing").text)
        assertEquals("a *partial", render("a *partial").text)
        assertEquals("`unterminated code", render("`unterminated code").text)
    }

    @Test
    fun `nesting composes the styles`() {
        val result = render("**bold with *italic* inside**")

        assertEquals("bold with italic inside", result.text)
        val italicAt = result.text.indexOf("italic")
        assertEquals(FontWeight.Bold, styleAt(result, italicAt).fontWeight)
        assertEquals(FontStyle.Italic, styleAt(result, italicAt).fontStyle)
        assertEquals(null, styleAt(result, 0).fontStyle)
    }

    @Test
    fun `code spans are not parsed further`() {
        val result = render("run `a **b** c` now")

        assertEquals("run a **b** c now", result.text)
        val inside = result.text.indexOf("**b**")
        assertEquals(null, styleAt(result, inside).fontWeight)
    }

    @Test
    fun `strikethrough needs both tildes`() {
        assertEquals("gone", render("~~gone~~").text)
        assertEquals(
            TextDecoration.LineThrough,
            styleAt(render("~~gone~~"), 0).textDecoration,
        )
        assertEquals("a ~ b", render("a ~ b").text)
    }

    @Test
    fun `underscores inside a word are left alone`() {
        // A model reply that names an identifier must not have half of it italicised.
        assertEquals("call some_long_name here", render("call some_long_name here").text)
    }

    @Test
    fun `an underscore that opens inside a word is literal even when it closes cleanly`() {
        // The discriminating case. `some_long_name` survives on the CLOSING rule alone (the second
        // underscore is followed by a letter), so it does not prove the opening rule does anything.
        // Here the closing underscore is followed by a space, so only the opening rule can save it.
        assertEquals("call some_word_ here", render("call some_word_ here").text)
    }

    @Test
    fun `underscores at word boundaries still emphasise`() {
        val result = render("_stressed_")

        assertEquals("stressed", result.text)
        assertEquals(FontStyle.Italic, styleAt(result, 0).fontStyle)
    }

    @Test
    fun `backslash escapes suppress a marker`() {
        assertEquals("literal *stars*", render("literal \\*stars\\*").text)
    }

    @Test
    fun `links keep their label and carry the destination`() {
        val result = render("see [the docs](https://example.com) for more")

        assertEquals("see the docs for more", result.text)
        assertTrue(
            "expected a link annotation over the label",
            result.getLinkAnnotations(0, result.text.length).isNotEmpty(),
        )
    }

    @Test
    fun `whitespace and newlines are preserved`() {
        // `inlineOnlyPreservingWhitespace` is the option Swift passes precisely so a reply's own
        // line breaks survive; collapsing them would reflow every list the model writes.
        val source = "first line\n\n  indented **second**"

        assertEquals("first line\n\n  indented second", render(source).text)
    }

    @Test
    fun `a marker with nothing between the runs is literal`() {
        assertEquals("****", render("****").text)
        assertEquals("a ** b", render("a ** b").text)
    }

    @Test
    fun `deeply nested markers terminate instead of recursing away`() {
        val source = "*".repeat(60) + "x" + "*".repeat(60)

        // The only assertion that matters is that this returns at all.
        assertTrue(render(source).text.contains("x"))
    }

    @Test
    fun `user text is never parsed`() {
        val verbatim = renderMessageText(text = "**verbatim**", isUser = true, linkStyle = linkStyle)

        assertEquals("**verbatim**", verbatim.text)
        assertEquals(null, styleAt(verbatim, 0).fontWeight)
    }

    @Test
    fun `assistant text is parsed`() {
        val parsed = renderMessageText(text = "**parsed**", isUser = false, linkStyle = linkStyle)

        assertEquals("parsed", parsed.text)
        assertEquals(FontWeight.Bold, styleAt(parsed, 0).fontWeight)
    }

    /** The merged span style covering [index], or an empty one where nothing is styled. */
    private fun styleAt(text: androidx.compose.ui.text.AnnotatedString, index: Int): SpanStyle =
        text.spanStyles
            .filter { index >= it.start && index < it.end }
            .fold(SpanStyle()) { merged, range -> merged.merge(range.item) }
}
