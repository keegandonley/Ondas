"use client";

import { Fragment } from "react";

import { parseInlineMarkdown } from "./InlineMarkdown";
import type { InlineSegment } from "./InlineMarkdown";

/**
 * Renders inline Markdown, matching `MessageBubble.swift`'s treatment.
 *
 * Swift calls `AttributedString(markdown:options:)` with `.inlineOnlyPreservingWhitespace` for
 * ASSISTANT text only, wrapped in `try?` so an unparseable fragment degrades to plain text. User
 * text is rendered `Text(verbatim:)` — deliberately never parsed, so a user typing `*hi*` sees
 * their own asterisks back (`MessageBubble.swift:101`). That split lives here in `verbatim`.
 *
 * Whitespace is preserved by the caller's `white-space: pre-wrap`, which is the web equivalent of
 * `preservingWhitespace`; the parser leaves newlines in the segment text.
 */
export function InlineMarkdownText({
  text,
  verbatim = false,
}: {
  text: string;
  verbatim?: boolean;
}) {
  if (verbatim) return <>{text}</>;
  return (
    <>
      {parseInlineMarkdown(text).map((segment, index) => (
        <Fragment key={index}>{renderSegment(segment)}</Fragment>
      ))}
    </>
  );
}

function renderSegment(segment: InlineSegment) {
  let node: React.ReactNode = segment.text;

  if (segment.code) {
    node = <code className="ondas-code">{node}</code>;
  }
  if (segment.bold) node = <strong>{node}</strong>;
  if (segment.italic) node = <em>{node}</em>;
  if (segment.strikethrough) node = <s>{node}</s>;

  if (segment.href !== undefined) {
    // The parser already applied a scheme allowlist, so `javascript:` and `data:` destinations
    // arrive here with `href` absent and render as plain text. `noopener noreferrer` is belt and
    // braces on top of that: this text came from a language model, and a link it invented should
    // never get a handle on this window.
    node = (
      <a href={segment.href} target="_blank" rel="noopener noreferrer" className="ondas-link">
        {node}
      </a>
    );
  }
  return node;
}
