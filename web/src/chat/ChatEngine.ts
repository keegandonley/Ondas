import { Compaction } from "../kit/chat/Compaction";
import { ConversationTitle } from "../kit/chat/ConversationTitle";
import { isBlank } from "../kit/chat/StringExtensions";
import { CapacityState, TokenUsage } from "../kit/chat/TokenUsage";
import type { TurnSignal } from "../kit/chat/TokenUsage";
import { ChatMessage } from "../kit/models/ChatMessage";
import { ChatRole } from "../kit/models/ChatRole";
import { Conversation } from "../kit/models/Conversation";
import type { TelemetryService } from "../kit/telemetry/TelemetryService";
import type { ConversationRepository } from "../data/ConversationRepository";
import {
  ModelError,
  availabilityMessage,
  curatedMessage,
  isCancellation,
} from "./OnDeviceModel";
import type { ModelSession, ModelTurn, OnDeviceModel } from "./OnDeviceModel";

/**
 * Port of `Ondas/Services/ChatEngine.swift`.
 *
 * Drives one conversation: sends user messages to the on-device model and persists both sides of
 * the exchange. Swift is `@MainActor @Observable` over SwiftData; here the equivalent is a plain
 * class with an explicit subscription, consumed by `useSyncExternalStore` in the UI. Keeping React
 * out of this file is what lets the whole engine be tested in Node against a fake model and a fake
 * repository — the same reason `OnDeviceModel` and `ConversationRepository` are interfaces.
 *
 * ## What is deliberately NOT here
 *
 * The `/image` path. Swift's `send(_:asImage:)` branches to `generateImage` for `/image` turns and
 * the language model never runs; image generation is cut from web v1 (PORTING.md drift 1), so the
 * branch, the `asImage` parameter and the `ondas.tool` span are all absent rather than stubbed.
 *
 * Generation options. Swift reads a `ResponseStyle` per turn and passes a temperature. Chrome has
 * no sampling control that functions (PORTING.md drift 6), so there is no options parameter to
 * thread through and no per-turn settings read.
 *
 * ## Two Swift mechanisms that change shape here, and one that does not
 *
 * 1. `Task` + `Task.isCancelled` becomes `AbortController` + `signal.aborted`. Every place Swift
 *    checks `Task.isCancelled` before touching the store, this checks the signal, for exactly the
 *    same reason: a reply must stop writing into a conversation the user has already left.
 *
 * 2. `defer` becomes `finally`. On Android this needed `NonCancellable` because a suspending
 *    Kotlin `finally` is itself cancellable; JavaScript has no such hazard — aborting a signal does
 *    not interrupt an executing function — so a plain `finally` is the faithful equivalent.
 *
 * 3. The compaction generation counter is ported unchanged. It is not incidental: it stops a
 *    superseded compaction, unwinding late after the user has already moved on, from clearing the
 *    progress flag out from under a newer one that is genuinely in flight.
 */

/** The reserve held back from the context window for the model's reply. See the note below. */
export interface CapacityConstants {
  /**
   * Tokens held back from the context window so a nearly-full chat can still answer.
   *
   * Swift uses 1024 against a ~4096-token window. This is NOT that number rescaled: PORTING.md
   * § Awaiting approval D3 records the decision to *re-derive* it from the compaction summariser's
   * measured headroom rather than inherit or scale it, because the reserve and the warning band
   * are both really standing in for one question — "can the summariser still condense the live
   * segment in a single pass?" — and that question has a different answer per model.
   */
  responseTokenReserve: number;
}

export interface ChatEngineDependencies {
  model: OnDeviceModel;
  repository: ConversationRepository;
  telemetry: TelemetryService;
  capacity: CapacityConstants;
  /** Injectable for deterministic tests. Defaults to `Date.now`-backed. */
  now?: () => Date;
}

