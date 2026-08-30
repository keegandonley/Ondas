import type { ChatMessage } from "../kit/models/ChatMessage";
import { Conversation } from "../kit/models/Conversation";
import type { ConversationRepository } from "./ConversationRepository";
import {
  type ChatMessageRow,
  type ConversationRow,
  groupMessagesByConversation,
  toChatMessageRow,
  toConversation,
  toConversationRow,
} from "./OndasDatabase";

/**
 * A full `ConversationRepository` in memory. Not a stub.
 *
 * IndexedDB does not exist in Node, so this is what `ChatEngine` (spec W6) is tested against —
 * every one of its turn-cancellation, capacity and compaction-generation tests runs on this class.
 * That makes its semantics load-bearing: any place it is more forgiving than
 * `DexieConversationRepository`, W6 goes green on behaviour that would not survive a real store.
 * `ConversationRepositoryContract` is run against both implementations for exactly that reason —
 * it is the thing that stops this file from drifting.
 *
 * It is deliberately built on the same two-table row model as the Dexie store rather than on a
 * `Map<string, Conversation>` holding nested arrays. A nested-array fake cannot get the cascade
 * delete wrong, because deleting the conversation deletes the array with it — so it would test
 * nothing, and the orphan-row failure the real store can actually have would have no counterpart
 * here to assert against.
 *
 * ## Copy in, copy out
 *
 * Every read and write goes through `structuredClone`. IndexedDB does this itself — it is the
 * structured clone algorithm that stores and returns values — so a fake that handed out live
 * references would be strictly *more* permissive than the real thing. A W6 test could then mutate
 * a returned `ChatMessage`, see the change on the next read, and pass, while the same code against
 * Dexie silently dropped the write. That is the specific way a fake makes green tests meaningless.
 * Note the `Date`s matter as much as the objects: `Date` is mutable, so a shallow copy of a row
 * still leaks a live reference to its timestamps.
 */
export class InMemoryConversationRepository implements ConversationRepository {
  private readonly conversations = new Map<string, ConversationRow>();

  /** Keyed by message id, carrying `conversationId` — the same foreign key the real store has. */
  private readonly messages = new Map<string, ChatMessageRow>();

  async listConversations(): Promise<Conversation[]> {
    const grouped = groupMessagesByConversation(this.orderedMessageRows());
    return this.orderedConversationRows().map((row) =>
      toConversation(structuredClone(row), clone(grouped.get(row.id) ?? [])),
    );
  }

  async getConversation(id: string): Promise<Conversation | undefined> {
    const row = this.conversations.get(id);
    if (row === undefined) return undefined;
    // Filter before sorting: the real store range-scans one conversation's slice of the compound
    // index, so sorting every message in the store to answer one read would not be the same work.
    const messages = sortByCreatedAt(
      [...this.messages.values()].filter((message) => message.conversationId === id),
    );
    return toConversation(structuredClone(row), clone(messages));
  }

  async createConversation(): Promise<Conversation> {
    const conversation = Conversation.make();
    this.conversations.set(conversation.id, structuredClone(toConversationRow(conversation)));
    return conversation;
  }

  /**
   * Deletes a conversation and every message it owns.
   *
   * The Dexie implementation needs a transaction for this; a synchronous `Map` sweep is already
   * atomic. What has to match is the *outcome*: no message row survives its conversation.
   */
  async deleteConversation(id: string): Promise<void> {
    this.conversations.delete(id);
    for (const [messageId, row] of this.messages) {
      if (row.conversationId === id) this.messages.delete(messageId);
    }
  }

  async insertMessage(conversationId: string, message: ChatMessage): Promise<void> {
    this.writeMessage(conversationId, message);
  }

  async saveMessage(conversationId: string, message: ChatMessage): Promise<void> {
    this.writeMessage(conversationId, message);
  }

