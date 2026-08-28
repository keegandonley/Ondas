package com.keegancodes.ondas.data

import com.keegancodes.ondas.kit.models.ChatMessage
import com.keegancodes.ondas.kit.models.ChatRole
import com.keegancodes.ondas.kit.models.Conversation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import java.util.UUID
import kotlin.time.Clock
import kotlin.time.Instant

/**
 * Maps between Room's storage shapes and the platform-free domain models in `:ondaskit`, and owns
 * the persistence policies Swift keeps on `Conversation` and `ModelContext`.
 */
public class ConversationRepository(
    private val dao: ConversationDao,
    private val now: () -> Instant = { Clock.System.now() },
    /**
     * The non-fatal save policy, the counterpart of `ModelContext.saveOrLog()`: a failed write
     * logs rather than interrupting the user, because the in-memory state stays correct and the
     * next successful write persists it — but a systemic fault would fail every write, so it has
     * to be visible somewhere.
     */
    private val logError: (String, Throwable) -> Unit = { _, _ -> },
) {
    public fun observeConversations(): Flow<List<Conversation>> =
        dao.observeConversations().map { rows -> rows.map(::toDomain) }

    public fun observeConversation(id: UUID): Flow<Conversation?> =
        dao.observeConversation(id.toString()).map { it?.let(::toDomain) }

    public suspend fun conversation(id: UUID): Conversation? =
        dao.conversation(id.toString())?.let(::toDomain)

    /**
     * Returns an existing empty thread to reuse, or creates a fresh one.
     *
     * Centralises Swift's "don't accumulate empty rows on repeated New Chat taps" policy. The
     * CloudKit-sync reason for it is gone, but the user-visible one — a list filling with
     * identical "New Chat" rows — is not.
     */
    public suspend fun reuseEmptyOrCreate(): Conversation {
        val existing = dao.allConversations().firstOrNull { it.messages.isEmpty() }
        if (existing != null) return toDomain(existing)

        val timestamp = now()
        val conversation = Conversation(
            id = UUID.randomUUID(),
            title = Conversation.DEFAULT_TITLE,
            createdAt = timestamp,
            updatedAt = timestamp,
        )
        write("create conversation") { dao.upsertConversation(toEntity(conversation)) }
        return conversation
    }

    public suspend fun createConversation(): Conversation {
        val timestamp = now()
        val conversation = Conversation(createdAt = timestamp, updatedAt = timestamp)
        write("create conversation") { dao.upsertConversation(toEntity(conversation)) }
        return conversation
    }

    /** Appends a message and bumps the conversation's `updatedAt` so the list re-sorts. */
    public suspend fun appendMessage(conversationId: UUID, message: ChatMessage) {
        write("append message") {
            dao.upsertMessage(toEntity(conversationId, message))
            dao.touchConversation(conversationId.toString(), Converters.instantToNanos(message.createdAt))
        }
    }

    /** Persists an edited message — the streaming path rewrites the assistant turn's text. */
    public suspend fun updateMessage(conversationId: UUID, message: ChatMessage) {
        write("update message") { dao.upsertMessage(toEntity(conversationId, message)) }
    }

    public suspend fun deleteMessage(id: UUID) {
        write("delete message") { dao.deleteMessage(id.toString()) }
    }

    public suspend fun deleteConversation(id: UUID) {
        write("delete conversation") { dao.deleteConversation(id.toString()) }
    }

    public suspend fun rename(id: UUID, title: String) {
        write("rename conversation") { dao.renameConversation(id.toString(), title) }
    }

    public suspend fun touch(id: UUID, at: Instant = now()) {
        write("touch conversation") {
            dao.touchConversation(id.toString(), Converters.instantToNanos(at))
        }
    }

    private suspend fun write(operation: String, body: suspend () -> Unit) {
        try {
            body()
        } catch (error: Exception) {
            // Deliberately swallowed after logging -- see the `logError` doc above. Note this is
            // the ONE place that policy lives, so a caller cannot accidentally adopt a different
            // one, exactly as Swift funnels every mutation through `saveOrLog()`.
            logError("Persistence failed: $operation", error)
        }
    }

    private fun toDomain(row: ConversationWithMessages): Conversation = Conversation(
        id = UUID.fromString(row.conversation.id),
        title = row.conversation.title,
        createdAt = Converters.nanosToInstant(row.conversation.createdAt),
        updatedAt = Converters.nanosToInstant(row.conversation.updatedAt),
        messages = row.messages.map { message ->
            ChatMessage(
                id = UUID.fromString(message.id),
                role = ChatRole.fromRaw(message.roleRaw),
                text = message.text,
                createdAt = Converters.nanosToInstant(message.createdAt),
                isError = message.isError,
                isCompactionSummary = message.isCompactionSummary,
            )
        },
    )

    private fun toEntity(conversation: Conversation) = ConversationEntity(
        id = conversation.id.toString(),
        title = conversation.title,
        createdAt = Converters.instantToNanos(conversation.createdAt),
        updatedAt = Converters.instantToNanos(conversation.updatedAt),
    )

    private fun toEntity(conversationId: UUID, message: ChatMessage) = ChatMessageEntity(
        id = message.id.toString(),
        conversationId = conversationId.toString(),
        roleRaw = message.role.raw,
        text = message.text,
        createdAt = Converters.instantToNanos(message.createdAt),
        isError = message.isError,
        isCompactionSummary = message.isCompactionSummary,
    )
}
