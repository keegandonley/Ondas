package com.keegancodes.ondas.data

import androidx.room.ColumnInfo
import androidx.room.Embedded
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey
import androidx.room.Relation
import androidx.room.TypeConverter
import java.util.UUID
import kotlin.time.Instant

/**
 * Room's storage shape for [com.keegancodes.ondas.kit.models.Conversation].
 *
 * Column names match the Swift `@Model` property names so the two schemas stay line-comparable,
 * even though Room does not need CloudKit's defaulted-and-optional shape.
 */
@Entity(tableName = "conversations")
public data class ConversationEntity(
    @PrimaryKey val id: String,
    val title: String,
    val createdAt: Long,
    val updatedAt: Long,
)

/**
 * Room's storage shape for [com.keegancodes.ondas.kit.models.ChatMessage].
 *
 * `conversationId` is the approved replacement for Swift's `ChatMessage.conversation` object
 * back-reference (PORTING.md § Spec #89 notes): SwiftData models the inverse as a relationship,
 * Room models ownership as a foreign key.
 *
 * `onDelete = CASCADE` is the counterpart of `@Relationship(deleteRule: .cascade)`. It is enforced
 * by SQLite rather than by application code, which is why [OndasDatabase] must switch foreign keys
 * on — they are OFF by default in SQLite and the constraint would silently do nothing.
 */
@Entity(
    tableName = "messages",
    foreignKeys = [
        ForeignKey(
            entity = ConversationEntity::class,
            parentColumns = ["id"],
            childColumns = ["conversationId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index("conversationId")],
)
public data class ChatMessageEntity(
    @PrimaryKey val id: String,
    val conversationId: String,
    @ColumnInfo(name = "roleRaw") val roleRaw: String,
    val text: String,
    val createdAt: Long,
    val isError: Boolean,
    val isCompactionSummary: Boolean,
)

/** A conversation with its messages, the shape the list and the chat both read. */
public data class ConversationWithMessages(
    @Embedded val conversation: ConversationEntity,
    @Relation(parentColumn = "id", entityColumn = "conversationId")
    val messages: List<ChatMessageEntity>,
)

/**
 * Timestamps are stored as **epoch nanoseconds**, not milliseconds.
 *
 * That is not gold-plating. `ChatEngine` inserts the assistant placeholder at
 * `userMessage.createdAt + 0.001s` precisely so the two messages sort deterministically; at
 * millisecond resolution that offset is a single tick and any rounding collapses the two into the
 * same instant, making turn order depend on insertion order instead of the timestamp. Nanoseconds
 * keep the invariant representable with room to spare (a Long holds until the year 2262).
 */
public object Converters {
    @TypeConverter
    public fun instantToNanos(value: Instant): Long =
        value.epochSeconds * 1_000_000_000L + value.nanosecondsOfSecond

    @TypeConverter
    public fun nanosToInstant(value: Long): Instant =
        Instant.fromEpochSeconds(
            Math.floorDiv(value, 1_000_000_000L),
            Math.floorMod(value, 1_000_000_000L).toLong(),
        )

    @TypeConverter
    public fun uuidToString(value: UUID): String = value.toString()

    @TypeConverter
    public fun stringToUuid(value: String): UUID = UUID.fromString(value)
}
