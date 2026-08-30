/**
 * The on-device model, behind an interface.
 *
 * Ported from `android/app/src/main/kotlin/com/keegancodes/ondas/chat/OnDeviceModel.kt`, whose
 * justification carries over word for word. Swift talks to `SystemLanguageModel` directly because
 * a `LanguageModelSession` is cheap to build and Apple's types are available in the test host.
 * Neither is true here: `LanguageModel` is a `window` global that exists only in a desktop
 * Chromium — `undefined` in Node, `undefined` in a Worker — so an interface is the only way
 * `ChatEngine`'s turn orchestration (the cancellation discipline, the capacity model, the
 * compaction generation guard, every part of it that encodes a fixed bug) can be tested in CI.
 *
 * **`ChatEngine` must never touch `LanguageModel` directly.** See web/PORTING.md § Module graph.
 */

/** Mirrors `LanguageModel.availability()`'s four states, and Android's `ModelStatus`. */
export type ModelAvailability =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

const MODEL_AVAILABILITY_VALUES: readonly string[] = [
  "unavailable",
  "downloadable",
  "downloading",
  "available",
];

/**
 * Narrows an unknown value to a [ModelAvailability].
 *
 * Chrome may add a state; an unrecognised one must degrade to `"unavailable"` at the call site
 * rather than flow through the capacity model as a string nothing switches on. This is the
 * counterpart of Swift's `@unknown default` arms in `ChatEngine.message(for:)`.
 */
export function isModelAvailability(value: unknown): value is ModelAvailability {
  return typeof value === "string" && MODEL_AVAILABILITY_VALUES.includes(value);
}

/**
 * One prior turn, replayed into a new session so the model has the conversation's history.
 *
 * Only `user` and `assistant` — the system prompt is [SessionConfig.systemPrompt], deliberately
 * a separate field. Chrome requires the system entry to be FIRST in `initialPrompts` and rejects
 * it anywhere else, so keeping it out of the array means an implementation cannot position it
 * wrongly and a caller cannot interleave one mid-history.
 */
export interface ModelTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/** How a session is seeded. Both fields absent is a bare session with no history. */
export interface SessionConfig {
  readonly systemPrompt?: string;
  /** Verified in the Chrome 152 spike: role-tagged seeding works, a recall probe answered from it. */
  readonly history?: readonly ModelTurn[];
}

/** Per-turn options. Cancellation only — see the note on sampling below. */
export interface TurnOptions {
  readonly signal?: AbortSignal;
}

/**
 * A live session: the model plus the conversation state it carries.
 *
 * Android has no session type — ML Kit is stateless and re-sends a prompt prefix each turn. The
 * web needs one because token accounting lives on the session (`contextUsage` / `contextWindow`
 * are session members; there are no statics for them) and because `destroy()` is the only way to
 * release the model's state.
 */
export interface ModelSession {
  /**
   * Tokens the session is currently holding — instructions, seeded history and every committed
   * turn. Live and synchronous, verified in the spike. A turn cancelled mid-flight does NOT
   * commit, so this does not move for an aborted turn.
   */
  readonly usage: number;

  /** The session's full context window, before any reply reserve is held back. */
  readonly window: number;

  /**
   * Streams a reply.
   *
   * **Chunks are DELTAS, not cumulative snapshots.** The Chrome 152 spike measured
   * `["One", ".", " Two", …]` with a final chunk of `"."`. Apple's `ResponseStream` yields
   * cumulative snapshots, so Swift's `assistant.text = snapshot` is correct there and would
   * render a single period here. **Callers concatenate.** Identical to the Android finding.
   *
   * Do not "simplify" a caller to assignment because the last chunk looks whole. It is not, and
   * the failure is silent: the reply renders as its own last fragment with no error anywhere.
   *
   * An empty final chunk must not read as an empty reply. A response that is empty *in total*
   * throws [ModelError] with kind `EMPTY_RESPONSE` — see D6 in PORTING.md: Chrome documents no
   * refusal behaviour, and an empty string with no error is the shape a guardrail is expected to
   * take. Swift already treats an empty compaction summary as a failure for the same reason.
   *
   * Cancellation via `options.signal` rejects with an `AbortError`, **not** a [ModelError] —
   * see [isCancellation].
   */
  stream(prompt: string, options?: TurnOptions): AsyncIterable<string>;

