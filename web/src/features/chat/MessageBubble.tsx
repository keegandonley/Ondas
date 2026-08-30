"use client";

import { useEffect, useState } from "react";

import { ChatRole } from "../../kit/models/ChatRole";
import type { ChatMessage } from "../../kit/models/ChatMessage";
import { Copy } from "../../ui/copy";
import { InlineMarkdownText } from "./InlineMarkdownText";

/**
 * Port of `Ondas/Features/Chat/MessageBubble.swift`.
 *
 * Alignment is by side, with a 40px minimum gutter opposite — a bubble may reach full width less
 * 40, never edge to edge (Swift's `Spacer(minLength: 40)`).
 *
 * NOT ported: the generated-image branch, the Save-to-Photos / Share context menu and the Photos
 * permission alert. Image generation is cut from web v1 (PORTING.md drift 1), so those are absent
 * rather than disabled.
 */
export function MessageBubble({
  message,
  isAwaitingResponse,
  isStreaming,
}: {
  message: ChatMessage;
  isAwaitingResponse: boolean;
  isStreaming: boolean;
}) {
  const isUser = message.role === ChatRole.user;

  return (
    <div className={`ondas-row ${isUser ? "ondas-row-user" : "ondas-row-assistant"}`}>
      <div className={`ondas-bubble ${isUser ? "ondas-bubble-user" : "ondas-bubble-assistant"}`}>
        {isAwaitingResponse ? (
          <ThinkingIndicator />
        ) : (
          <span className="ondas-bubble-text">
            {/* User text is never parsed as Markdown — `MessageBubble.swift:101`'s
                `Text(verbatim:)`. Someone typing `*hi*` should see their own asterisks. */}
            <InlineMarkdownText text={message.text} verbatim={isUser} />
            {isStreaming ? <StreamingCaret /> : null}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Swift blinks a `▍` on a 0.6s `TimelineView`, concatenated into the same `Text` (not overlaid) so
 * it wraps at the end of the last line rather than floating. Same trick here: it is a character in
 * the text flow, not a positioned element.
 */
function StreamingCaret() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setInterval(() => setVisible((shown) => !shown), 600);
    return () => clearInterval(timer);
  }, []);
  return <span aria-hidden="true">{visible ? " ▍" : " "}</span>;
}

/** Three dots, 7px, 5px apart, fading 1 → 0.3 over 0.6s with a 0.2s stagger. Swift's values. */
function ThinkingIndicator() {
  return (
    <span className="ondas-thinking" role="status" aria-label={Copy.assistantIsTyping}>
      {[0, 1, 2].map((index) => (
        <span key={index} className="ondas-dot" style={{ animationDelay: `${index * 0.2}s` }} />
      ))}
    </span>
  );
}
