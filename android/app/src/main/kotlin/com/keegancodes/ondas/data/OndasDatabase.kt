package com.keegancodes.ondas.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverters

/**
 * The app-wide store.
 *
 * Local-only: CloudKit has no free, account-free Android equivalent, so conversations do not sync
 * (kickoff decision, PORTING.md).
 *
 * **No in-memory fallback on failure, deliberately.** Swift's `AppModelContainer.make()` calls
 * `fatalError` rather than substituting an ephemeral store, on the reasoning that silently
 * swapping in a store that discards the user's chat history is worse than a visible crash. That
 * decision ports: [create] does not catch, so a store that cannot be opened crashes here rather
 * than pretending to work.
 */
@Database(
    entities = [ConversationEntity::class, ChatMessageEntity::class],
    version = 1,
    exportSchema = false,
)
@TypeConverters(Converters::class)
public abstract class OndasDatabase : RoomDatabase() {
    public abstract fun conversations(): ConversationDao

    public companion object {
        public const val NAME: String = "ondas.db"

        public fun create(context: Context): OndasDatabase =
            Room.databaseBuilder(context.applicationContext, OndasDatabase::class.java, NAME)
                .build()

        /**
         * In-memory instance for tests.
         *
         * The direct executors are load-bearing, not tidiness. Room's suspend DAO functions
         * dispatch onto Room's OWN query executor, which lives outside a `TestScope`'s virtual
         * time — so `advanceUntilIdle()` returns while database work is still in flight on a real
         * background thread, and a test reads state the code under test has not reached yet. That
         * produced a genuine false failure here: an assertion that a second submit is ignored while
         * responding failed because `isResponding` had not been set yet, making correct code look
         * broken. Running Room inline puts it back under the test dispatcher's control.
         */
        public fun createInMemory(context: Context): OndasDatabase =
            Room.inMemoryDatabaseBuilder(context, OndasDatabase::class.java)
                .allowMainThreadQueries()
                .setQueryExecutor { it.run() }
                .setTransactionExecutor { it.run() }
                .build()

        // NOTE: no `PRAGMA foreign_keys=ON` callback here. Raw SQLite has foreign keys OFF by
        // default, so one looks necessary and was written -- but Room enables them itself on every
        // connection it opens. Verified by deleting the callback and watching the cascade test
        // still pass, then deleting `onDelete = CASCADE` and watching it fail. The constraint is
        // enforced; the callback was a redundant line carrying a confident and wrong comment.
    }
}