  /** One-shot generation, used by the compaction summariser. Same empty-response rule as [stream]. */
  generate(prompt: string, options?: TurnOptions): Promise<string>;

  /** Releases the model's state. Idempotent; any later call throws `SESSION_DESTROYED`. */
  destroy(): void;
}

export interface OnDeviceModel {
  /**
   * Whether this browser has the API at all.
   *
   * Approved addition #1 in PORTING.md: Safari and Firefox have no `LanguageModel` global — a
   * harder failure than any of Apple's three unavailable reasons, with no counterpart in the
   * Swift source. The UI keys the unsupported state off **this capability probe, never off a
   * message string**, for the reason Android's download banner does: rewording the copy would
   * otherwise silently remove the state from every browser that needs it.
   */
  isSupported(): boolean;

  /**
   * The model's current availability. **Never throws** — a browser without the API answers
   * `"unavailable"`, so a caller refreshing a banner (Swift does this on configure, on each send
   * and on foreground) never has to guard the call.
   */
  availability(): Promise<ModelAvailability>;

  /**
   * The model's full context window, before any reply reserve is held back.
   *
   * The spike measured 9216. **Read it at runtime; never hard-code it** — Chrome ships new model
   * revisions without a version signal, and a stale constant would silently mis-size the whole
   * capacity model.
   */
  contextWindow(): Promise<number>;

  /**
   * Tokens the given text would occupy. Android's `countTokens(systemPrompt, body)` takes both
   * parts because ML Kit counts the system instruction too; the web measures one string against
   * a bare session, so the caller measures whatever it is about to send.
   *
   * Note this does NOT throw on oversize input — the spike got 20006 back for ~20k tokens
   * against a 9216 window. It is a measurement, not a validation.
   */
  measureUsage(text: string): Promise<number>;

  createSession(config?: SessionConfig): Promise<ModelSession>;

  /** Reported to telemetry as `llm.model_name`. */
  baseModelName(): Promise<string>;
}

/**
 * The synthetic model id reported to telemetry.
 *
 * Chrome exposes no model name, version or revision anywhere on the API — `LanguageModel` has
 * exactly two statics, `availability` and `create`. iOS is in the same position and uses the
 * synthetic `"apple-on-device"` (`Ondas/Services/Telemetry/TelemetryService.swift:16`); this is
 * its web counterpart. Android differs only because ML Kit actually reports a name.
 */
export const WEB_MODEL_NAME = "chrome-on-device";

/**
 * The kinds of model failure Ondas has a curated message for.
 *
 * Mirrors Android's `ModelException.Kind`, but the members are the conditions **verified on
 * Chrome 152**, not Android's ML Kit codes translated on paper. Six of Android's nine have no
 * web counterpart at all (`BUSY` — concurrent prompts both succeed here, with no equivalent of
 * Apple's `concurrentRequests`; `BACKGROUND_BLOCKED`, `QUOTA_EXCEEDED`, `NEEDS_SYSTEM_UPDATE`,
 * `NOT_ENOUGH_DISK_SPACE` — none observable from a page; `POLICY_REFUSAL` — folded into
 * `EMPTY_RESPONSE`, see D6), and two are web-only.
 *
 * Cancellation is deliberately NOT a kind. See [isCancellation].
 */
export type ModelErrorKind =
  /** `QuotaExceededError`: the prompt did not fit the window. Carries `requested` / `quota`. */
  | "REQUEST_TOO_LARGE"
  /** The API exists but has no usable model — not downloaded, or the browser says unavailable. */
  | "NOT_AVAILABLE"
  /** `InvalidStateError`: prompted after `destroy()`. Web-only; sessions are explicit here. */
  | "SESSION_DESTROYED"
  /** No `LanguageModel` global. Web-only; see [OnDeviceModel.isSupported]. */
  | "UNSUPPORTED_BROWSER"
  /** The model returned nothing. The only observable shape a Chrome guardrail is known to take. */
  | "EMPTY_RESPONSE"
  | "UNKNOWN";

