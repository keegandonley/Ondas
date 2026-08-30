/**
 * The counterpart of Swift's
 * `AttributedString(markdown:options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))`
 * (`Ondas/Features/Chat/MessageBubble.swift:100-109`).
 *
 * Ported from `android/app/src/main/kotlin/com/keegancodes/ondas/features/chat/InlineMarkdown.kt`,
 * which solved this exact problem against the same Swift behaviour. The semantics below are that
 * file's, not a fresh derivation — the Kotlin is the spec for this file the way the Swift is the
 * spec for the Kotlin.
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
 * ### Why this returns data rather than markup
 *
 * Swift builds an `AttributedString` and Android an `AnnotatedString`. Neither is a string of
 * markup, and neither should this be: emitting HTML here would silently make this file responsible
 * for escaping model output, which is how a renderer detail becomes an injection bug. The output
 * is a flat list of styled runs; the renderer is a separate concern.
 *
 * Every path here is total: unmatched delimiters degrade to literal text rather than throwing.
 * That is what Swift's `try?` fallback buys on iOS — a defect here can only ever cost the
 * formatting, never the message.
 */

/** One run of text carrying a single, already-merged set of inline styles. */
export interface InlineSegment {
  readonly text: string;
  /** `**x**` or `__x__`. */
  readonly bold?: boolean;
  /** `*x*` or `_x_`. */
  readonly italic?: boolean;
  /** `~~x~~`. */
  readonly strikethrough?: boolean;
  /** A backtick code span. Its content is never parsed further, per CommonMark. */
  readonly code?: boolean;
  /**
   * The destination of the `[label](url)` this run sits inside. Absent when the run is not a link,
   * or when the destination failed {@link isSafeHref} — see the note there.
   */
  readonly href?: string;
}

/**
 * Parses `source` into styled inline runs, in source order. Concatenating every `text` gives the
 * visible text — the string an iOS reader would see, with markers removed and link destinations
 * moved into {@link InlineSegment.href}.
 */
export function parseInlineMarkdown(source: string): InlineSegment[] {
  const out: InlineSegment[] = [];
  appendInline(out, source, PLAIN, 0);
  return out;
}

/**
 * Bound on recursion through nested delimiters. Deeper than any real message and shallow enough
 * that a pathological input (`****…`, or brackets nested by the hundred) cannot exhaust the stack
 * mid-stream. Past it the remaining text is emitted verbatim rather than parsed.
 */
const MAX_DEPTH = 8;

const ESCAPABLE = "\\`*_{}[]()#+-.!~>|";

/** The full style state carried down through nesting. Mirrors a merged Compose `SpanStyle`. */
interface Style {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly strikethrough: boolean;
  readonly code: boolean;
  readonly href: string | undefined;
}

/**
 * A style delta applied on entering a span. Like `SpanStyle.merge`, a patch only ever turns a
 * property on — nothing inside a bold run can un-bold itself.
 */
type StylePatch = Partial<Omit<Style, "href">>;

const PLAIN: Style = {
  bold: false,
  italic: false,
  strikethrough: false,
  code: false,
  href: undefined,
};

const STRONG: StylePatch = { bold: true };
const EMPHASIS: StylePatch = { italic: true };
const STRONG_EMPHASIS: StylePatch = { bold: true, italic: true };
const CODE: StylePatch = { code: true };
const STRIKE: StylePatch = { strikethrough: true };

function merged(base: Style, patch: StylePatch): Style {
  return {
    bold: patch.bold ?? base.bold,
    italic: patch.italic ?? base.italic,
    strikethrough: patch.strikethrough ?? base.strikethrough,
    code: patch.code ?? base.code,
    href: base.href,
  };
}

/**
 * The pending literal run: the direct equivalent of the Kotlin's `StringBuilder`, boxed so the
 * helpers below can append into a caller's buffer the way its extension functions do.
 */
interface Literal {
  value: string;
}

/**
 * Appends a segment. Skipping the empty case matches the Kotlin's `if (literal.isNotEmpty())` and
 * keeps zero-width runs — `**` immediately closed, a link with an empty label — out of the output.
 *
 * Only the properties actually set are written, so a plain run is `{ text }` and nothing else.
 * `exactOptionalPropertyTypes` forbids the alternative of assigning `undefined`, and the narrower
 * objects let the tests assert whole segments rather than probing them one property at a time.
 */
function emit(out: InlineSegment[], text: string, style: Style): void {
  if (text.length === 0) {
    return;
  }
  out.push({
    text,
    ...(style.bold ? { bold: true } : {}),
    ...(style.italic ? { italic: true } : {}),
    ...(style.strikethrough ? { strikethrough: true } : {}),
    ...(style.code ? { code: true } : {}),
    ...(style.href !== undefined ? { href: style.href } : {}),
  });
}

