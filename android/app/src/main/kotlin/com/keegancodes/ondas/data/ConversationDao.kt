package com.keegancodes.ondas.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

/**
 * The reactive counterpart of SwiftData's `@Query(sort: \Conversation.updatedAt, order: .reverse)`.
 *
 * Everything the UI observes is a [Flow], so a write anywhere re-emits — the behaviour `@Query`
 * gives SwiftUI for free and the reason a plain JSON store (which both sibling ports use) is not
 * enough here.
 */
@Dao
public interface ConversationDao {

    /** Conversations with their messages, newest activity first. */
    @Transaction
    @Query("SELECT * FROM conversations ORDER BY updatedAt DESC")
    public fun observeConversations(): Flow<List<ConversationWithMessages>>

    @Transaction
    @Query("SELECT * FROM conversations WHERE id = :id")
    public fun observeConversation(id: String): Flow<ConversationWithMessages?>

    @Transaction
    @Query("SELECT * FROM conversations WHERE id = :id")
    public suspend fun conversation(id: String): ConversationWithMessages?

    @Transaction
    @Query("SELECT * FROM conversations ORDER BY updatedAt DESC")
    public suspend fun allConversations(): List<ConversationWithMessages>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    public suspend fun upsertConversation(conversation: ConversationEntity)

    @Update
    public suspend fun updateConversation(conversation: ConversationEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    public suspend fun upsertMessage(message: ChatMessageEntity)

    @Query("DELETE FROM conversations WHERE id = :id")
    public suspend fun deleteConversation(id: String)

    @Query("DELETE FROM messages WHERE id = :id")
    public suspend fun deleteMessage(id: String)

    @Query("UPDATE conversations SET updatedAt = :updatedAt WHERE id = :id")
    public suspend fun touchConversation(id: String, updatedAt: Long)

    @Query("UPDATE conversations SET title = :title WHERE id = :id")
    public suspend fun renameConversation(id: String, title: String)

    /** Message count for a conversation, used to find an empty thread to reuse. */
    @Query("SELECT COUNT(*) FROM messages WHERE conversationId = :id")
    public suspend fun messageCount(id: String): Int
}