export interface ModelErrorInit {
  readonly cause?: unknown;
  /** From `QuotaExceededError.requested`. Tokens the rejected prompt needed. */
  readonly requested?: number;
  /** From `QuotaExceededError.quota`. Tokens available at the time. */
  readonly quota?: number;
}

/**
 * A model failure, already classified.
 *
 * Keeps `ChatEngine` free of `DOMException` and of `LanguageModel` types so it stays testable,
 * and gives the curated-message mapping something stable to switch on.
 *
 * The `message` is the [diagnosticLabel] and nothing else. This is the privacy invariant ported
 * from `ChatEngine.swift:735` — a model error's context can echo prompt fragments, so the
 * vendor's own message is never carried, logged or surfaced. Labels are content-free by
 * construction ("DOMException.QuotaExceededError"), which is what makes them safe to log.
 */
export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly diagnosticLabel: string;
  readonly requested: number | undefined;
  readonly quota: number | undefined;

  constructor(kind: ModelErrorKind, diagnosticLabel: string, init: ModelErrorInit = {}) {
    super(diagnosticLabel, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "ModelError";
    this.kind = kind;
    this.diagnosticLabel = diagnosticLabel;
    this.requested = init.requested;
    this.quota = init.quota;
  }
}

/**
 * Whether an error is the user cancelling, rather than the turn failing.
 *
 * **Cancellation is never a [ModelError].** The distinction is load-bearing in the Swift source:
 * `ChatEngine.respond(to:session:into:)` guards `!Task.isCancelled` in its catch specifically so
 * an abandoned message — the view is gone, the thread was switched or deleted — is not
 * overwritten with an error it never had (`ChatEngine.swift:686-690`). A web port that wrapped
 * `AbortError` into the error taxonomy would paint "Sorry, I couldn't finish that." over every
 * deliberately cancelled turn.
 *
 * Matched on `name`, not on message text or `instanceof DOMException`: the reason attached to an
 * `AbortSignal` may be constructed by any layer, and `DOMException` is not the same class object
 * across every realm.
 */
