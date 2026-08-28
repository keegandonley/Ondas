package com.keegancodes.ondas.kit.models

import com.keegancodes.ondas.kit.chat.CapacityState
import com.keegancodes.ondas.kit.chat.Compaction
import com.keegancodes.ondas.kit.chat.TokenUsage
import kotlin.time.Clock
import kotlin.time.Instant
import java.util.UUID

/**
 * A single chat thread — the root aggregate that owns its messages.
 *
 * `reuseEmptyOrCreate` is NOT here: it needs a persistence context, so it lands with the Room
 * layer in spec #91. `latestImageMessage` is not ported — image generation is cut from v1.
 *
 * [messages] is non-null where Swift's is `[ChatMessage]?`. That Optional exists only because
 * CloudKit requires optional to-many relationships, and Swift reads it as `(messages ?? [])`
 * everywhere — so absent and empty already mean the same thing. Approved deviation, recorded in
 * PORTING.md § Spec #89 notes; do not "restore" the nullability.
 */
public data class Conversation(
    public val id: UUID = UUID.randomUUID(),
    public val title: String = DEFAULT_TITLE,
    public val createdAt: Instant = Clock.System.now(),
    /** Bumped whenever a message is added, so the conversation list can sort by recency. */
    public val updatedAt: Instant = createdAt,
    public val messages: List<ChatMessage> = emptyList(),
) {
    /** Messages in chronological (display) order. */
    public val orderedMessages: List<ChatMessage>
        get() = messages.sortedBy { it.createdAt }

    /**
     * The most recent message, for the list-row preview. Compaction markers are skipped so the
     * list shows a real turn rather than a summary divider.
     */
    public val latestMessage: ChatMessage?
        get() = orderedMessages.lastOrNull { !it.isCompactionSummary }

    public val hasMessages: Boolean
        get() = messages.isNotEmpty()

    /**
     * A one-line preview of the latest message for list rows.
     *
     * Swift additionally branches on an image-only message ("Image request" / "Generated image").
     * With image generation cut there is no such message on Android, so that branch is absent
     * rather than dead.
     */
    public val previewText: String
        get() = latestMessage?.text ?: "No messages yet"

    /**
     * Capacity standing from the message-count cap — the fallback used only when a token count is
     * unavailable; otherwise the token budget is the primary defence.
     *
     * Only the turns since the last compaction count, so a compacted chat is not stuck at
     * capacity. Error notices are excluded too: they are kept out of the replayed history, so they
     * consume none of the context budget this cap stands in for.
     */
    public val capacityState: CapacityState
        get() {
            val count = Compaction.capacityCount(orderedMessages)
            return when {
                count >= MESSAGE_LIMIT -> CapacityState.FULL
                count >= COMPACTION_SUGGESTED_COUNT -> CapacityState.APPROACHING
                else -> CapacityState.NORMAL
            }
        }

    public companion object {
        public const val DEFAULT_TITLE: String = "New Chat"

        /**
         * Maximum live messages before the chat is closed to new input. A hard cap, not a sliding
         * window, so the model always sees the entire live segment.
         *
         * Provisional on Android: this is a proxy for the token budget, and Nano's window is 8192
         * where Swift's was ~4096. Re-derived alongside the warning fraction at spec #92
         * (PORTING.md § A1).
         */
        public const val MESSAGE_LIMIT: Int = 40

        /**
         * Message count at which the chat starts suggesting compaction — the message-count mirror
         * of [TokenUsage.WARNING_FRACTION], used only on the fallback path. Kept below
         * [MESSAGE_LIMIT] so the nudge arrives with room to summarise, not at the wall.
         */
        public val COMPACTION_SUGGESTED_COUNT: Int = (MESSAGE_LIMIT * TokenUsage.WARNING_FRACTION).toInt()
    }
}