/** Everything the UI renders. A snapshot, so `useSyncExternalStore` can compare by reference. */
export interface ChatEngineState {
  isResponding: boolean;
  isCompacting: boolean;
  /** Non-null when the model can't run, carrying a user-facing reason. */
  availabilityMessage: string | null;
  /** Null when a token count is unavailable — capacity then falls back to the message-count cap. */
  tokenUsage: TokenUsage | null;
  lastTurn: TurnSignal | null;
  conversation: Conversation | null;
  /** True only where the browser has no `LanguageModel` at all. Drives the unsupported state. */
  isSupported: boolean;
}

const CHAT_INSTRUCTIONS = `You are Ondas, a helpful and friendly assistant that runs entirely on the user's
device. Answer conversationally and concisely, in text. Always respond to the user's most
recent message; never repeat one of your earlier replies.
`;

/**
 * Target length for a compaction summary, in words. Kept well under the budget the summary is
 * allowed to occupy in the rebuilt context, and bounds growth across repeated compactions — each
 * round re-condenses the previous summary to this same length.
 */
const SUMMARY_WORD_TARGET = 150;

const SUMMARY_INSTRUCTIONS = `You are compacting a long conversation to free up the model's limited context. Write a
concise summary — about ${SUMMARY_WORD_TARGET} words or fewer, and never more than a few short
paragraphs — capturing the key facts, decisions, the user's stated preferences, and any open
threads needed to continue the conversation naturally. Preserve names, numbers, and anything
the user asked you to remember. Do not add commentary and do not address the user: output
only the summary.`;

/** Ports `ChatEngine.friendlyMessage(for:)`'s generic arm (`ChatEngine.swift:701-706`). */
const GENERIC_FAILURE_MESSAGE = "Sorry, I couldn't finish that. Please try again.";

/** Swift's `CompactionError.emptySummary` reuses the shared friendly-message path. */
const COMPACTION_FAILURE_MESSAGE =
  "I couldn't summarize this conversation. Try again, or start a new chat.";