export function isCancellation(error: unknown): boolean {
  if (error instanceof ModelError) return false;
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/*
 * ---------------------------------------------------------------------------------------------
 * Curated, user-facing copy.
 *
 * Ported from `ChatEngine.swift`'s two `message(for:)` functions (:710 and :758). The vendor's
 * own strings are never surfaced: Apple's are developer-facing ("Exceeded the context window
 * size."), Chrome's are worse — a `QuotaExceededError` arrives with no message at all.
 *
 * These are NAMED EXPORTED CONSTANTS rather than inline strings for the reason Android recorded
 * on `MODEL_DOWNLOADABLE_MESSAGE`: the copy was independently duplicated in the UI, coupled only
 * by a test, and two copies of user-facing text drift. Tests assert against the constant.
 *
 * Structural note: in both source apps this table lives inside `ChatEngine`. It sits here so
 * that the copy and the taxonomy it switches on cannot drift apart, and so a copy change fails a
 * test in the file that owns the taxonomy. Recorded as a deviation in PORTING.md.
 * ---------------------------------------------------------------------------------------------
 */

/** Verbatim from `ChatEngine.swift:713` (`.exceededContextWindowSize`). */
export const CONTEXT_EXCEEDED_MESSAGE =
  "This conversation has grown too long to continue. Start a new chat to keep going.";

/** Verbatim from `ChatEngine.swift:715` (`.guardrailViolation`, `.refusal`). */
export const REFUSAL_MESSAGE = "I can't help with that request.";

/** Verbatim from `ChatEngine.swift:723` (`.assetsUnavailable`). */
export const MODEL_NOT_READY_MESSAGE =
  "The on-device model is still getting ready. Try again shortly.";

/** Verbatim from `ChatEngine.swift:707` (`friendlyMessage`'s fallback). */
export const GENERIC_FAILURE_MESSAGE = "Sorry, I couldn't finish that. Please try again.";

/**
 * Web-only. Swift has no counterpart because Apple's sessions are implicit and never explicitly
 * torn down; here `destroy()` exists and a late turn can land after it. Written in the same
 * voice as the Swift table: state the condition, then the one action that clears it.
 */
export const SESSION_CLOSED_MESSAGE = "That chat session was closed. Send your message again.";

/**
 * Web-only, and the approved addition #1 state. Swift's nearest condition is
 * `.deviceNotEligible` — "This device doesn't support Apple Intelligence, so chat isn't
 * available." (`ChatEngine.swift:761`) — but the web failure is per-BROWSER, not per-device, and
 * naming the device would send a Safari user on macOS looking for a hardware problem.
 */
export const UNSUPPORTED_BROWSER_MESSAGE =
  "This browser doesn't support on-device AI, so chat isn't available. Try desktop Chrome.";

/**
 * Availability `"unavailable"`: the API is present and says no. Swift's `.deviceNotEligible`
 * copy (`ChatEngine.swift:761`) with "Apple Intelligence" replaced by the neutral phrasing the
 * Android port already uses for the identical state.
 */
export const MODEL_UNAVAILABLE_MESSAGE =
  "This device doesn't support on-device AI, so chat isn't available.";

/**
 * Availability `"downloadable"`. Apple has no such state — `.modelNotReady` covers both — so
 * this is Android's `ChatEngine.MODEL_DOWNLOADABLE_MESSAGE` verbatim, which was written for the
 * identical ML Kit state.
 */
export const MODEL_DOWNLOADABLE_MESSAGE =
  "Ondas needs to download the on-device model before you can chat.";

/** Availability `"downloading"`. Verbatim from `ChatEngine.swift:765` (`.modelNotReady`). */
export const MODEL_DOWNLOADING_MESSAGE =
  "The on-device model is still downloading. Try again shortly.";

/**
 * Curated text for a classified failure. The counterpart of
 * `ChatEngine.message(for: LanguageModelSession.GenerationError)` (`ChatEngine.swift:710`).
 *
 * Swift returns `nil` for the cases it has no copy for and lets `friendlyMessage` fall back;
 * every kind here has copy, and `UNKNOWN` *is* the fallback, so this returns a string.
 */
export function curatedMessage(kind: ModelErrorKind): string {
  switch (kind) {
    case "REQUEST_TOO_LARGE":
      return CONTEXT_EXCEEDED_MESSAGE;
    case "EMPTY_RESPONSE":
      return REFUSAL_MESSAGE;
    case "NOT_AVAILABLE":
      return MODEL_NOT_READY_MESSAGE;
    case "SESSION_DESTROYED":
      return SESSION_CLOSED_MESSAGE;
    case "UNSUPPORTED_BROWSER":
      return UNSUPPORTED_BROWSER_MESSAGE;
    case "UNKNOWN":
      return GENERIC_FAILURE_MESSAGE;
  }
}

/**
 * The banner copy for an availability state, or `null` when the model is ready.
 *
 * The counterpart of `ChatEngine.message(for: SystemLanguageModel.Availability.UnavailableReason)`
 * (`ChatEngine.swift:758`), driving the same `availabilityMessage` banner that Swift recomputes
 * on configure, on each send, and on return to the foreground.
 */
export function availabilityMessage(availability: ModelAvailability): string | null {
  switch (availability) {
    case "available":
      return null;
    case "downloadable":
      return MODEL_DOWNLOADABLE_MESSAGE;
    case "downloading":
      return MODEL_DOWNLOADING_MESSAGE;
    case "unavailable":
      return MODEL_UNAVAILABLE_MESSAGE;
  }
}
