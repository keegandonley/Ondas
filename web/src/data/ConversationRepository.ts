import type { ChatMessage } from "../kit/models/ChatMessage";
import type { Conversation } from "../kit/models/Conversation";

/**
 * Persistence, behind an interface.
 *
 * This is the counterpart of Swift's `ModelContext` and Android's `ConversationRepository`, and
 * it exists for the same two reasons: `ChatEngine` (spec W6) must be testable without a browser
 * (IndexedDB does not exist in Node), and the UI must be able to render from a fake.
 *
 * ## Why the shape looks like this
 *
 * Swift's `ChatEngine` mutates SwiftData model objects in place and calls `saveOrLog()` at each
 * step — `modelContext.insert(userMessage)`, `conversation.updatedAt = now`,
 * `modelContext.delete(assistant)`. There is no repository because SwiftData *is* one. The web
 * has no such ambient context, so each of those steps becomes an explicit call here, named after
 * what the Swift line does. Read this interface alongside `ChatEngine.swift`'s `send(_:asImage:)`
 * and the two track line for line.
 *
 * ## The rule about streamed text
 *
 * Swift assigns `assistant.text` on every streamed chunk and persists ONCE when the turn
 * completes (`ChatEngine.swift`'s trailing `defer`), because a save per token would hammer the
 * store. **Do not call [saveMessage] per chunk.** The in-memory object is the live value the UI
 * renders; persistence is a commit at the end of the turn, plus the deliberate mid-turn saves
 * Swift already makes (the user message, the placeholder).
 */
export interface ConversationRepository {
  /** Every conversation, newest `updatedAt` first — the order `@Query(sort:order:.reverse)` gives. */
  listConversations(): Promise<Conversation[]>;

  /**
   * One conversation with its messages, or `undefined` if it has been deleted.
   *
   * `undefined` is how the web expresses Swift's `conversation.isDeleted`, which `ChatEngine`
   * checks before every write on a path that has awaited something. That guard is load-bearing:
   * it covers the conversation-was-cascade-deleted race while a reply was still streaming.
   */
  getConversation(id: string): Promise<Conversation | undefined>;

  /**
   * Inserts a fresh conversation and returns it.
   *
   * Callers should first consult `Conversation.reusableEmpty` — spec W3 split
   * `Conversation.reuseEmptyOrCreate` (`Conversation.swift:20-30`) into a pure decision plus this
   * insert. The policy it encodes: repeated New Chat taps must converge on one draft rather than
   * accumulating empty rows.
   */
  createConversation(): Promise<Conversation>;

  /** Deletes a conversation and, by cascade, every message it owns. */
  deleteConversation(id: string): Promise<void>;

  /** Appends a message. Mirrors `modelContext.insert(message)` followed by a save. */
  insertMessage(conversationId: string, message: ChatMessage): Promise<void>;

  /**
   * Persists an existing message's current field values — the end-of-turn commit for streamed
   * text, and the write that records `isError`. See the note on streamed text above.
   */
  saveMessage(conversationId: string, message: ChatMessage): Promise<void>;

  /**
   * Removes a message. Its one caller is the abandoned-turn path: if a turn is cancelled before
   * any content arrived, the empty assistant placeholder is deleted rather than left to persist
   * forever as a blank bubble.
   */
  deleteMessage(conversationId: string, messageId: string): Promise<void>;

  /**
   * Writes a conversation's `title` and/or `updatedAt`.
   *
   * Kept as one call because Swift sets them together on the first turn (`conversation.title =
   * ConversationTitle.derive(from: text)` immediately followed by `conversation.updatedAt = now`),
   * and splitting it would double the writes on the hottest path.
   */
  updateConversation(
    id: string,
    changes: { title?: string; updatedAt?: Date },
  ): Promise<void>;
}
