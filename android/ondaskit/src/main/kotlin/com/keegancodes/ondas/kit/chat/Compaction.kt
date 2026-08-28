package com.keegancodes.ondas.kit.chat

import com.keegancodes.ondas.kit.models.ChatMessage

/**
 * Pure helpers for conversation compaction — the "Continue" flow that summarises a full chat into
 * a divider and keeps going in the *same* conversation (same id, so the telemetry `session.id`
 * stays continuous).
 *
 * Model of a compacted conversation: a compaction marker ([ChatMessage.isCompactionSummary])
 * carries a summary of everything before it and is **appended at the end** when the user taps
 * Continue. So the divider renders right at the seam: every turn above it is summarised history
 * (still on screen, but no longer fed to the model) and the chat resumes below it. The model
 * continues from the summary alone — no verbatim tail is kept.
 *
 * That last point is load-bearing history, not a detail. An earlier Swift design kept a verbatim
 * tail and placed the marker above it, which meant a chat filled by a few large messages could
 * summarise and re-feed the same turns — no reduction, then a permanent silent no-op. Position
 * encoding the split is what makes that failure structurally impossible.
 */
public object Compaction {
    /**
     * Index of the most recent compaction marker, or null when the conversation has never been
     * compacted.
     */
    public fun lastMarkerIndex(ordered: List<ChatMessage>): Int? =
        ordered.indexOfLast { it.isCompactionSummary }.takeIf { it >= 0 }

    /** The active summary (the last marker's text), or null when uncompacted. */
    public fun activeSummary(ordered: List<ChatMessage>): String? =
        lastMarkerIndex(ordered)?.let { ordered[it].text }

    /**
     * The real (non-error, non-marker) turns after the last marker — all real turns when
     * uncompacted. This is exactly what still feeds the model and what the capacity budget grows
     * against, so a compaction empties it and the chat is no longer stuck at capacity. It is also
     * the set summarised by the next compaction.
     */
    public fun liveMessages(ordered: List<ChatMessage>): List<ChatMessage> {
        val start = lastMarkerIndex(ordered)?.plus(1) ?: 0
        return ordered.subList(start, ordered.size).filter(::isRealTurn)
    }

    /**
     * The count the capacity fallback compares against `Conversation.MESSAGE_LIMIT`: the live
     * turns since the last compaction. Token counting is the primary budget when available.
     */
    public fun capacityCount(ordered: List<ChatMessage>): Int = liveMessages(ordered).size

    /**
     * A real chat turn: neither an app-generated error notice nor a compaction marker. Both are
     * excluded from everything the model sees and from the capacity budget.
     */
    private fun isRealTurn(message: ChatMessage): Boolean =
        !message.isError && !message.isCompactionSummary
}