  /** Scoped to the conversation, matching the real store: a foreign id must not delete a row. */
  async deleteMessage(conversationId: string, messageId: string): Promise<void> {
    if (this.messages.get(messageId)?.conversationId !== conversationId) return;
    this.messages.delete(messageId);
  }

  async updateConversation(
    id: string,
    changes: { title?: string; updatedAt?: Date },
  ): Promise<void> {
    const row = this.conversations.get(id);
    // Missing is a no-op, as Dexie's `update` is, so a conversation deleted mid-turn cannot be
    // resurrected as a title-only ghost row.
    if (row === undefined) return;
    if (changes.title !== undefined) row.title = changes.title;
    if (changes.updatedAt !== undefined) row.updatedAt = new Date(changes.updatedAt.getTime());
  }

  /**
   * Every stored message id, ignoring which conversation owns it — the fake's counterpart of
   * reading the `messages` table directly.
   *
   * Test-facing, and the cascade test cannot be written without it: an orphaned message is by
   * definition unreachable through `getConversation` and `listConversations`, so asserting through
   * those reads would pass whether the cascade ran or not. Not part of `ConversationRepository`,
   * so nothing in the app can come to depend on it.
   */
  storedMessageIds(): string[] {
    return [...this.messages.keys()];
  }

  /**
   * Conversations newest `updatedAt` first.
   *
   * The tie-break is not decoration. Dexie reads this as a reverse scan of the `updatedAt` index,
   * and IndexedDB orders index records by key *then primary key*, so reversing yields descending
   * id within an equal timestamp (verified against `fake-indexeddb`). Two conversations can easily
   * share an `updatedAt` — they are written from the same `Date.now()` tick — and without this the
   * fake would order them by insertion instead, which is the kind of difference that shows up as
   * one flaky UI test months later.
   */
  private orderedConversationRows(): ConversationRow[] {
    return [...this.conversations.values()].sort((lhs, rhs) => {
      const byRecency = rhs.updatedAt.getTime() - lhs.updatedAt.getTime();
      if (byRecency !== 0) return byRecency;
      return lhs.id < rhs.id ? 1 : lhs.id > rhs.id ? -1 : 0;
    });
  }

  /**
   * Every message row in `[conversationId+createdAt]` order — the order the real store's compound
   * index produces, including its `id` tie-break for messages sharing an instant.
   */
  private orderedMessageRows(): ChatMessageRow[] {
    return [...this.messages.values()].sort((lhs, rhs) => {
      if (lhs.conversationId !== rhs.conversationId) {
        return lhs.conversationId < rhs.conversationId ? -1 : 1;
      }
      return compareByCreatedAt(lhs, rhs);
    });
  }

  /**
   * The upsert behind `insertMessage` and `saveMessage`, with the same ownership guard the Dexie
   * store enforces by hand: a message whose conversation is gone is dropped rather than persisted
   * as an orphan. See `DexieConversationRepository.writeMessage` for why the write is swallowed.
   */
  private writeMessage(conversationId: string, message: ChatMessage): void {
    if (!this.conversations.has(conversationId)) return;
    this.messages.set(message.id, structuredClone(toChatMessageRow(conversationId, message)));
  }
}

/**
 * Deep-copies a batch of rows.
 *
 * Written as an arrow rather than passing `structuredClone` to `map` directly: `map` supplies the
 * index as a second argument, which `structuredClone` reads as its options object.
 */
function clone(rows: readonly ChatMessageRow[]): ChatMessageRow[] {
  return rows.map((row) => structuredClone(row));
}

/** `createdAt` ascending, tie-broken by `id` — what the `[conversationId+createdAt]` index gives. */
function sortByCreatedAt(rows: ChatMessageRow[]): ChatMessageRow[] {
  return rows.sort(compareByCreatedAt);
}

function compareByCreatedAt(lhs: ChatMessageRow, rhs: ChatMessageRow): number {
  const byTime = lhs.createdAt.getTime() - rhs.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return lhs.id < rhs.id ? -1 : lhs.id > rhs.id ? 1 : 0;
}
