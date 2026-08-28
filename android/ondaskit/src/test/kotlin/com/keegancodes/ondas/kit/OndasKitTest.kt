package com.keegancodes.ondas.kit

import com.keegancodes.ondas.kit.chat.CapacityState
import com.keegancodes.ondas.kit.chat.Compaction
import com.keegancodes.ondas.kit.chat.ConversationTitle
import com.keegancodes.ondas.kit.chat.TokenUsage
import com.keegancodes.ondas.kit.models.ChatMessage
import com.keegancodes.ondas.kit.models.ChatRole
import com.keegancodes.ondas.kit.models.Conversation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.time.Instant

/**
 * Port of `OndasTests/OndasTests.swift`.
 *
 * That file holds 22 tests. **15 are ported here**; the other 7 cover features cut from Android
 * v1 and have nothing to test:
 *  - 4 `ImageCommand` parsing tests — the `/image` command is cut with image generation.
 *  - 3 `GalleryImageMerger` tests — the Gallery is cut with image generation.
 *
 * Two tests are ADDED beyond the Swift file, both marked below, covering a divergence that only
 * exists on this platform (grapheme clusters vs UTF-16 code units).
 */
class OndasKitTest {

    private fun at(offset: Long): Instant = Instant.fromEpochSeconds(offset)

    private fun msg(
        role: ChatRole,
        text: String,
        at: Long,
        isError: Boolean = false,
        isCompactionSummary: Boolean = false,
    ) = ChatMessage(
        role = role,
        text = text,
        createdAt = at(at),
        isError = isError,
        isCompactionSummary = isCompactionSummary,
    )

    // MARK: - ConversationTitle

    @Test
    fun `derives title from short message`() {
        assertEquals("Hello there", ConversationTitle.derive("Hello there"))
    }

    @Test
    fun `collapses whitespace and takes first line`() {
        assertEquals("Plan a trip", ConversationTitle.derive("  Plan a   trip\nsecond line"))
    }

    @Test
    fun `truncates long message on word boundary`() {
        val long = "Please help me write a detailed itinerary for a long summer vacation abroad"
        val title = ConversationTitle.derive(long)
        assertTrue(title.length <= 41) // 40 chars + ellipsis
        assertTrue(title.endsWith("…"))
        assertFalse(title.contains("  "))
    }

    @Test
    fun `empty message falls back to the default title`() {
        assertEquals(Conversation.DEFAULT_TITLE, ConversationTitle.derive("   "))
    }

    /**
     * ADDED (no Swift counterpart). Swift's `String.count`/`prefix` walk grapheme clusters;
     * Kotlin's `length`/`substring` walk UTF-16 code units. A naive port truncates a long
     * emoji title in the middle of a surrogate pair and emits a broken character.
     */
    @Test
    fun `truncation never splits a surrogate pair`() {
        // The leading "a" is load-bearing: each rocket is 2 UTF-16 code units, so without it a
        // naive substring(0, 40) lands neatly on a pair boundary and the bug hides. Offset by one
        // and index 40 falls INSIDE a pair, which is what splits it.
        val title = ConversationTitle.derive("a" + "🚀".repeat(50))
        assertTrue(title.endsWith("…"))
        val body = title.dropLast(1)
        assertFalse("truncated mid-surrogate", body.isNotEmpty() && body.last().isHighSurrogate())
    }

    /** ADDED (no Swift counterpart). Counting in the same unit Swift does. */
    @Test
    fun `emoji are counted as single characters not code units`() {
        // 30 astronaut emoji are 30 Swift Characters, well under the 40 limit, so no ellipsis --
        // yet they are far more than 40 UTF-16 code units.
        val title = ConversationTitle.derive("🧑‍🚀".repeat(30))
        assertFalse(title.endsWith("…"))
    }

    // MARK: - TokenUsage

    @Test
    fun `fraction is the ratio of used to limit`() {
        assertEquals(0.25, TokenUsage(used = 768, limit = 3072).fraction, 0.0)
    }

    @Test
    fun `fraction clamps to one when over limit`() {
        assertEquals(1.0, TokenUsage(used = 4000, limit = 3072).fraction, 0.0)
    }

    @Test
    fun `fraction is zero when the limit is zero`() {
        // Guards divide-by-zero when the context window cannot be determined.
        assertEquals(0.0, TokenUsage(used = 100, limit = 0).fraction, 0.0)
    }

    @Test
    fun `is at capacity when used reaches limit`() {
        assertTrue(TokenUsage(used = 3072, limit = 3072).isAtCapacity)
        assertTrue(TokenUsage(used = 3073, limit = 3072).isAtCapacity)
        assertFalse(TokenUsage(used = 3071, limit = 3072).isAtCapacity)
    }

