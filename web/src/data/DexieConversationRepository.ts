import Dexie from "dexie";

import type { ChatMessage } from "../kit/models/ChatMessage";
import { Conversation } from "../kit/models/Conversation";
import type { ConversationRepository } from "./ConversationRepository";
import {
  OndasDatabase,
  groupMessagesByConversation,
  toChatMessageRow,
  toConversation,
  toConversationRow,
} from "./OndasDatabase";

/**
 * The real store: `ConversationRepository` over IndexedDB, via Dexie.
 *
 * Every method here is named after the Swift line it replaces — read it beside
 * `ChatEngine.swift`'s `send(_:asImage:)`, where SwiftData's ambient `ModelContext` does each of
 * these implicitly.
 *
 * ## The invariant this class has to enforce that Swift and Room get for free
 *
 * SwiftData has `@Relationship(deleteRule: .cascade)`; Room has `ForeignKey(onDelete = CASCADE)`,
 * enforced by SQLite. **IndexedDB has neither.** Ownership between the two tables is therefore a
 * rule this file keeps by hand, in three places:
 *
 *  - [deleteConversation] deletes the messages too, in one transaction.
 *  - [insertMessage] and [saveMessage] refuse to write a message whose conversation is gone.
 *
 * Both directions matter, and both leave the same wreckage if skipped: a message row keyed to a
 * conversation that no longer exists. Nothing in the app ever queries messages except through a
 * conversation, so such a row is invisible, permanent, and counts against the user's storage
 * forever. Android gets the second guard from SQLite rejecting the insert; here it is explicit.
 */
export class DexieConversationRepository implements ConversationRepository {
  constructor(private readonly db: OndasDatabase = new OndasDatabase()) {}

  /**
   * Every conversation, newest `updatedAt` first — Swift's
   * `@Query(sort: \Conversation.updatedAt, order: .reverse)`.
   *
   * ## Why this loads messages
   *
   * The tempting optimisation is to return rows with `messages: []`, since a sidebar only shows a
   * title and a preview line. It is a trap, and the reason is in `src/kit`, not here:
   * `Conversation.previewText` reads the latest non-marker message, `Conversation.hasMessages`
   * reads the array, and `Conversation.reusableEmpty` — which the New Chat path consults before
   * calling [createConversation] — is defined as "the first conversation with no messages". Hand
   * that function a list whose `messages` are all empty and it returns the first conversation
   * every time: New Chat would silently hijack the user's most recent thread instead of starting
   * one. An empty array is not "unloaded"; it is a load-bearing lie about the domain type.
   *
   * So the cost is paid, but paid once. Two index scans total — one over `conversations` in
   * reverse `updatedAt` order, one over `messages` in `[conversationId+createdAt]` order — and the
   * rows are bucketed in a single pass. No per-conversation query, no JS sort. The volume is
   * bounded in practice by `Conversation.messageLimit` (40) per thread, which is the same hard cap
   * that keeps a transcript inside the model's context window.
   *
   * If a sidebar-only projection is ever wanted, it belongs in a *new* method returning a distinct
   * preview type, never as a quietly hollowed-out `Conversation`.
   */
  async listConversations(): Promise<Conversation[]> {
    // Independent scans; run them concurrently rather than serialising two round trips.
    const [rows, messageRows] = await Promise.all([
      this.db.conversations.orderBy("updatedAt").reverse().toArray(),
      this.db.messages.orderBy("[conversationId+createdAt]").toArray(),
    ]);
    const grouped = groupMessagesByConversation(messageRows);
    return rows.map((row) => toConversation(row, grouped.get(row.id) ?? []));
  }

  /**
   * One conversation with its messages in `createdAt` order, or `undefined` if it has been
   * deleted — the web's expression of Swift's `conversation.isDeleted`.
   */
  async getConversation(id: string): Promise<Conversation | undefined> {
    // The range scan is over the compound index, so the rows arrive already ordered by
    // `createdAt`. Sorting them here instead would work and would also mean a broken index could
    // never be noticed.
    const [row, messageRows] = await Promise.all([
      this.db.conversations.get(id),
      this.db.messages
        .where("[conversationId+createdAt]")
        .between([id, Dexie.minKey], [id, Dexie.maxKey])
        .toArray(),
    ]);
    if (row === undefined) return undefined;
    return toConversation(row, messageRows);
  }

