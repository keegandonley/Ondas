package com.keegancodes.ondas.chat

import com.keegancodes.ondas.kit.chat.Compaction
import com.keegancodes.ondas.kit.models.ChatMessage
import com.keegancodes.ondas.kit.models.ChatRole

/**
 * Assembles the prompt, replacing Swift's `makeTranscript`.
 *
 * There is no `LanguageModelSession` on this side, so history cannot be seeded into a session
 * object and must be rebuilt into every request. Spec #88 settled the shape on device:
 *
 *  - the system prompt goes in ML Kit's dedicated `SystemInstruction` field;
 *  - history is ONE flattened, **role-labelled** block.
 *
 * A `List<Content>` was tested and rejected. `Content` carries no role, and the model loses track
 * of who said what badly enough to claim the user's name as its own — asked "what is my name?"
 * after a two-turn history it answered with the assistant's name, and asked its own it invented a
 * third. The single-fact test that most people would write ("I like teal" → "what colour?") passes
 * on BOTH shapes and would have blessed the broken one.
 */
public object ChatPrompt {

    public const val CHAT_INSTRUCTIONS: String =
        "You are Ondas, a helpful and friendly assistant that runs entirely on the user's\n" +
            "device. Answer conversationally and concisely, in text. Always respond to the user's most\n" +
            "recent message; never repeat one of your earlier replies.\n"

    /** Target length for a compaction summary, in words. */
    public const val SUMMARY_WORD_TARGET: Int = 150

    public val SUMMARY_INSTRUCTIONS: String =
        "You are compacting a long conversation to free up the model's limited context. Write a\n" +
            "concise summary — about $SUMMARY_WORD_TARGET words or fewer, and never more than a few short\n" +
            "paragraphs — capturing the key facts, decisions, the user's stated preferences, and any open\n" +
            "threads needed to continue the conversation naturally. Preserve names, numbers, and anything\n" +
            "the user asked you to remember. Do not add commentary and do not address the user: output\n" +
            "only the summary."

    /**
     * The system prompt, folding in a compaction summary when present. Framed as already-summarised
     * prior context so the model treats it as memory rather than words to echo back.
     */
    public fun instructions(summary: String?): String {
        if (summary.isNullOrEmpty()) return CHAT_INSTRUCTIONS
        return CHAT_INSTRUCTIONS + "\n" +
            "Earlier in this conversation was compacted to save space. Here is a summary of what " +
            "happened so far — treat it as background context you already know; do not repeat it " +
            "back to the user:\n\n" +
            summary
    }

    /**
     * The history block for [messages], one role-labelled line per turn.
     *
     * Goes in ML Kit's `PromptPrefix` so AICore can reuse the intermediate state across turns —
     * measured at roughly 25-30% faster on a 1.6k-character prefix. Returns null when there is no
     * history, so a fresh chat sends no prefix at all.
     *
     * Error notices are excluded: seeding them would teach the model it said
     * "Sorry, I couldn't finish that." itself. Compaction markers are already excluded upstream by
     * [Compaction.liveMessages].
     */
    public fun history(messages: List<ChatMessage>): String? {
        val lines = messages
            .filterNot { it.isError }
            .filter { it.text.isNotEmpty() }
            .map { "${speaker(it.role)}: ${it.text}" }
        return if (lines.isEmpty()) null else lines.joinToString("\n") + "\n"
    }

    /** The new user turn, labelled so it reads as part of the same transcript as [history]. */
    public fun userTurn(text: String): String = "${speaker(ChatRole.USER)}: $text"

    /**
     * The summariser's input. Cumulative: the previous summary is folded in and re-condensed each
     * round, which is what stops it growing without bound across repeated compactions.
     */
    public fun summarizerPrompt(previousSummary: String?, messages: List<ChatMessage>): String {
        val lines = buildList {
            if (!previousSummary.isNullOrEmpty()) {
                add("Summary of the conversation so far:\n$previousSummary\n")
            }
            messages.forEach { add("${speaker(it.role)}: ${it.text}") }
        }
        return "Summarize this conversation:\n\n" + lines.joinToString("\n")
    }

    private fun speaker(role: ChatRole) = if (role == ChatRole.USER) "User" else "Assistant"
}
