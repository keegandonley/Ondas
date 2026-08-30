import Dexie, { type Table } from "dexie";

import type { ChatMessage } from "../kit/models/ChatMessage";
import { ChatRole } from "../kit/models/ChatRole";
import type { Conversation } from "../kit/models/Conversation";

/**
 * The app-wide store — the web counterpart of `Ondas/App/AppModelContainer.swift` and of
 * `android/.../data/OndasDatabase.kt`.
 *
 * Local-only. CloudKit has no browser equivalent, so conversations do not sync (PORTING.md
 * § Mandatory drifts 2). Everything CloudKit forced on the Swift `@Model` classes — every property
 * defaulted, no `@Attribute(.unique)`, an optional to-many relationship — is gone here, exactly as
 * it went on Android. What stays is the *naming*: the columns below are the Swift property names,
 * so the three model layers stay line-comparable.
 *
 * ## Two tables, not one row with an embedded array
 *
 * The obvious IndexedDB shape is one `conversations` store whose rows carry their messages inline,
 * since that is what the domain `Conversation` looks like. It is the wrong shape: a message write
 * would then rewrite the whole conversation row, and `ChatEngine` writes several times per turn.
 * The cost scales with the transcript, so it is invisible in a two-message test and real in a
 * forty-message chat. Splitting the tables makes a message write cost one row, and makes the
 * cascade delete an explicit transaction rather than a free side effect — see
 * `DexieConversationRepository.deleteConversation`.
 *
 * ## No in-memory fallback on failure, deliberately
 *
 * Swift's `AppModelContainer.make()` calls `fatalError` rather than substituting an ephemeral
 * store, on the reasoning that silently swapping in a store that discards the user's chat history
 * is worse than a visible failure. Android's `OndasDatabase.create` ports that by not catching.
 * So does this: nothing here catches an open failure, so a store that cannot be opened rejects at
 * the call site instead of pretending to work.
 */
export class OndasDatabase extends Dexie {
  /**
   * Indexed on `updatedAt` so `listConversations` is a reverse index scan. Sorting in JS would
   * work and would also mean reading every row before knowing which ones matter.
   */
  readonly conversations!: Table<ConversationRow, string>;

  /**
   * Indexed on `conversationId` (ownership lookups and the cascade delete) and on
   * `[conversationId+createdAt]` (a conversation's messages, already in display order — the read
   * `getConversation` does on every chat open).
   */
  readonly messages!: Table<ChatMessageRow, string>;

  constructor(name: string = OndasDatabase.defaultName) {
    super(name);
    this.version(1).stores({
      // `id` is the primary key path, not an auto-incrementing one. That is PORTING.md
      // § Mandatory drifts 3: Swift's `id` is a defaulted, non-unique `UUID` only because
      // CloudKit forbids unique attributes, and with CloudKit gone the identity the app already
      // generates can be the real key.
      conversations: "id, updatedAt",
      messages: "id, conversationId, [conversationId+createdAt]",
    });
  }

  /** The IndexedDB database name. `ondas.db` on Android, for the same reason: one obvious name. */
  static readonly defaultName = "ondas";
}

/**
 * The stored shape of a `Conversation`. Its `messages` live in their own table, so the row has no
 * message field at all.
 *
 * `Date` is stored as a `Date`. IndexedDB round-trips it natively through the structured clone
 * algorithm, and it is a valid key type, so the compound index below sorts on it directly. This
 * was verified against `fake-indexeddb` rather than assumed — the fallback, had it not held, was
 * epoch milliseconds with a conversion in the mappers below.
 *
 * Note the resolution question Android had to solve differently. Room stores epoch **nanoseconds**
 * because `ChatEngine` inserts the assistant placeholder at `userMessage.createdAt + 0.001s` to
 * make the two sort deterministically, and milliseconds would collapse them. A JS `Date` is
 * millisecond-resolution, so that 1 ms offset is exactly one representable tick — the invariant
 * survives, with no headroom. Anything that shortens the offset breaks message ordering.
 */
export interface ConversationRow {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The stored shape of a `ChatMessage`, plus the one field the domain type does not have.
 *
 * `conversationId` is the approved replacement for Swift's `ChatMessage.conversation` object
 * back-reference (`ChatMessage.swift:38`), the same substitution Android made: SwiftData models
 * ownership as an inverse relationship, a row store models it as a foreign key.
 * `ChatMessage.ts` anticipates this field arriving here and nowhere else — the mappers below are
 * the only place it exists, so it never leaks into `src/kit`.
 *
 * Unlike Room, **Dexie enforces no foreign key**. SQLite rejects a message whose conversation is
 * gone; IndexedDB will happily store one, and an orphaned message row is unreachable by every
 * query the app makes, so nothing would ever delete it. The repository therefore enforces
 * ownership in application code — see `insertMessage` and `deleteConversation`.
 *
 * `role` is `string`, not `ChatRole`, and is the counterpart of Swift's `roleRaw`
 * (`ChatMessage.swift:12`) — but not a second field beside `role`, because `ChatRole.ts` already
 * collapsed the backing store and the typed accessor into one: a string-literal union *is* its raw
 * value at runtime. Widened to `string` here on purpose. A value read back from IndexedDB has not
 * been proven to be one of the two cases (an older build, a hand-edited store), and typing it as
 * `ChatRole` would assert something the boundary cannot check. `ChatRole.fromRaw` does the
 * narrowing, exactly as Swift's `ChatRole(rawValue:) ?? .user` does.
 */
export interface ChatMessageRow {
  id: string;
  conversationId: string;
  role: string;
  text: string;
  createdAt: Date;
  isError: boolean;
  isCompactionSummary: boolean;
}

/** Domain conversation to stored row. Drops `messages`; they are rows in their own table. */
export function toConversationRow(conversation: Conversation): ConversationRow {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

/**
 * Stored row plus its messages back to a domain conversation.
 *
 * `messages` is taken in already-ordered rather than sorted here: both repositories get the order
 * from the `[conversationId+createdAt]` index, and re-sorting would hide a broken index behind a
 * JS sort that quietly fixes it.
 */
export function toConversation(row: ConversationRow, messages: readonly ChatMessageRow[]): Conversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    messages: messages.map(toChatMessage),
  };
}

/** Domain message to stored row, attaching the foreign key. */
export function toChatMessageRow(conversationId: string, message: ChatMessage): ChatMessageRow {
  return {
    id: message.id,
    conversationId,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
    isError: message.isError,
    isCompactionSummary: message.isCompactionSummary,
  };
}

/** Stored row back to a domain message, dropping the foreign key. */
export function toChatMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    role: ChatRole.fromRaw(row.role),
    text: row.text,
    createdAt: row.createdAt,
    isError: row.isError,
    isCompactionSummary: row.isCompactionSummary,
  };
}

/**
 * Groups message rows by their conversation, preserving the order they arrive in.
 *
 * Shared by both repositories so the "one scan, then bucket" strategy — rather than one query per
 * conversation — has a single implementation. Callers must pass rows already ordered by
 * `[conversationId+createdAt]`; the buckets then come out in `createdAt` order for free.
 */
export function groupMessagesByConversation(
  rows: readonly ChatMessageRow[],
): Map<string, ChatMessageRow[]> {
  const grouped = new Map<string, ChatMessageRow[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.conversationId);
    if (bucket === undefined) {
      grouped.set(row.conversationId, [row]);
    } else {
      bucket.push(row);
    }
  }
  return grouped;
}
