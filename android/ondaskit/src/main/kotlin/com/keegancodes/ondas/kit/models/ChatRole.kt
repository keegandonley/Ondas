package com.keegancodes.ondas.kit.models

/**
 * Who authored a message in a conversation.
 *
 * [raw] is the persisted form and matches Swift's `ChatRole: String` raw values exactly, so a
 * row written by either implementation reads the same. [fromRaw] mirrors Swift's
 * `ChatRole(rawValue:) ?? .user` — an unrecognised value degrades to `user` rather than
 * throwing, because a message with a role we cannot parse is still a message worth showing.
 */
public enum class ChatRole(public val raw: String) {
    USER("user"),
    ASSISTANT("assistant"),
    ;

    public companion object {
        public fun fromRaw(raw: String): ChatRole = entries.firstOrNull { it.raw == raw } ?: USER
    }
}