/** Emits and clears the pending literal run, so styled spans land in source order. */
function flush(out: InlineSegment[], literal: Literal, style: Style): void {
  if (literal.value.length > 0) {
    emit(out, literal.value, style);
    literal.value = "";
  }
}

/**
 * The main scan. Every branch consumes at least one character, which is what makes this loop
 * total: the give-up branches below return the length of the run they declined to parse, never
 * zero, so no input can spin here.
 */
function appendInline(out: InlineSegment[], text: string, style: Style, depth: number): void {
  if (depth >= MAX_DEPTH) {
    emit(out, text, style);
    return;
  }
  const literal: Literal = { value: "" };
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    let consumed: number;
    if (c === "\\" && i + 1 < text.length && ESCAPABLE.includes(text.charAt(i + 1))) {
      literal.value += text.charAt(i + 1);
      consumed = 2;
    } else if (c === "`") {
      consumed = codeSpan(out, text, i, style, literal);
    } else if (c === "~") {
      consumed = delimited(out, text, i, "~", 2, STRIKE, style, depth, literal);
    } else if (c === "*" || c === "_") {
      consumed = emphasis(out, text, i, c, style, depth, literal);
    } else if (c === "[") {
      consumed = link(out, text, i, style, depth, literal);
    } else {
      literal.value += c;
      consumed = 1;
    }
    i += consumed;
  }
  flush(out, literal, style);
}

/**
 * A code span: the content is NOT parsed further, per CommonMark. Returns how many characters of
 * `text` were consumed.
 */
function codeSpan(
  out: InlineSegment[],
  text: string,
  start: number,
  style: Style,
  literal: Literal,
): number {
  const run = runLength(text, start, "`");
  const close = findRun(text, start + run, "`", run);
  if (close < 0) {
    literal.value += text.slice(start, start + run);
    return run;
  }
  flush(out, literal, style);
  emit(out, text.slice(start + run, close), merged(style, CODE));
  return close + run - start;
}

/** `*x*` / `_x_` (emphasis) and `**x**` / `__x__` (strong). */
function emphasis(
  out: InlineSegment[],
  text: string,
  start: number,
  marker: string,
  style: Style,
  depth: number,
  literal: Literal,
): number {
  const run = Math.min(runLength(text, start, marker), 3);
  // CommonMark forbids intra-word `_` so that snake_case survives as typed. `*` has no such
  // restriction, which is why the two markers are not interchangeable.
  if (marker === "_" && start > 0 && isLetterOrDigit(text.charAt(start - 1))) {
    literal.value += text.slice(start, start + run);
    return run;
  }
  const patch = run === 3 ? STRONG_EMPHASIS : run === 2 ? STRONG : EMPHASIS;
  return delimited(out, text, start, marker, run, patch, style, depth, literal);
}

/**
 * The shared shape of `**x**`, `*x*` and `~~x~~`: a delimiter run, content, the same run again.
 * Content is re-parsed so delimiters nest.
 */
function delimited(
  out: InlineSegment[],
  text: string,
  start: number,
  marker: string,
  run: number,
  patch: StylePatch,
  style: Style,
  depth: number,
  literal: Literal,
): number {
  const actualRun = Math.min(runLength(text, start, marker), run);
  if (actualRun < run) {
    literal.value += text.slice(start, start + actualRun);
    return actualRun;
  }
  const contentStart = start + run;
  const close = findClose(text, contentStart, marker, run);
  // An empty span (`**` immediately closed) is not emphasis; nor is an unclosed run, which stays
  // literal so a half-arrived stream chunk still reads correctly.
  if (close <= contentStart) {
    literal.value += text.slice(start, contentStart);
    return run;
  }
  flush(out, literal, style);
  appendInline(out, text.slice(contentStart, close), merged(style, patch), depth + 1);
  return close + run - start;
}

/** `[label](url)`. The label is parsed; the destination is taken verbatim if {@link isSafeHref}. */
function link(
  out: InlineSegment[],
  text: string,
  start: number,
  style: Style,
  depth: number,
  literal: Literal,
): number {
  const labelEnd = findLabelEnd(text, start + 1);
  if (labelEnd < 0 || labelEnd + 1 >= text.length || text.charAt(labelEnd + 1) !== "(") {
    literal.value += "[";
    return 1;
  }
  const urlEnd = text.indexOf(")", labelEnd + 2);
  if (urlEnd < 0) {
    literal.value += "[";
    return 1;
  }
  const url = text.slice(labelEnd + 2, urlEnd);
  flush(out, literal, style);
  // A rejected destination costs the link, not the label: the words the model wrote still render,
  // they just do not navigate. Dropping the whole construct would lose visible text.
  const href = isSafeHref(url) ? url : style.href;
  appendInline(out, text.slice(start + 1, labelEnd), { ...style, href }, depth + 1);
  return urlEnd + 1 - start;
}

