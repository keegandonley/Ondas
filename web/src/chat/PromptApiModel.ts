import {
  ModelError,
  WEB_MODEL_NAME,
  isCancellation,
  isModelAvailability,
  type ModelAvailability,
  type ModelSession,
  type OnDeviceModel,
  type SessionConfig,
  type TurnOptions,
} from "./OnDeviceModel";

/**
 * [OnDeviceModel] on Chrome's built-in Prompt API. The web counterpart of Android's `MlKitModel`.
 *
 * Everything surprising here was measured on Chrome 152 from the real origin on 2026-08-28 and
 * is tabulated in web/PORTING.md § "The verified Prompt API surface". **Do not change any of it
 * from memory or from a blog post** — two published facts are wrong, and `create()` validates
 * nothing, so "no error" proves nothing about whether an option works. `app/probe/page.tsx`
 * re-runs the spike in-app; reproduce before trusting.
 *
 * Nothing here throws at import time. Safari and Firefox have no `LanguageModel` at all, and the
 * module is imported by the app shell before any capability check runs.
 */

/* ---------------------------------------------------------------------------------------------
 * The `LanguageModel` global, typed.
 *
 * Hand-written because no lib ships these types and adding a dependency for them is not
 * warranted. Only what the spike VERIFIED is declared. In particular there is no `params()`
 * static (it does not exist) and no `temperature` / `topK` / `samplingMode` on the create
 * options: all three are silently ignored, `create({ totallyMadeUpOption: 12345 })` was accepted
 * without error, and `temperature: 0` produced four different completions for one prompt. Typing
 * them would advertise a control that does not exist.
 * ------------------------------------------------------------------------------------------ */

export interface LanguageModelInitialPrompt {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface LanguageModelCreateOptions {
  /** The system entry must be FIRST, and may appear only once. */
  readonly initialPrompts?: readonly LanguageModelInitialPrompt[];
  readonly signal?: AbortSignal;
}

export interface LanguageModelPromptOptions {
  readonly signal?: AbortSignal;
}

/**
 * `promptStreaming` returns a `ReadableStream<string>` which is also async-iterable in Chrome.
 * Both shapes are accepted because async iteration of a `ReadableStream` is the newer of the two
 * and a polyfilled or wrapped stream may expose only `getReader()`.
 */
export type LanguageModelStream = AsyncIterable<string> | ReadableStream<string>;

/**
 * Only the members the spike found. The token-accounting properties are `contextUsage` /
 * `contextWindow` / `measureContextUsage()` — **not** the widely published `inputUsage` /
 * `inputQuota` / `measureInputUsage`, which were renamed and do not exist.
 */
export interface LanguageModelSessionHandle {
  /** Live and synchronous. */
  readonly contextUsage: number;
  readonly contextWindow: number;
  measureContextUsage(input: string): Promise<number>;
  prompt(input: string, options?: LanguageModelPromptOptions): Promise<string>;
  promptStreaming(input: string, options?: LanguageModelPromptOptions): LanguageModelStream;
  destroy(): void;
}

/** The global. Exactly two statics — `availability` and `create`. */
export interface LanguageModelGlobal {
  availability(): Promise<string>;
  create(options?: LanguageModelCreateOptions): Promise<LanguageModelSessionHandle>;
}

/**
 * Reads the global on every call rather than capturing it once.
 *
 * Deliberate: this module is imported during the server render of the app shell, where the
 * global is absent and always will be. A value captured at import time would pin "unsupported"
 * for the life of the module in any bundler that reuses the module instance.
 */
function lookupLanguageModel(): LanguageModelGlobal | undefined {
  return (globalThis as { LanguageModel?: LanguageModelGlobal }).LanguageModel;
}

export class PromptApiModel implements OnDeviceModel {
  /** Injectable for tests; production passes nothing and reads `globalThis`. */
  private readonly lookup: () => LanguageModelGlobal | undefined;

  constructor(lookup: () => LanguageModelGlobal | undefined = lookupLanguageModel) {
    this.lookup = lookup;
  }

