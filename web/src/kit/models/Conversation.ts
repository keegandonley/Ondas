import { Compaction } from "../chat/Compaction";
import { CapacityState, TokenUsage } from "../chat/TokenUsage";
import type { ChatMessage } from "./ChatMessage";

/**
 * `messageLimit` also lives out here so `compactionSuggestedCount` can be derived from it inside
 * the same object literal — a self-reference to `Conversation.messageLimit` in the initializer
 * would hit the temporal dead zone. Swift derives one from the other on `Conversation.swift:67`
 * and the two must not be able to drift apart.
 */
const messageLimit = 40;

/**
 * Port of `Ondas/Models/Conversation.swift`.
 *
 * A single chat thread — the root aggregate that owns its messages. A plain interface plus free
 * functions where Swift has a SwiftData `@Model` class with computed properties: every stored
 * property there is defaulted and no property is `@Attribute(.unique)` purely to satisfy CloudKit,
 * and the web has no CloudKit (PORTING.md § Mandatory drifts 2). Field names and types still match
 * the Swift original one-for-one so the two model layers stay line-comparable.
 *
 * `messages` is a plain array where Swift's is `[ChatMessage]?`. That Optional exists only because
 * CloudKit requires optional to-many relationships, and Swift reads it as `(messages ?? [])`
 * everywhere (`:78`, `:94`) — so absent and empty already mean the same thing. Do not "restore"
 * the nullability.
 *
 * `latestImageMessage` (`Conversation.swift:89-91`) is NOT ported — image generation is cut from
 * web v1 (PORTING.md § Mandatory drifts 1).
 */
export interface Conversation {
  /**
   * Stable identity used for list selection and navigation. Swift's `UUID`; JS has no UUID type, so
   * this is the canonical string form from `crypto.randomUUID()`.
   */
  id: string;
  title: string;
  createdAt: Date;

  /** Bumped whenever a message is added so the conversation list can sort by recency. */
  updatedAt: Date;

  messages: ChatMessage[];
}

export const Conversation = {
  defaultTitle: "New Chat",

  /**
   * Preview copy for a thread with nothing in it yet. A named constant rather than an inline
   * string because the conversation list and the tests must not be able to drift apart — the
   * Android port adopted this after duplicated copy did exactly that.
   */
  noMessagesPreviewText: "No messages yet",

  /**
   * Maximum number of messages a single conversation may hold. Once reached, the chat is closed to
   * new input and the user is prompted to start a fresh chat. This is a hard cap (not a sliding
   * window) so the model always sees the *entire* live segment, and it keeps the rehydrated
   * transcript comfortably inside the on-device model's context window. A proxy for the token
   * budget — tune down if long messages approach the limit.
   */
  messageLimit,

  /**
   * Message count at which the chat starts suggesting compaction — the message-count mirror of
   * `TokenUsage.warningFraction`, used only on the fallback path when a token count is unavailable.
   * Kept below `messageLimit` so the nudge arrives with room to summarize, not at the wall.
   *
   * `Math.trunc` is Swift's `Int(Double(...))`, which truncates toward zero. Inherits the
   * PROVISIONAL status of `TokenUsage.warningFraction` (PORTING.md § Awaiting approval D3).
   */
  compactionSuggestedCount: Math.trunc(messageLimit * TokenUsage.warningFraction),

  /** Ports `Conversation.init(title:createdAt:)` (`Conversation.swift:69-74`) and its defaults. */
  make(options: { title?: string; createdAt?: Date } = {}): Conversation {
    const createdAt = options.createdAt ?? new Date();
    return {
      id: crypto.randomUUID(),
      title: options.title ?? Conversation.defaultTitle,
      createdAt,
      updatedAt: createdAt,
      messages: [],
    };
  },

  /**
   * Messages in chronological (display) order.
   *
   * Copies before sorting: Swift's `sorted` returns a new array, while JS `Array.prototype.sort`
   * reorders in place — sorting `messages` directly would mutate the conversation every time a row
   * rendered.
   */
  orderedMessages(conversation: Conversation): ChatMessage[] {
    return [...conversation.messages].sort(
      (lhs, rhs) => lhs.createdAt.getTime() - rhs.createdAt.getTime(),
    );
  },

  /**
   * The most recent message, used for the list-row preview. Compaction markers are skipped so the
   * list shows a real turn, not a summary divider.
   */
  latestMessage(conversation: Conversation): ChatMessage | undefined {
    return Conversation.orderedMessages(conversation).findLast(
      (message) => !message.isCompactionSummary,
    );
  },

  hasMessages(conversation: Conversation): boolean {
    return conversation.messages.length > 0;
  },

  /**
   * A one-line preview of the latest message for list rows.
   *
   * Swift additionally branches on an image-only message — `"Image request"` / `"Generated image"`
   * (`Conversation.swift:11-13`). With image generation cut there is no such message on the web, so
   * that branch is absent rather than dead.
   */
  previewText(conversation: Conversation): string {
    return Conversation.latestMessage(conversation)?.text ?? Conversation.noMessagesPreviewText;
  },

  /**
   * Capacity standing from the message-count cap — the fallback used only when a token count is
   * unavailable (a failed/undeterminable count); otherwise the engine's token usage is the primary
   * defense. Only the turns since the last compaction count (see `Compaction.capacityCount`):
   * compaction summarizes older turns into a divider and continues in place, so a compacted chat
   * must not stay stuck at capacity. Error notices are excluded too — they are kept out of the
   * rehydrated transcript, so they consume none of the context budget this cap proxies.
   */
  capacityState(conversation: Conversation): CapacityState {
    const count = Compaction.capacityCount(Conversation.orderedMessages(conversation));
    if (count >= Conversation.messageLimit) return CapacityState.full;
    if (count >= Conversation.compactionSuggestedCount) return CapacityState.approaching;
    return CapacityState.normal;
  },

  /**
   * The pure half of Swift's `Conversation.reuseEmptyOrCreate(from:in:)`
   * (`Conversation.swift:20-31`): an existing empty ("New Chat") thread to reuse, or `undefined`
   * when every thread already has messages.
   *
   * SPLIT DELIBERATELY. Swift's version also inserts a fresh conversation into a `ModelContext` and
   * saves. This layer has no persistence — that is what makes it testable without a browser — so
   * the decision lives here and the insert lands with the IndexedDB repository in spec W5. The
   * policy being centralized is the point of the original: "don't accumulate empty synced rows on
   * repeated New Chat taps", shared by every entry point that can start a chat.
   */
  reusableEmpty(conversations: readonly Conversation[]): Conversation | undefined {
    return conversations.find((conversation) => !Conversation.hasMessages(conversation));
  },
} as const;
