import { ChatRole } from "./ChatRole";

/**
 * Port of `Ondas/Models/ChatMessage.swift`.
 *
 * One message in a `Conversation`. A plain interface where Swift has a SwiftData `@Model` class:
 * the defaulted-everything, no-unique-constraint, optional-relationship shape of the original
 * exists only to satisfy CloudKit, and there is no CloudKit here (PORTING.md § Mandatory drifts 2).
 * Field names and types still match the Swift original one-for-one so the two model layers stay
 * line-comparable. Persistence is spec W5's problem; nothing in this layer knows about IndexedDB.
 *
 * Properties are mutable, as Swift's `var`s are. `ChatEngine` streams into `text` turn by turn and
 * flips `isError` after the fact, so a frozen shape here would push a copy-on-write discipline onto
 * spec W6 that Swift does not have. (Android had to freeze its model, but only because Compose
 * cannot observe in-place mutation — that constraint does not apply to a plain React render.)
 *
 * NOT ported, and deliberately so:
 *  - `imageData` (`ChatMessage.swift:19`) and `hasImage` (`:58-60`) — image generation is cut from
 *    web v1; no browser API exists (PORTING.md § Mandatory drifts 1, § Known unported Swift).
 *  - `conversation: Conversation?` (`ChatMessage.swift:38`) — that is the SwiftData inverse
 *    relationship. A conversation owns a plain array of messages here, so the back-reference has
 *    nothing to point through; if the IndexedDB store needs a foreign key it arrives at spec W5.
 *  - `roleRaw` (`:12`) — see `ChatRole`; the union's runtime form is the raw string, so the
 *    backing store and the typed accessor collapse into this one field.
 */
export interface ChatMessage {
  /** Swift's `UUID`. JS has no UUID type; `crypto.randomUUID()` produces the same canonical form. */
  id: string;
  role: ChatRole;
  text: string;
  createdAt: Date;

  /**
   * True when this assistant message carries an app-generated error/availability notice rather than
   * real model output. Error turns are excluded from the rehydrated session transcript so the model
   * never sees them as its own words, and from the capacity budget so a failed turn cannot close a
   * chat early.
   */
  isError: boolean;

  /**
   * True when this message is a compaction marker rather than a chat turn: its `text` holds a
   * model-generated summary of everything before it, and the UI renders it as a "Conversation
   * compacted" divider, never as a bubble. On the model side the summary is folded into the
   * rehydrated session's instructions while the turns above the marker stop feeding the model
   * (see `Compaction`).
   */
  isCompactionSummary: boolean;
}

export const ChatMessage = {
  /**
   * Ports `ChatMessage.init(role:text:imageData:createdAt:)` (`ChatMessage.swift:40-51`), including
   * its defaults. `isError` and `isCompactionSummary` are not init parameters in Swift either —
   * callers set them after construction — but they are required fields on an object literal, so
   * they are accepted here as defaulted options rather than forcing every call site to spell out
   * `false` twice.
   */
  make(options: {
    role: ChatRole;
    text?: string;
    createdAt?: Date;
    isError?: boolean;
    isCompactionSummary?: boolean;
  }): ChatMessage {
    return {
      id: crypto.randomUUID(),
      role: options.role,
      text: options.text ?? "",
      createdAt: options.createdAt ?? new Date(),
      isError: options.isError ?? false,
      isCompactionSummary: options.isCompactionSummary ?? false,
    };
  },

  /**
   * True for a freshly-inserted assistant bubble that has no content yet — the state the UI renders
   * as a "thinking" indicator while the model works.
   *
   * Swift additionally requires `!hasImage` (`ChatMessage.swift:65`). With images cut there is no
   * such message on the web, so that term is absent rather than dead.
   */
  isEmptyPlaceholder(message: ChatMessage): boolean {
    return (
      message.role === ChatRole.assistant && message.text === "" && !message.isCompactionSummary
    );
  },
} as const;