  isSupported(): boolean {
    return this.lookup() !== undefined;
  }

  /**
   * Never throws, by contract. An unrecognised state degrades to `"unavailable"` rather than
   * flowing on as a string nothing switches on — Swift's `@unknown default` discipline.
   */
  async availability(): Promise<ModelAvailability> {
    const api = this.lookup();
    if (api === undefined) return "unavailable";
    try {
      const state = await api.availability();
      return isModelAvailability(state) ? state : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  /**
   * Reads the window off a throwaway session.
   *
   * There is no static for it: `contextWindow` is a session member and `LanguageModel.params()`
   * does not exist. The session is destroyed in a `finally` — the drain-on-every-path discipline
   * PORTING.md calls out; an orphaned session holds model state until the page goes away.
   */
  async contextWindow(): Promise<number> {
    return this.withProbeSession((session) => session.contextWindow);
  }

  /** Same throwaway-session shape as [contextWindow], for the same reason. */
  async measureUsage(text: string): Promise<number> {
    return this.withProbeSession((session) => session.measureContextUsage(text));
  }

  async createSession(config: SessionConfig = {}): Promise<ModelSession> {
    const api = this.requireApi();
    const initialPrompts = buildInitialPrompts(config);
    try {
      const handle = await api.create(
        initialPrompts.length > 0 ? { initialPrompts } : {},
      );
      return new PromptApiSession(handle);
    } catch (error) {
      throw translate(error);
    }
  }

  /** Chrome reports no model name anywhere; see [WEB_MODEL_NAME]. */
  async baseModelName(): Promise<string> {
    return WEB_MODEL_NAME;
  }

  private requireApi(): LanguageModelGlobal {
    const api = this.lookup();
    if (api === undefined) {
      throw new ModelError("UNSUPPORTED_BROWSER", "LanguageModel.undefined");
    }
    return api;
  }

  private async withProbeSession<T>(
    body: (session: LanguageModelSessionHandle) => T | Promise<T>,
  ): Promise<T> {
    const api = this.requireApi();
    let session: LanguageModelSessionHandle;
    try {
      session = await api.create({});
    } catch (error) {
      throw translate(error);
    }
    try {
      return await body(session);
    } catch (error) {
      throw translate(error);
    } finally {
      session.destroy();
    }
  }
}

/**
 * Seeds `initialPrompts`. The system entry goes first because Chrome rejects it anywhere else,
 * which is why [SessionConfig] keeps it out of the history array in the first place.
 */
function buildInitialPrompts(config: SessionConfig): LanguageModelInitialPrompt[] {
  const prompts: LanguageModelInitialPrompt[] = [];
  if (config.systemPrompt !== undefined && config.systemPrompt.length > 0) {
    prompts.push({ role: "system", content: config.systemPrompt });
  }
  for (const turn of config.history ?? []) {
    prompts.push({ role: turn.role, content: turn.content });
  }
  return prompts;
}

class PromptApiSession implements ModelSession {
  private readonly handle: LanguageModelSessionHandle;
  private destroyed = false;

  constructor(handle: LanguageModelSessionHandle) {
    this.handle = handle;
  }

  get usage(): number {
    return this.handle.contextUsage;
  }

  get window(): number {
    return this.handle.contextWindow;
  }

  /**
   * **Yields DELTAS.** See [ModelSession.stream]; the concatenation happens in the caller and the
   * accumulator here exists only to tell an empty reply from a reply whose last chunk is empty.
   *
   * Every chunk is forwarded as received, including empty ones. Filtering them would be a lie
   * about what the model emitted, and a caller that appends is unaffected either way.
   */
  async *stream(prompt: string, options: TurnOptions = {}): AsyncIterable<string> {
    let accumulated = "";
    try {
      // Inside the try: `promptStreaming` on a destroyed session throws synchronously, so a call
      // hoisted above the catch would escape the taxonomy as a raw DOMException.
      const chunks = this.handle.promptStreaming(prompt, promptOptions(options));
      for await (const chunk of iterateStream(chunks)) {
        accumulated += chunk;
        yield chunk;
      }
    } catch (error) {
      throw translate(error);
    }
    if (accumulated.trim().length === 0) {
      throw emptyResponse();
    }
  }

  async generate(prompt: string, options: TurnOptions = {}): Promise<string> {
    let response: string;
    try {
      response = await this.handle.prompt(prompt, promptOptions(options));
    } catch (error) {
      throw translate(error);
    }
    if (response.trim().length === 0) {
      throw emptyResponse();
    }
    return response;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.handle.destroy();
  }
}

/**
 * `exactOptionalPropertyTypes` forbids handing on `{ signal: undefined }`, and an explicitly
 * undefined `signal` is not the same thing to the platform as an absent one.
 */
function promptOptions(options: TurnOptions): LanguageModelPromptOptions {
  return options.signal !== undefined ? { signal: options.signal } : {};
}

/** Accepts either shape of [LanguageModelStream]; see the type's note. */
async function* iterateStream(stream: LanguageModelStream): AsyncGenerator<string> {
  if (Symbol.asyncIterator in stream) {
    yield* stream as AsyncIterable<string>;
    return;
  }
  const reader = (stream as ReadableStream<string>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * The model returned nothing.
 *
 * D6 in PORTING.md: Chrome documents no guardrail or refusal behaviour and none could be
 * triggered from a live page, so an empty string with no error is the shape a refusal is assumed
 * to take. Swift already treats an empty compaction summary as a failure
 * (`ChatEngine.CompactionError.emptySummary`, `ChatEngine.swift:441`) for exactly this reason,
 * so the guard is a port, not an invention.
 */
function emptyResponse(): ModelError {
  return new ModelError("EMPTY_RESPONSE", "LanguageModel.emptyResponse");
}

/**
 * Maps a raw failure onto the classified [ModelError] the engine switches on.
 *
 * Matched on `DOMException.name`, **never on message text**: Chrome's messages are unversioned
 * developer strings, several of these arrive with no message at all, and a message-matching
 * mapping silently degrades to `UNKNOWN` the first time one is reworded — the same reason
 * PORTING.md forbids keying the unsupported-browser state off copy.
 */
function translate(error: unknown): unknown {
  // Cancellation is not a failure. It must reach `ChatEngine` as itself so an abandoned turn is
  // distinguishable from a broken one. See `isCancellation`.
  if (isCancellation(error)) return error;
  // Already classified — re-wrapping would bury the original kind under UNKNOWN.
  if (error instanceof ModelError) return error;

  const name = typeof error === "object" && error !== null
    ? (error as { name?: unknown }).name
    : undefined;
  const label = typeof name === "string" ? `DOMException.${name}` : "LanguageModel.unknown";

  switch (name) {
    case "QuotaExceededError": {
      // Verified: carries numeric `.requested` and `.quota`. Both are kept — `ChatEngine`'s
      // capacity model can say how far over the line a turn was, which Apple never reports.
      const { requested, quota } = quotaFields(error);
      return new ModelError("REQUEST_TOO_LARGE", label, {
        cause: error,
        ...(requested !== undefined ? { requested } : {}),
        ...(quota !== undefined ? { quota } : {}),
      });
    }
    case "InvalidStateError":
      // Verified: `prompt()` after `destroy()`.
      return new ModelError("SESSION_DESTROYED", label, { cause: error });
    case "NotSupportedError":
      // NOT verified — the spike ran on a machine where availability was "available", so a
      // create() against an unavailable model was never observed. Mapped from the specification
      // text alone, and flagged as such rather than presented as measured.
      return new ModelError("NOT_AVAILABLE", label, { cause: error });
    default:
      return new ModelError("UNKNOWN", label, { cause: error });
  }
}

function quotaFields(error: unknown): { requested?: number; quota?: number } {
  const source = error as { requested?: unknown; quota?: unknown };
  const fields: { requested?: number; quota?: number } = {};
  if (typeof source.requested === "number") fields.requested = source.requested;
  if (typeof source.quota === "number") fields.quota = source.quota;
  return fields;
}