  /**
   * Inserts a fresh conversation and returns it — the persistence half of Swift's
   * `Conversation.reuseEmptyOrCreate` (`Conversation.swift:20-31`), whose decision half is
   * `Conversation.reusableEmpty`. Callers consult that first.
   */
  async createConversation(): Promise<Conversation> {
    const conversation = Conversation.make();
    await this.db.conversations.add(toConversationRow(conversation));
    return conversation;
  }

  /**
   * Deletes a conversation and every message it owns, in ONE transaction.
   *
   * The transaction is the point. Swift gets atomicity from `deleteRule: .cascade`; two separate
   * Dexie deletes would leave a window — and, if the second one fails, a permanent orphan set —
   * where the conversation is gone and its messages are not.
   */
  async deleteConversation(id: string): Promise<void> {
    await this.db.transaction("rw", this.db.conversations, this.db.messages, async () => {
      await Promise.all([
        this.db.conversations.delete(id),
        this.db.messages.where("conversationId").equals(id).delete(),
      ]);
    });
  }

  /** Appends a message. Mirrors `modelContext.insert(message)` followed by a save. */
  async insertMessage(conversationId: string, message: ChatMessage): Promise<void> {
    await this.writeMessage(conversationId, message);
  }

  /**
   * Persists an existing message's current field values — the end-of-turn commit for streamed
   * text, and the write that records `isError`.
   *
   * Identical to [insertMessage] on purpose: both are an upsert, as Android's `upsertMessage` is.
   * The two names exist because the Swift lines they port are different lines, and a caller
   * reading `saveMessage` beside `ChatEngine.swift`'s trailing `defer` should not have to know
   * they collapse.
   */
  async saveMessage(conversationId: string, message: ChatMessage): Promise<void> {
    await this.writeMessage(conversationId, message);
  }

  /**
   * Removes a message — the abandoned-turn path, where a turn cancelled before any content
   * arrived deletes its empty assistant placeholder rather than leaving a blank bubble forever.
   *
   * Scoped to the conversation, not just the message id. `messageId` reaching here from a turn on
   * a different thread would otherwise delete a live message out of a conversation the user is
   * still reading, and the primary-key delete would look entirely correct while doing it.
   */
  async deleteMessage(conversationId: string, messageId: string): Promise<void> {
    await this.db.transaction("rw", this.db.messages, async () => {
      const row = await this.db.messages.get(messageId);
      if (row?.conversationId !== conversationId) return;
      await this.db.messages.delete(messageId);
    });
  }

  /**
   * Writes a conversation's `title` and/or `updatedAt` in one call, because Swift sets them
   * together on the first turn.
   *
   * No existence guard: Dexie's `update` on a missing key is a no-op (verified, not assumed), so a
   * conversation deleted mid-turn cannot be resurrected as a title-only ghost row.
   */
  async updateConversation(
    id: string,
    changes: { title?: string; updatedAt?: Date },
  ): Promise<void> {
    // Built key by key rather than spread: under `exactOptionalPropertyTypes` an absent key and a
    // key set to `undefined` are different things, and Dexie would write the `undefined`.
    const patch: { title?: string; updatedAt?: Date } = {};
    if (changes.title !== undefined) patch.title = changes.title;
    if (changes.updatedAt !== undefined) patch.updatedAt = changes.updatedAt;
    if (Object.keys(patch).length === 0) return;
    await this.db.conversations.update(id, patch);
  }

  /** Closes the underlying connection. Tests use it; the app holds one database for its lifetime. */
  close(): void {
    this.db.close();
  }

  /**
   * The upsert behind [insertMessage] and [saveMessage], with the ownership guard IndexedDB will
   * not enforce.
   *
   * The dropped write is deliberate and is the lesser of two evils. It covers the race
   * `ChatEngine` guards against with `conversation.isDeleted`: the user deletes a thread while its
   * reply is still streaming, and the turn's end-of-turn commit lands afterwards. Persisting it
   * would create exactly the orphan row this class exists to prevent, for a conversation no UI can
   * ever open again. Swallowing it matches Swift's `saveOrLog()` policy and Android's `write()`
   * wrapper: the user's live state is already correct, and there is nothing left to persist to.
   */
  private async writeMessage(conversationId: string, message: ChatMessage): Promise<void> {
    await this.db.transaction("rw", this.db.conversations, this.db.messages, async () => {
      const owner = await this.db.conversations.get(conversationId);
      if (owner === undefined) return;
      await this.db.messages.put(toChatMessageRow(conversationId, message));
    });
  }
}
