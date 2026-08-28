package com.keegancodes.ondas.kit.models

import kotlin.time.Clock
import kotlin.time.Instant
import java.util.UUID

/**
 * One message in a [Conversation].
 *
 * An immutable data class where Swift has a mutable `@Model` reference type. That is forced,
 * not preferred: Compose cannot see in-place mutation, so state has to be replaced rather than
 * edited. Callers use [copy].
 *
 * Field names and types deliberately match `Ondas/Models/ChatMessage.swift` one-for-one so the
 * two model layers stay line-comparable, even though Room does not require the defaulted-and-
 * optional shape CloudKit imposed on the Swift original.
 *
 * `imageData` / `hasImage` are NOT ported — image generation is cut from Android v1
 * (PORTING.md § Known unported Swift).
 *
 * Swift's `conversation: Conversation?` back-reference is also absent: it is the SwiftData
 * inverse relationship, and Room models ownership with a foreign key on the message row, so it
 * arrives as `conversationId` at spec #91. Approved deviation, recorded in PORTING.md.
 */
public data class ChatMessage(
    public val id: UUID = UUID.randomUUID(),
    public val role: ChatRole = ChatRole.USER,
    public val text: String = "",
    public val createdAt: Instant = Clock.System.now(),
    /**
     * True when this assistant message carries an app-generated error/availability notice rather
     * than real model output. Error turns are excluded from the replayed history so the model
     * never sees them as its own words, and from the capacity budget so a failed turn cannot
     * close a chat early.
     */
    public val isError: Boolean = false,
    /**
     * True when this message is a compaction marker rather than a chat turn: its [text] holds a
     * model-generated summary of everything before it, and the UI renders it as a divider, never
     * as a bubble.
     */
    public val isCompactionSummary: Boolean = false,
) {
    /**
     * A freshly-inserted assistant bubble with no content yet — the state the UI renders as a
     * "thinking" indicator while the model works.
     *
     * Swift additionally requires `!hasImage`; with images cut there is no such case here.
     */
    public val isEmptyPlaceholder: Boolean
        get() = role == ChatRole.ASSISTANT && text.isEmpty() && !isCompactionSummary
}
