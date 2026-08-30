import { describe, expect, it } from "vitest";

import { parseInlineMarkdown, type InlineSegment } from "./InlineMarkdown";

/**
 * The inline-Markdown parser that stands in for
 * `AttributedString(markdown:options: .inlineOnlyPreservingWhitespace)`.
 *
 * The first block is `InlineMarkdownTest.kt` ported case for case; the second covers the things
 * that are only hazards on the web — UTF-16 surrogates, `href` schemes, and a recursion bound that
 * has to hold on the same thread as the UI. Nothing here touches a DOM: this file runs under
 * vitest's `node` environment like the rest of the pure layer.
 *
 * Assertions are on whole segment arrays rather than on one property at a time, so a change that
 * adds or moves a run fails here instead of passing because the property that was probed happened
 * to survive.
 */

/** The visible text: what an iOS reader sees, with markers gone and destinations moved to `href`. */
function visible(segments: InlineSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

describe("parseInlineMarkdown, ported from InlineMarkdownTest.kt", () => {
  it("strips the markers of strong emphasis and bolds the content", () => {
    expect(parseInlineMarkdown("say **this** loudly")).toEqual([
      { text: "say " },
      { text: "this", bold: true },
      { text: " loudly" },
    ]);
  });

  it("treats single markers as emphasis, not strong", () => {
    expect(parseInlineMarkdown("*quietly*")).toEqual([{ text: "quietly", italic: true }]);
  });

  it("treats a triple run as both", () => {
    expect(parseInlineMarkdown("***both***")).toEqual([
      { text: "both", bold: true, italic: true },
    ]);
  });

  it("leaves an unclosed marker literal so a half-arrived chunk still reads", () => {
    // The case the Swift doc comment names: markdown is re-parsed on every streamed update, so the
    // opening marker of a bold run arrives whole turns before its closing one.
    expect(visible(parseInlineMarkdown("**still typing"))).toBe("**still typing");
    expect(visible(parseInlineMarkdown("a *partial"))).toBe("a *partial");
    expect(visible(parseInlineMarkdown("`unterminated code"))).toBe("`unterminated code");

    // And none of them picks up a style on the way through.
    for (const source of ["**still typing", "a *partial", "`unterminated code"]) {
      expect(parseInlineMarkdown(source)).toEqual([{ text: source }]);
    }
  });

  it("composes the styles when spans nest", () => {
    expect(parseInlineMarkdown("**bold with *italic* inside**")).toEqual([
      { text: "bold with ", bold: true },
      { text: "italic", bold: true, italic: true },
      { text: " inside", bold: true },
    ]);
  });

  it("does not parse the inside of a code span", () => {
    expect(parseInlineMarkdown("run `a **b** c` now")).toEqual([
      { text: "run " },
      { text: "a **b** c", code: true },
      { text: " now" },
    ]);
  });

  it("requires both tildes for strikethrough", () => {
    expect(parseInlineMarkdown("~~gone~~")).toEqual([{ text: "gone", strikethrough: true }]);
    expect(parseInlineMarkdown("a ~ b")).toEqual([{ text: "a ~ b" }]);
  });

  it("leaves underscores inside a word alone", () => {
    // A model reply that names an identifier must not have half of it italicised.
    expect(parseInlineMarkdown("call some_long_name here")).toEqual([
      { text: "call some_long_name here" },
    ]);
  });

  it("keeps an underscore that opens inside a word literal even when it closes cleanly", () => {
    // The discriminating case. `some_long_name` survives on the CLOSING rule alone (its second
    // underscore is followed by a letter), so it does not prove the opening rule does anything.
    // Here the closing underscore is followed by a space, so only the opening rule can save it.
    expect(parseInlineMarkdown("call some_word_ here")).toEqual([{ text: "call some_word_ here" }]);
  });

  it("still emphasises underscores at word boundaries", () => {
    expect(parseInlineMarkdown("_stressed_")).toEqual([{ text: "stressed", italic: true }]);
  });

  it("will not close a `_` run that a word character follows", () => {
    // The other half of the intra-word rule, and the half the opening rule cannot cover: the
    // middle underscore here is a valid closer by position, and is refused only because a letter
    // follows it. Without this the span would end early and leave `b_` stranded outside it.
    expect(parseInlineMarkdown("_a_b_")).toEqual([{ text: "a_b", italic: true }]);
  });

  it("suppresses a marker behind a backslash escape", () => {
    expect(parseInlineMarkdown("literal \\*stars\\*")).toEqual([{ text: "literal *stars*" }]);
  });

  it("keeps a link's label and carries its destination", () => {
    expect(parseInlineMarkdown("see [the docs](https://example.com) for more")).toEqual([
      { text: "see " },
      { text: "the docs", href: "https://example.com" },
      { text: " for more" },
    ]);
  });

  it("preserves whitespace and newlines", () => {
    // `inlineOnlyPreservingWhitespace` is the option Swift passes precisely so a reply's own line
    // breaks survive; collapsing them would reflow every list the model writes.
    expect(parseInlineMarkdown("first line\n\n  indented **second**")).toEqual([
      { text: "first line\n\n  indented " },
      { text: "second", bold: true },
    ]);
  });

  it("leaves a marker with nothing between the runs literal", () => {
    expect(parseInlineMarkdown("****")).toEqual([{ text: "****" }]);
    expect(parseInlineMarkdown("a ** b")).toEqual([{ text: "a ** b" }]);
  });

  it("terminates on deeply nested markers instead of recursing away", () => {
    const source = "*".repeat(60) + "x" + "*".repeat(60);

    // The only assertion that matters is that this returns at all.
    expect(visible(parseInlineMarkdown(source))).toContain("x");
  });

  // `renderMessageText` — the user-verbatim / assistant-parsed split the last two Kotlin cases
  // cover — is the renderer's job, not this file's, and has no web counterpart yet. Those two
  // cases belong with it when it lands, not here where they would have nothing to call.
});

describe("parseInlineMarkdown on the web specifically", () => {
  it("never loses visible content, however malformed the source", () => {
    // Round-tripping: the concatenated segment text is exactly what a reader sees. Markers that
    // parsed disappear; everything else — including a broken construct's own punctuation — stays.
    const corpus: ReadonlyArray<readonly [string, string]> = [
      ["", ""],
      ["plain text", "plain text"],
      ["**bold** and *italic* and ~~struck~~ and `code`", "bold and italic and struck and code"],
      ["unclosed **bold", "unclosed **bold"],
      ["unclosed ~~strike", "unclosed ~~strike"],
      ["[label](", "[label]("],
      ["[label]", "[label]"],
      ["[label] (not a url)", "[label] (not a url)"],
      ["a trailing backslash \\", "a trailing backslash \\"],
      ["\\", "\\"],
      ["\\q is not escapable", "\\q is not escapable"],
      ["***", "***"],
      // `*_*` is emphasis around a literal underscore; the trailing `_*` never closes.
      ["*_*_*", "__*"],
      ["~~~", "~~~"],
      ["``", "``"],
      ["`` ` ``", " ` "],
      ["# not a heading", "# not a heading"],
      ["- not a list\n> not a quote", "- not a list\n> not a quote"],
      ["```\nnot a fence\n```", "\nnot a fence\n"],
      ["  leading and trailing  ", "  leading and trailing  "],
      ["snake_case_name", "snake_case_name"],
      ["[a](b)[c](d)", "ac"],
      ["**a *b* c**", "a b c"],
      // Eight nested links with an empty innermost label. This is the one input that reaches the
      // depth guard with nothing left to emit, so it is what proves a zero-width run never lands
      // in the output.
      ["[".repeat(8) + "](u)".repeat(8), ""],
    ];

    for (const [source, expected] of corpus) {
      const segments = parseInlineMarkdown(source);
      expect(visible(segments), `visible text of ${JSON.stringify(source)}`).toBe(expected);
      // No zero-width runs: an empty segment is a rendering artefact, never content.
      expect(segments.every((segment) => segment.text.length > 0)).toBe(true);
    }
  });

  it("keeps every character of a source with no link, since only a link hides text", () => {
    // Stronger than the table above for the cases it applies to: a link is the only construct that
    // moves text out of the visible string, so everything else can only ever lose markers.
    const sources = [
      "**bold** *italic* ~~struck~~ `code` \\*escaped\\*",
      "mixed **a `b` c** and _d_",
      "a\tb\nc",
    ];

    for (const source of sources) {
      const kept = visible(parseInlineMarkdown(source));
      const markers = new Set(["*", "_", "~", "`", "\\"]);
      const expected = [...source].filter((c) => !markers.has(c)).join("");
      expect([...kept].filter((c) => !markers.has(c)).join("")).toBe(expected);
    }
  });

  it("never splits an astral character across segments", () => {
    // JS strings are UTF-16 code units, so a naive index-based scan can cut a surrogate pair in
    // half and hand the renderer two replacement characters. Every delimiter here is ASCII and no
    // surrogate is ever equal to an ASCII character, so a cut can only land between code points —
    // this is the assertion that the reasoning holds.
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}";
    const sources = [
      `**\u{1F389} done \u{1F389}**`,
      `*${family}*`,
      `~~\u{1F600}~~`,
      `\`\u{1F4BB}\``,
      `[\u{1F4D6} docs](https://example.com)`,
      `a \u{1F389}**b**\u{1F389} c`,
    ];

    for (const source of sources) {
      for (const segment of parseInlineMarkdown(source)) {
        expect(segment.text, `lone surrogate in ${JSON.stringify(segment.text)}`).not.toMatch(
          LONE_SURROGATE,
        );
      }
    }

    expect(parseInlineMarkdown(`**\u{1F389} done \u{1F389}**`)).toEqual([
      { text: "\u{1F389} done \u{1F389}", bold: true },
    ]);
    expect(parseInlineMarkdown(`*${family}*`)).toEqual([{ text: family, italic: true }]);
  });

  it("treats an emoji as a word boundary for the intra-word underscore rule", () => {
    // The low surrogate before the `_` is not a letter or a digit — `Character.isLetterOrDigit`
    // says the same of an unpaired surrogate — so emphasis opens here, unlike after a letter.
    expect(parseInlineMarkdown("\u{1F389}_x_")).toEqual([
      { text: "\u{1F389}" },
      { text: "x", italic: true },
    ]);
    expect(parseInlineMarkdown("a_x_")).toEqual([{ text: "a_x_" }]);
  });

  it("uses Kotlin's whitespace definition, not JavaScript's, for the closing rule", () => {
    // `findClose` refuses a run preceded by whitespace, so `a * b * c` stays literal. Which
    // characters count is where Java and JavaScript disagree, and the Kotlin is the spec here.
    // The ordinary case, which both definitions agree on:
    expect(parseInlineMarkdown("*a *")).toEqual([{ text: "*a *" }]);
    // Java's `Character.isWhitespace` excludes the non-breaking spaces, so this one closes even
    // though JavaScript's `\s` would call U+00A0 whitespace and refuse it:
    expect(parseInlineMarkdown("*a\u00a0*")).toEqual([{ text: "a\u00a0", italic: true }]);
    // …and it counts U+001C-U+001F, which `\s` does not, so this one stays literal:
    expect(parseInlineMarkdown("*a\u001c*")).toEqual([{ text: "*a\u001c*" }]);
  });

  it("stops the URL at the first close paren, as the Kotlin does", () => {
    // `InlineMarkdown.kt:191` uses `indexOf(')')`, so a destination containing a paren is cut
    // there and the remainder falls back to literal text. Ported as-is; the point of the case is
    // that the leftover `)` is still visible rather than swallowed.
    expect(parseInlineMarkdown("[map](https://ex.com/a(b))")).toEqual([
      { text: "map", href: "https://ex.com/a(b" },
      { text: ")" },
    ]);
  });

  it("refuses to put a script-bearing scheme in an href, keeping the label", () => {
    // Web-only. Compose's `LinkAnnotation.Url` is not an XSS vector; an `href` is, and this text
    // comes from a language model. The label still renders — dropping it would lose content.
    const hostile = [
      "[click](javascript:void)",
      "[click](JaVaScRiPt:void)",
      "[click](java\tscript:void)",
      "[click](\u0001javascript:void)",
      "[click](java\nscript:void)",
      "[click](  javascript:void)",
      "[click](data:text/html,hi)",
      "[click](vbscript:msgbox)",
      "[click](file:///etc/passwd)",
    ];

    for (const source of hostile) {
      const segments = parseInlineMarkdown(source);
      expect(visible(segments), source).toBe("click");
      for (const segment of segments) {
        expect(segment.href, source).toBeUndefined();
      }
    }
  });

  it("still allows the schemes that merely navigate", () => {
    const allowed: ReadonlyArray<readonly [string, string]> = [
      ["[a](https://example.com/x?y=1#z)", "https://example.com/x?y=1#z"],
      ["[a](http://example.com)", "http://example.com"],
      ["[a](HTTPS://EXAMPLE.COM)", "HTTPS://EXAMPLE.COM"],
      ["[a](mailto:someone@example.com)", "mailto:someone@example.com"],
      ["[a](tel:+15555550123)", "tel:+15555550123"],
      ["[a](/docs/guide)", "/docs/guide"],
      ["[a](#section)", "#section"],
      ["[a](example.com/path)", "example.com/path"],
    ];

    for (const [source, href] of allowed) {
      expect(parseInlineMarkdown(source), source).toEqual([{ text: "a", href }]);
    }
  });

  it("bounds recursion at MAX_DEPTH and dumps the rest verbatim", () => {
    // Twelve nested links recurse once per label. The eight innermost never get parsed: past the
    // bound the remaining text is emitted as-is, which is why the raw `](u)` shows up in the
    // output. What matters is that this returns, quickly, with the content intact.
    const depth = 12;
    const source = "[".repeat(depth) + "x" + "](u)".repeat(depth);

    const started = Date.now();
    const segments = parseInlineMarkdown(source);
    expect(Date.now() - started).toBeLessThan(1000);

    const text = visible(segments);
    expect(text).toContain("x");
    // The bound actually engaged: unparsed link syntax survives into the visible text.
    expect(text).toContain("](u)");
    // And it engaged at MAX_DEPTH, not earlier — the outer eight wrappers did parse as links.
    expect(text.split("](u)").length - 1).toBe(depth - 8);
  });

  it("does not hang or throw on pathological delimiter soup", () => {
    const pathological = [
      "*".repeat(2000),
      "_".repeat(2000),
      "~".repeat(2000),
      "`".repeat(2000),
      "[".repeat(2000),
      "**a".repeat(500),
      "[a](".repeat(500),
      "\\".repeat(2000),
      "*_~`[".repeat(400),
    ];

    for (const source of pathological) {
      const started = Date.now();
      expect(() => parseInlineMarkdown(source)).not.toThrow();
      expect(Date.now() - started, source.slice(0, 8)).toBeLessThan(2000);
    }
  });
});

/** A high surrogate with no low after it, or a low surrogate with no high before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