export class ChatEngine {
  #state: ChatEngineState = {
    isResponding: false,
    isCompacting: false,
    availabilityMessage: null,
    tokenUsage: null,
    lastTurn: null,
    conversation: null,
    isSupported: true,
  };

  #listeners = new Set<() => void>();

  #session: ModelSession | null = null;
  #activeTurn: AbortController | null = null;

  /**
   * The in-flight turn's promise, so callers can await it settling.
   *
   * Swift holds a `Task` handle for cancellation and never awaits it; the web needs the promise
   * for the same cancellation *and* because there is no other way to observe "this turn is
   * finished, including its trailing persistence". Rejections are swallowed here — `#send` and
   * `#performCompaction` already convert every failure into a user-visible message, so a
   * rejection reaching this handle would be a bug, not a condition to surface.
   */
  #activeTurnPromise: Promise<void> = Promise.resolve();

  /**
   * Bumped when a compaction starts, so a superseded compaction unwinding late cannot clear
   * `isCompacting` out from under a newer, genuinely in-flight one. Only the current generation's
   * task resets the flag.
   */
  #compactionGeneration = 0;
  #turnCounter = 0;

  readonly #model: OnDeviceModel;
  readonly #repository: ConversationRepository;
  readonly #telemetry: TelemetryService;
  readonly #capacity: CapacityConstants;
  readonly #now: () => Date;

  constructor(dependencies: ChatEngineDependencies) {
    this.#model = dependencies.model;
    this.#repository = dependencies.repository;
    this.#telemetry = dependencies.telemetry;
    this.#capacity = dependencies.capacity;
    this.#now = dependencies.now ?? (() => new Date());
  }

  // MARK: - Observation

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): ChatEngineState => this.#state;

  #patch(changes: Partial<ChatEngineState>): void {
    this.#state = { ...this.#state, ...changes };
    for (const listener of this.#listeners) listener();
  }

  /**
   * Republishes the current state without changing it.
   *
   * Streamed text mutates `ChatMessage.text` in place, exactly as Swift does — the message object
   * is the live value. React compares snapshots by reference, so an in-place mutation is invisible
   * to it unless the snapshot identity changes. This is the one place the web needs a nudge Swift
   * gets from `@Observable`.
   */
  #notifyMutation(): void {
    this.#state = { ...this.#state };
    for (const listener of this.#listeners) listener();
  }

  // MARK: - Derived state

  /**
   * The conversation's standing against the context budget. Prefers the real token budget; falls
   * back to the message-count cap only when a token count is unavailable. `approaching` still
   * accepts input (and offers compaction); `full` does not.
   */
  get capacityState(): CapacityState {
    const { tokenUsage, conversation } = this.#state;
    if (tokenUsage) {
      if (TokenUsage.isAtCapacity(tokenUsage)) return CapacityState.full;
      if (TokenUsage.isApproachingCapacity(tokenUsage)) return CapacityState.approaching;
      return CapacityState.normal;
    }
    return conversation ? Conversation.capacityState(conversation) : CapacityState.normal;
  }

  /** Whether a message with `draft` can be sent right now. */
  canSend(draft: string): boolean {
    return (
      !isBlank(draft) &&
      !this.#state.isResponding &&
      !this.#state.isCompacting &&
      this.#state.availabilityMessage === null &&
      this.capacityState !== CapacityState.full
    );
  }

  /**
   * Whether the composer's input controls should be disabled: a full chat takes no more input, and
   * input is frozen while a compaction rebuilds the session (a send would race it).
   */
  get isComposerDisabled(): boolean {
    return this.capacityState === CapacityState.full || this.#state.isCompacting;
  }

  // MARK: - Session construction

  /**
   * Builds the session's instructions, folding in a compaction summary when present. It is framed
   * as already-summarized prior context so the model treats it as memory rather than as words to
   * echo back on the next turn.
   */
  static instructionsContent(summary: string | undefined): string {
    if (!summary) return CHAT_INSTRUCTIONS;
    return `${CHAT_INSTRUCTIONS}
Earlier in this conversation was compacted to save space. Here is a summary of what happened so far — treat it as background context you already know; do not repeat it back to the user:

${summary}`;
  }

  /**
   * The turns replayed into a rebuilt session.
   *
   * This is the web counterpart of `ChatEngine.makeTranscript(summary:messages:)`, and it ports
   * faithfully because Chrome accepts role-tagged `initialPrompts` — verified in the spike. That
   * matters: it is the single largest structural deviation on the Android port, where ML Kit's
   * `Content` carries no role and history had to be flattened into one labelled string.
   *
   * App-generated error notices are excluded: seeding them would teach the rehydrated session it
   * said "Sorry, I couldn't finish that." itself. Compaction markers are excluded upstream by
   * `Compaction.liveMessages`.
   */
  static seededTurns(messages: readonly ChatMessage[]): ModelTurn[] {
    const turns: ModelTurn[] = [];
    for (const message of messages) {
      if (message.isError) continue;
      if (message.text === "") continue;
      turns.push({ role: message.role, content: message.text });
    }
    return turns;
  }

  async #makeSession(history: readonly ChatMessage[]): Promise<ModelSession> {
    const live = Compaction.liveMessages(history);
    const summary = Compaction.activeSummary(history);
    return this.#model.createSession({
      systemPrompt: ChatEngine.instructionsContent(summary),
      history: ChatEngine.seededTurns(live),
    });
  }

  // MARK: - Lifecycle

  /**
   * Points the engine at `conversation`, rebuilding the model session only when the target thread
   * actually changes. Safe to call repeatedly.
   */
  async configure(conversation: Conversation): Promise<void> {
    const changed = this.#state.conversation?.id !== conversation.id || this.#session === null;
    if (changed) {
      // Abandon any turn still streaming into the previous conversation before switching.
      this.cancelActiveTurn();
      // Clear the compaction flag so a cancelled compaction on the previous thread can't leave the
      // newly-opened one transiently showing "Compacting…".
      //
      // `lastTurn` is cleared for the same class of reason. It marks the most recently finished
      // turn, and a turn belongs to a conversation — carrying it across a switch lets anything
      // keyed on it (the completion signal, the screen-reader announcement) fire for a thread the
      // turn did not happen in. Not reachable today, because every remount path lands on an empty
      // conversation, but that is an unstated invariant living in another file, and this project
      // has already been bitten once by exactly that shape of assumption.
      this.#patch({ isCompacting: false, conversation, lastTurn: null });
      this.#destroySession();
    } else {
      this.#patch({ conversation });
    }

    await this.refreshAvailability();

    // Attempted unconditionally, matching Swift's `makeSession(for:)`, which is a synchronous
    // constructor that cannot fail and is therefore never gated on availability. Gating it here
    // was a real bug: if the model was still downloading when a conversation opened, the session
    // stayed null, and once availability cleared the banner and `canSend` both said "ready" while
    // every send failed with the generic message until the user switched threads and back.
    if (changed) await this.#ensureSession();
    this.refreshTokenUsage();
  }

  /**
   * Returns the live session, building it if there isn't one.
   *
   * A null session is a state Swift cannot reach — `LanguageModelSession(...)` is a synchronous
   * constructor that always succeeds — but the web's `createSession` is async and can fail, most
   * obviously while the model is still downloading. So the recovery is a web-only addition rather
   * than a port: without it, a session that failed to build once stays broken for the lifetime of
   * the open conversation, with nothing in the UI saying so.
   */
  async #ensureSession(): Promise<ModelSession | null> {
    if (this.#session) return this.#session;
    const conversation = this.#state.conversation;
    if (!conversation) return null;
    try {
      this.#session = await this.#makeSession(conversation.messages);
    } catch (error) {
      // The availability banner explains why; the chat still renders and the turn reports failure.
      ChatEngine.#logFailure("Session creation", error);
      this.#session = null;
    }
    return this.#session;
  }

  #destroySession(): void {
    this.#session?.destroy();
    this.#session = null;
  }

  /** Releases the model session. Call when the view is torn down. */
  dispose(): void {
    this.cancelActiveTurn();
    this.#destroySession();
    this.#listeners.clear();
  }

  /**
   * Recomputes `availabilityMessage`. Called on configure, on each send, and when the tab becomes
   * visible again — so the banner clears as soon as e.g. a model download finishes. Swift drives
   * the last of those from `scenePhase`; the web equivalent is `visibilitychange`.
   */
  async refreshAvailability(): Promise<void> {
    if (!this.#model.isSupported()) {
      this.#patch({ isSupported: false, availabilityMessage: availabilityMessage("unavailable") });
      return;
    }
    const state = await this.#model.availability();
    this.#patch({
      isSupported: true,
      availabilityMessage: state === "available" ? null : availabilityMessage(state),
    });
  }

  /**
   * Recomputes `tokenUsage` from the session against the model's context window.
   *
   * **Synchronous, and deliberately without Swift's session-identity guard.** Swift must
   * `await model.tokenCount(for: session.transcript)` and therefore re-checks `self.session ===
   * session` before committing, because a thread switch may have swapped the session mid-count and
   * a stale count would lock out the now-current chat. On the web `usage` and `window` are live
   * synchronous properties of the session, so there is no await for a swap to happen across and
   * nothing for the guard to protect. The guard is absent because the race cannot occur — not
   * because it was dropped.
   */
  refreshTokenUsage(): void {
    const session = this.#session;
    if (!session) {
      this.#patch({ tokenUsage: null });
      return;
    }
    // Hold back a reserve for the reply. If the window is somehow no larger than the reserve,
    // treat the budget as undeterminable and fall back to the message-count cap rather than
    // wedging an empty chat at capacity.
    const limit = session.window - this.#capacity.responseTokenReserve;
    this.#patch({ tokenUsage: limit > 0 ? { used: session.usage, limit } : null });
  }

  // MARK: - Turns

  /**
   * Starts a turn as a tracked task so it can be cancelled if the user leaves the conversation.
   *
   * The composer disables itself while `isResponding`, but that flag only flips once the body
   * runs — a second submit racing into that window would otherwise replace `activeTurn` and leave
   * the real in-flight turn uncancellable. Guard the flag and cancel any not-yet-run predecessor
   * so the handle always points at the one live turn.
   */
  submit(raw: string): void {
    if (this.#state.isResponding || this.#state.isCompacting) return;
    this.cancelActiveTurn();
    const controller = new AbortController();
    this.#activeTurn = controller;
    this.#activeTurnPromise = this.#runTurn(controller.signal, (signal) =>
      this.#send(raw, signal),
    );
  }

  /**
   * Starts a turn body one microtask late, then abandons it if it was superseded in the meantime.
   *
   * This exists to reproduce a property of Swift's `Task {}` that JavaScript does not share. Swift
   * schedules the body — two `submit` calls in the same synchronous run both pass the
   * `isResponding` guard (the flag is only set inside the body), the second cancels the first, and
   * the first's `guard !Task.isCancelled` then returns before it has touched anything. A JS async
   * function instead runs *synchronously up to its first await*, so without this boundary the
   * superseded turn has already appended its user message and its placeholder to the conversation
   * before the abort lands — two user messages for one send, and a store write from a turn that
   * was cancelled.
   *
   * Found by mutation-testing the `submit` guard: the guard alone does not cover the same-tick
   * race it was written for, on this platform.
   */
  async #runTurn(signal: AbortSignal, body: (signal: AbortSignal) => Promise<void>): Promise<void> {
    await Promise.resolve();
    if (signal.aborted) return;
    await body(signal);
  }

  /**
   * Resolves once the in-flight turn (or compaction) has fully settled, including its trailing
   * persistence. A no-op when nothing is running.
   */
  async idle(): Promise<void> {
    await this.#activeTurnPromise;
  }

  /**
   * Cancels the in-flight turn. The streaming loop stops writing, and `send` skips its trailing
   * persistence so a torn-down conversation isn't touched. Also covers an in-flight compaction,
   * which shares the handle.
   */
  cancelActiveTurn(): void {
    this.#activeTurn?.abort();
    this.#activeTurn = null;
  }

  async #send(raw: string, signal: AbortSignal): Promise<void> {
    const conversation = this.#state.conversation;
    if (!conversation) return;
    const text = raw.trim();
    // A full chat is closed to new turns — the UI reflects this, but guard defensively so a late
    // send can't push past the cap. A turn cancelled before it ever ran must not touch the store.
    if (text === "" || this.#state.isResponding) return;
    if (this.capacityState === CapacityState.full || signal.aborted) return;

    const wasEmpty = !Conversation.hasMessages(conversation);
    const now = this.#now();

    const userMessage = ChatMessage.make({ role: ChatRole.user, text, createdAt: now });
    conversation.messages.push(userMessage);
    await this.#repository.insertMessage(conversation.id, userMessage);
    if (wasEmpty) conversation.title = ConversationTitle.derive(text);
    conversation.updatedAt = now;
    await this.#repository.updateConversation(conversation.id, {
      ...(wasEmpty ? { title: conversation.title } : {}),
      updatedAt: now,
    });

    // A placeholder assistant bubble the UI shows a thinking indicator in. Nudged 1ms later so it
    // always sorts after the user message.
    const assistant = ChatMessage.make({
      role: ChatRole.assistant,
      createdAt: new Date(now.getTime() + 1),
    });
    conversation.messages.push(assistant);
    await this.#repository.insertMessage(conversation.id, assistant);

    this.#patch({ isResponding: true });

    // Snapshot the count as of the end of the previous turn, so telemetry can report this turn's
    // *marginal* prompt tokens rather than the whole cumulative context.
    const priorTokenCount = this.#state.tokenUsage?.used;
    const turnStart = this.#now();
    let failed = false;

    try {
      // Re-check availability at the moment of use: the model may have finished downloading — or
      // become unavailable — since the engine was configured.
      await this.refreshAvailability();
      const unavailable = this.#state.availabilityMessage;
      if (unavailable !== null) {
        assistant.text = unavailable;
        assistant.isError = true;
        failed = true;
        return;
      }

      // Repair before use: availability may have cleared since `configure` ran, in which case
      // this is the first opportunity to build a session that could not be built earlier.
      const session = await this.#ensureSession();
      if (!session) {
        assistant.text = GENERIC_FAILURE_MESSAGE;
        assistant.isError = true;
        failed = true;
        return;
      }

      failed = await this.#respond(text, session, assistant, signal);
    } finally {
      this.#patch({ isResponding: false });
      // `finally` is Swift's `defer`. JavaScript has no coroutine cancellation, so unlike Kotlin
      // this needs no NonCancellable wrapper — an aborted signal never interrupts these awaits.
      if (signal.aborted) {
        // The turn was abandoned. Don't bump `updatedAt` — but if no content ever arrived, remove
        // the placeholder, or it persists forever as a blank bubble. A partial reply is kept.
        if (ChatMessage.isEmptyPlaceholder(assistant)) {
          const index = conversation.messages.indexOf(assistant);
          if (index !== -1) conversation.messages.splice(index, 1);
          await this.#repository.deleteMessage(conversation.id, assistant.id);
        } else {
          await this.#repository.saveMessage(conversation.id, assistant);
        }
      } else {
        const finishedAt = this.#now();
        conversation.updatedAt = finishedAt;
        await this.#repository.saveMessage(conversation.id, assistant);
        await this.#repository.updateConversation(conversation.id, { updatedAt: finishedAt });
      }
      this.#notifyMutation();
    }

    const turnEnd = this.#now();
    // The user navigated away mid-reply; don't refresh the meter or fire a completion signal for a
    // conversation that is no longer on screen.
    if (signal.aborted) return;
    this.refreshTokenUsage();
    this.#turnCounter += 1;
    this.#patch({ lastTurn: { id: this.#turnCounter, failed } });

    if (!failed) {
      // Best-effort usage telemetry. Detached and snapshotted so it never delays teardown.
      void this.#recordTelemetry({
        conversationId: conversation.id,
        feature: "chat",
        userText: text,
        assistantText: assistant.text,
        priorTokenCount,
        currentTokenCount: this.#state.tokenUsage?.used,
        start: turnStart,
        end: turnEnd,
      });
    }
  }

  /**
   * Streams a reply into `assistant`. Returns whether the turn failed, so the caller can pick the
   * completion-vs-error signal.
   *
   * **Chunks are deltas and are concatenated.** Swift assigns each snapshot directly because
   * Apple's `ResponseStream` yields the whole reply so far; doing that here would render only the
   * final fragment, with no error anywhere. See `ModelSession.stream`.
   */
  async #respond(
    text: string,
    session: ModelSession,
    assistant: ChatMessage,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      for await (const chunk of session.stream(text, { signal })) {
        // Stop writing into the message once the turn is cancelled, rather than mutating an
        // abandoned model each token.
        if (signal.aborted) break;
        assistant.text += chunk;
        this.#notifyMutation();
      }
      return false;
    } catch (error) {
      // Cancellation usually surfaces here as a thrown AbortError, not the loop's `aborted`
      // break — don't overwrite an abandoned message's partial text with an error it never had.
      if (signal.aborted || isCancellation(error)) return true;
      ChatEngine.#logFailure("Text response", error);
      assistant.text = this.#friendlyMessage(error);
      assistant.isError = true;
      return true;
    }
  }

  // MARK: - Compaction

  /**
   * Compacts the conversation in place: summarizes the turns since the last compaction, drops a
   * "Conversation compacted" divider, and rebuilds the session from the summary — so the chat
   * keeps going under the same id instead of hitting a dead end at capacity. Manual only, driven
   * by the capacity banner.
   */
  compact(): void {
    // Only from the warning band: `full` is intentionally past the point of compaction (the
    // summarizer would overflow the same window), and `normal` has nothing worth condensing.
    if (this.#state.isResponding || this.#state.isCompacting) return;
    if (this.capacityState !== CapacityState.approaching) return;
    this.cancelActiveTurn();
    const controller = new AbortController();
    this.#activeTurn = controller;
    this.#activeTurnPromise = this.#runTurn(controller.signal, (signal) =>
      this.#performCompaction(signal),
    );
  }

  async #performCompaction(signal: AbortSignal): Promise<void> {
    const conversation = this.#state.conversation;
    if (!conversation || !this.#session || signal.aborted) return;

    await this.refreshAvailability();
    if (this.#state.availabilityMessage !== null) {
      await this.#insertErrorNotice(this.#state.availabilityMessage, conversation);
      return;
    }

    const ordered = Conversation.orderedMessages(conversation);
    const toSummarize = Compaction.liveMessages(ordered);
    // Nothing to condense — compaction can't reclaim anything. Guard rather than insert an empty
    // divider.
    if (toSummarize.length === 0) return;
    const previousSummary = Compaction.activeSummary(ordered);

    this.#compactionGeneration += 1;
    const generation = this.#compactionGeneration;
    this.#patch({ isCompacting: true });

    const start = this.#now();
    let summary: string;
    try {
      summary = await this.#summarize(previousSummary, toSummarize, signal);
    } catch (error) {
      // Surface a friendly notice and insert no marker, so the user can retry from the still-
      // showing capacity banner. Skip if the turn was abandoned.
      if (!signal.aborted && !isCancellation(error)) {
        ChatEngine.#logFailure("Compaction summary", error);
        await this.#insertErrorNotice(COMPACTION_FAILURE_MESSAGE, conversation);
      }
      return;
    } finally {
      // Only clear the flag if this is still the current compaction — a superseded task unwinding
      // late must not re-enable the controls under a newer one.
      if (generation === this.#compactionGeneration) this.#patch({ isCompacting: false });
    }
    const end = this.#now();

    if (signal.aborted) return;
    // An empty summary would silently discard the compacted context — treat it as a failure so the
    // user can retry rather than losing the history.
    if (summary.trim() === "") {
      await this.#insertErrorNotice(COMPACTION_FAILURE_MESSAGE, conversation);
      return;
    }

    // Appended at the end, so the divider renders at the seam and the auto-scroll on insertion
    // brings it into view.
    const marker = ChatMessage.make({
      role: ChatRole.assistant,
      text: summary.trim(),
      isCompactionSummary: true,
      createdAt: this.#now(),
    });
    conversation.messages.push(marker);
    await this.#repository.insertMessage(conversation.id, marker);
    conversation.updatedAt = this.#now();
    await this.#repository.updateConversation(conversation.id, {
      updatedAt: conversation.updatedAt,
    });

    // Rebuild the working session from the now-compacted history. This is what frees the budget.
    this.#destroySession();
    try {
      this.#session = await this.#makeSession(conversation.messages);
    } catch {
      this.#session = null;
    }
    this.refreshTokenUsage();
    this.#notifyMutation();

    void this.#recordTelemetry({
      conversationId: conversation.id,
      feature: "compaction",
      userText: "",
      assistantText: marker.text,
      priorTokenCount: 0,
      currentTokenCount: undefined,
      start,
      end,
    });
  }

  /**
   * Summarizes `messages`, optionally folding in the prior summary so compaction is cumulative.
   * Uses a throwaway session — kept separate from the live chat session so this internal call
   * never lands in the conversation's own transcript.
   */
  async #summarize(
    previousSummary: string | undefined,
    messages: readonly ChatMessage[],
    signal: AbortSignal,
  ): Promise<string> {
    const summarizer = await this.#model.createSession({ systemPrompt: SUMMARY_INSTRUCTIONS });
    try {
      const lines: string[] = [];
      if (previousSummary) lines.push(`Summary of the conversation so far:\n${previousSummary}\n`);
      for (const message of messages) {
        const speaker = message.role === ChatRole.user ? "User" : "Assistant";
        lines.push(`${speaker}: ${message.text}`);
      }
      const prompt = `Summarize this conversation:\n\n${lines.join("\n")}`;
      return (await summarizer.generate(prompt, { signal })).trim();
    } finally {
      summarizer.destroy();
    }
  }

  /**
   * Inserts an app-generated error/availability notice as an assistant message. Marked `isError` so
   * it is kept out of the rehydrated transcript and doesn't count toward capacity.
   */
  async #insertErrorNotice(text: string, conversation: Conversation): Promise<void> {
    const notice = ChatMessage.make({
      role: ChatRole.assistant,
      text,
      isError: true,
      createdAt: this.#now(),
    });
    conversation.messages.push(notice);
    await this.#repository.insertMessage(conversation.id, notice);
    conversation.updatedAt = this.#now();
    await this.#repository.updateConversation(conversation.id, {
      updatedAt: conversation.updatedAt,
    });
    this.#notifyMutation();
  }

  // MARK: - Telemetry

  /**
   * Reports a completed turn as an `ondas.llm` record. No-ops when telemetry is undeliverable,
   * which for web v1 is always — see `src/kit/telemetry/TelemetryService.ts`. The guard is not
   * decoration: it skips the reply-token measurement below, which is a real model call.
   */
  async #recordTelemetry(args: {
    conversationId: string;
    feature: "chat" | "compaction";
    userText: string;
    assistantText: string;
    priorTokenCount: number | undefined;
    currentTokenCount: number | undefined;
    start: Date;
    end: Date;
  }): Promise<void> {
    if (!this.#telemetry.isDeliverable) return;

    let inputTokens = 0;
    let outputTokens = 0;
    // Report this turn's *marginal* tokens: `completion` is the reply; `prompt` is the new input
    // added this turn — the growth in context since the previous turn, minus the reply. This keeps
    // the prompt figure a per-call number rather than the whole ever-growing context.
    try {
      outputTokens = await this.#model.measureUsage(args.assistantText);
      if (args.currentTokenCount !== undefined) {
        const addedThisTurn = Math.max(0, args.currentTokenCount - (args.priorTokenCount ?? 0));
        inputTokens = Math.max(0, addedThisTurn - outputTokens);
      }
    } catch {
      // Telemetry must never break a turn that already succeeded.
      return;
    }

    await this.#telemetry.recordLLM({
      conversationId: args.conversationId,
      feature: args.feature,
      prompt: args.userText,
      completion: args.assistantText,
      inputTokens,
      outputTokens,
      start: args.start,
      end: args.end,
    });
  }

  /** Ports `ChatEngine.friendlyMessage(for:)` — a curated message, or the generic fallback. */
  #friendlyMessage(error: unknown): string {
    if (error instanceof ModelError) return curatedMessage(error.kind);
    return GENERIC_FAILURE_MESSAGE;
  }

  /**
   * Ports `ChatEngine.logFailure(_:_:)` (`ChatEngine.swift:731-739`).
   *
   * Swift logs a failed model operation **by case only**, never the error itself, because a
   * Foundation Models error's `Context` can echo prompt fragments and that would leak
   * conversation text into the device log. The same rule applies here for a stronger reason: a
   * browser console is trivially readable, and `ModelError.message` is deliberately the
   * content-free `diagnosticLabel` precisely so this line is safe to write.
   *
   * Omitting this was a real gap. The first end-to-end run failed with the generic "Sorry, I
   * couldn't finish that." and there was no way to tell which condition produced it — the
   * curated-message mapping is only useful if the unmapped case leaves a trace.
   */
  static #logFailure(operation: string, error: unknown): void {
    const label =
      error instanceof ModelError
        ? `ModelError.${error.kind} (${error.diagnosticLabel})`
        : `${(error as { name?: string } | null)?.name ?? typeof error}`;
    console.error(`[Ondas] ${operation} failed: ${label}`);
  }
}