    @Test
    fun `is approaching capacity in the warning band only`() {
        // The band opens at warningFraction (0.8 -> 2457/3072 = 0.7998, 2458 = 0.8001)...
        assertFalse(TokenUsage(used = 2457, limit = 3072).isApproachingCapacity)
        assertTrue(TokenUsage(used = 2458, limit = 3072).isApproachingCapacity)
        // ...and closes again at full: an at-capacity chat is FULL, not APPROACHING.
        assertFalse(TokenUsage(used = 3072, limit = 3072).isApproachingCapacity)
        assertFalse(TokenUsage(used = 3200, limit = 3072).isApproachingCapacity)
    }

    @Test
    fun `compaction suggested count sits below the hard cap`() {
        assertEquals(32, Conversation.COMPACTION_SUGGESTED_COUNT)
        assertTrue(Conversation.COMPACTION_SUGGESTED_COUNT < Conversation.MESSAGE_LIMIT)
    }

    // MARK: - Compaction

    @Test
    fun `uncompacted live messages is every real turn`() {
        val ordered = listOf(msg(ChatRole.USER, "a", 0), msg(ChatRole.ASSISTANT, "b", 1))
        assertEquals(null, Compaction.activeSummary(ordered))
        assertEquals(2, Compaction.capacityCount(ordered))
        assertEquals(listOf("a", "b"), Compaction.liveMessages(ordered).map { it.text })
    }

    @Test
    fun `error notices are excluded from live messages and capacity`() {
        val ordered = listOf(
            msg(ChatRole.USER, "a", 0),
            msg(ChatRole.ASSISTANT, "oops", 1, isError = true),
            msg(ChatRole.ASSISTANT, "b", 2),
        )
        assertEquals(2, Compaction.capacityCount(ordered))
        assertEquals(listOf("a", "b"), Compaction.liveMessages(ordered).map { it.text })
    }

    @Test
    fun `after compaction live messages are only turns after the marker`() {
        val ordered = (0 until 3).map {
            msg(if (it % 2 == 0) ChatRole.USER else ChatRole.ASSISTANT, "old$it", it.toLong())
        } + listOf(
            msg(ChatRole.ASSISTANT, "SUMMARY", 3, isCompactionSummary = true),
            msg(ChatRole.USER, "next-user", 4),
            msg(ChatRole.ASSISTANT, "next-reply", 5),
        )

        assertEquals("SUMMARY", Compaction.activeSummary(ordered))
        // Only post-marker turns count toward capacity -- the compacted chat is not stuck.
        assertEquals(2, Compaction.capacityCount(ordered))
        assertEquals(
            listOf("next-user", "next-reply"),
            Compaction.liveMessages(ordered).map { it.text },
        )
        // The marker's own summary is never replayed as a message.
        assertFalse(Compaction.liveMessages(ordered).map { it.text }.contains("SUMMARY"))
    }

    @Test
    fun `a fresh compaction empties the live segment`() {
        // Marker appended at the end with nothing after it: capacity resets to zero and the model
        // continues from the summary alone.
        val ordered = (0 until 4).map {
            msg(if (it % 2 == 0) ChatRole.USER else ChatRole.ASSISTANT, "m$it", it.toLong())
        } + msg(ChatRole.ASSISTANT, "SUMMARY", 4, isCompactionSummary = true)

        assertEquals("SUMMARY", Compaction.activeSummary(ordered))
        assertEquals(0, Compaction.capacityCount(ordered))
        assertTrue(Compaction.liveMessages(ordered).isEmpty())
    }

    // MARK: - Conversation capacity fallback

    private fun conversation(liveMessages: Int) = Conversation(
        createdAt = at(0),
        messages = (0 until liveMessages).map { msg(ChatRole.USER, "m$it", it.toLong()) },
    )

    @Test
    fun `capacity state crosses approaching then full`() {
        // The message-count fallback: normal below the suggested count, approaching from it up to
        // the hard cap, full at the cap.
        assertEquals(CapacityState.NORMAL, conversation(31).capacityState)
        assertEquals(
            CapacityState.APPROACHING,
            conversation(Conversation.COMPACTION_SUGGESTED_COUNT).capacityState,
        )
        assertEquals(
            CapacityState.APPROACHING,
            conversation(Conversation.MESSAGE_LIMIT - 1).capacityState,
        )
        assertEquals(CapacityState.FULL, conversation(Conversation.MESSAGE_LIMIT).capacityState)
        assertEquals(CapacityState.FULL, conversation(Conversation.MESSAGE_LIMIT + 5).capacityState)
    }
}