/**
 * Whether a link destination may be handed to an `href`.
 *
 * **This has no counterpart in the Kotlin and is a deliberate web-only addition.** Compose's
 * `LinkAnnotation.Url` hands the destination to the platform's URL opener, which will not execute
 * script; an `href` in a page will, and this text comes from a language model. The allowlist is
 * therefore positive — the schemes we know merely navigate — rather than a blocklist of
 * `javascript:` and `data:`, because a blocklist has to anticipate every spelling and this does
 * not.
 *
 * The test runs against a normalised copy: browsers strip C0 controls and spaces out of a URL
 * before resolving its scheme, so `java<TAB>script:` is `javascript:` to them and must be here
 * too. The *original* string is what gets emitted when the normalised form passes, because the
 * browser will perform that same normalisation itself.
 *
 * A destination with no scheme at all — `/docs`, `#section`, `example.com/x` — is relative and
 * always allowed.
 */
function isSafeHref(url: string): boolean {
  const normalised = url.replace(CONTROLS_AND_SPACE, "").toLowerCase();
  const scheme = SCHEME.exec(normalised);
  if (scheme === null) {
    return true;
  }
  return SAFE_SCHEMES.has(scheme[0]);
}

const CONTROLS_AND_SPACE = /[\u0000-\u0020\u007f]/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/;
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

/** Index of the `]` closing the label opened before `from`, honouring nesting. -1 if absent. */
function findLabelEnd(text: string, from: number): number {
  let open = 0;
  let i = from;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === "\\") {
      i++;
    } else if (c === "[") {
      open++;
    } else if (c === "]") {
      if (open === 0) {
        return i;
      }
      open--;
    }
    i++;
  }
  return -1;
}

/** How many consecutive `marker` characters start at `start`. */
function runLength(text: string, start: number, marker: string): number {
  let i = start;
  while (i < text.length && text.charAt(i) === marker) {
    i++;
  }
  return i - start;
}

/**
 * The closing delimiter for an emphasis/strikethrough span: a run of `marker` of at least `run`,
 * not preceded by whitespace (so `a * b * c` stays literal), and — for `_` — not followed by a
 * word character.
 */
function findClose(text: string, from: number, marker: string, run: number): number {
  let i = from;
  while (i < text.length) {
    if (text.charAt(i) === "\\") {
      i += 2;
      continue;
    }
    if (text.charAt(i) === marker && runLength(text, i, marker) >= run) {
      const precededByContent = i > from && !isWhitespace(text.charAt(i - 1));
      const after = i + run;
      const closesWord =
        marker !== "_" || after >= text.length || !isLetterOrDigit(text.charAt(after));
      if (precededByContent && closesWord) {
        return i;
      }
      i += runLength(text, i, marker);
      continue;
    }
    i++;
  }
  return -1;
}

/** The next run of at least `len` `marker` characters at or after `from`. -1 if absent. */
function findRun(text: string, from: number, marker: string, len: number): number {
  let i = from;
  while (i < text.length) {
    if (text.charAt(i) === marker) {
      const length = runLength(text, i, marker);
      if (length >= len) {
        return i;
      }
      i += length;
    } else {
      i++;
    }
  }
  return -1;
}

/**
 * `Character.isLetterOrDigit`, over a single UTF-16 code unit.
 *
 * Scanning by code unit rather than by code point is safe, and is what the Kotlin does — a
 * `String` there is UTF-16 too. Every delimiter this parser knows is ASCII, and no surrogate is
 * ever equal to an ASCII character, so a span can only ever be cut at a position that is not
 * inside a surrogate pair. An astral character therefore survives emphasis intact rather than
 * arriving as two half-characters in adjacent segments.
 *
 * Where the *neighbour* being tested is itself a lone surrogate — `emoji_x_` — this says false,
 * matching `Character.isLetterOrDigit`, which classifies an unpaired surrogate as neither a letter
 * nor a digit. So emphasis opens after an emoji, and does not open inside a word.
 *
 * `\p{L}` plus `\p{Nd}` is precisely `Character.isLetter() || Character.isDigit()`; `\p{N}` would
 * wrongly pull in Nl and No.
 */
function isLetterOrDigit(c: string): boolean {
  return LETTER_OR_DIGIT.test(c);
}

const LETTER_OR_DIGIT = /^[\p{L}\p{Nd}]$/u;

/**
 * Kotlin's `Char.isWhitespace`, transcribed: the Unicode space separators *except* the
 * non-breaking ones (U+00A0, U+2007, U+202F), plus the C0 whitespace and the file/group/record/
 * unit separators.
 *
 * This is deliberately not JavaScript's `\s`, which counts U+00A0 and U+FEFF and omits
 * U+001C-U+001F. CommonMark would side with `\s`; the Kotlin is the spec for this port, and the
 * only thing riding on the difference is whether a run preceded by a non-breaking space closes.
 */
function isWhitespace(c: string): boolean {
  return JAVA_WHITESPACE.test(c);
}

const JAVA_WHITESPACE =
  /^[\t\n\v\f\r\u001c-\u001f \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]$/;
