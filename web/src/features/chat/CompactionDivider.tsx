"use client";

import { Copy } from "../../ui/copy";

/**
 * Port of `Ondas/Features/Chat/CompactionDivider.swift`.
 *
 * A hairline, the label, a hairline. Rendered in place of a bubble for a message whose
 * `isCompactionSummary` is set: everything above it is summarised history that no longer feeds
 * the model, and the chat resumes below.
 *
 * The visible label is uppercased with letter-spacing (Swift's `.textCase(.uppercase)` and
 * `.tracking(0.6)`), but the accessible name is the full sentence — a screen reader announcing
 * "CONVERSATION COMPACTED" tells you nothing about what happened to the messages above it.
 */
export function CompactionDivider() {
  return (
    <div className="ondas-divider" role="separator" aria-label={Copy.conversationCompactedAccessible}>
      <span className="ondas-divider-rule" aria-hidden="true" />
      <span className="ondas-divider-label" aria-hidden="true">
        {Copy.conversationCompacted}
      </span>
      <span className="ondas-divider-rule" aria-hidden="true" />
    </div>
  );
}
