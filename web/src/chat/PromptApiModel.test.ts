import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelError, isCancellation, type ModelSession } from "./OnDeviceModel";
import {
  PromptApiModel,
  type LanguageModelCreateOptions,
  type LanguageModelGlobal,
  type LanguageModelPromptOptions,
  type LanguageModelSessionHandle,
} from "./PromptApiModel";

/*
 * There is no `LanguageModel` in Node, so the API is faked and `PromptApiModel` is asserted
 * against the fake. The fake reproduces only what the Chrome 152 spike actually measured — most
 * importantly that `promptStreaming` yields DELTAS. A fake that yielded cumulative snapshots
 * would make the concatenation test pass for the wrong reason and hide the real bug.
 */

/** What the fake session should do on the next `promptStreaming`. */
type StreamScript = { readonly chunks: readonly string[] } | { readonly error: unknown };
/** What the fake session should do on the next `prompt`. */
type PromptScript = { readonly text: string } | { readonly error: unknown };

class FakeSession implements LanguageModelSessionHandle {
  contextUsage = 0;
  destroyed = false;
  destroyCount = 0;
  readonly measured: string[] = [];
  readonly prompted: string[] = [];

  constructor(
    private readonly model: FakeLanguageModel,
    readonly createOptions: LanguageModelCreateOptions | undefined,
  ) {}

  get contextWindow(): number {
    return this.model.contextWindowValue;
  }

  async measureContextUsage(input: string): Promise<number> {
    this.measured.push(input);
    // Deliberately not a length: nothing may assume tokens and characters are the same thing.
    return input.length * 3;
  }

  async prompt(input: string, options?: LanguageModelPromptOptions): Promise<string> {
    this.prompted.push(input);
    if (this.destroyed) throw domException("InvalidStateError");
    if (options?.signal?.aborted === true) throw domException("AbortError");
    const script = this.model.promptScript;
    if ("error" in script) throw script.error;
    return script.text;
  }

  promptStreaming(input: string, options?: LanguageModelPromptOptions): AsyncIterable<string> {
    this.prompted.push(input);
    // Chrome throws this synchronously, before any stream object exists.
    if (this.destroyed) throw domException("InvalidStateError");
    const script = this.model.streamScript;
    const signal = options?.signal;
    return (async function* generate(): AsyncGenerator<string> {
      if ("error" in script) throw script.error;
      for (const chunk of script.chunks) {
        if (signal?.aborted === true) throw domException("AbortError");
        yield chunk;
      }
    })();
  }

  destroy(): void {
    this.destroyed = true;
    this.destroyCount += 1;
  }
}

class FakeLanguageModel implements LanguageModelGlobal {
  availabilityState: string = "available";
  availabilityError: unknown = undefined;
  contextWindowValue = 9216;
  createError: unknown = undefined;
  streamScript: StreamScript = { chunks: ["Hello"] };
  promptScript: PromptScript = { text: "Hello" };
  readonly sessions: FakeSession[] = [];

  async availability(): Promise<string> {
    if (this.availabilityError !== undefined) throw this.availabilityError;
    return this.availabilityState;
  }

  async create(options?: LanguageModelCreateOptions): Promise<LanguageModelSessionHandle> {
    if (this.createError !== undefined) throw this.createError;
    const session = new FakeSession(this, options);
    this.sessions.push(session);
    return session;
  }

  /** The session the chat turns run on — the last one created, after the probe sessions. */
  lastSession(): FakeSession {
    const session = this.sessions.at(-1);
    if (session === undefined) throw new Error("no session was created");
    return session;
  }
}

function domException(name: string, extras: Record<string, number> = {}): DOMException {
  return Object.assign(new DOMException("", name), extras);
}

/** Fails loudly if the call under test resolves — an "expected to throw" that cannot pass silently. */
async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail, but it resolved");
}

async function captureModelError(run: () => Promise<unknown>): Promise<ModelError> {
  const error = await captureError(run);
  expect(error).toBeInstanceOf(ModelError);
  return error as ModelError;
}

async function collect(chunks: AsyncIterable<string>): Promise<string[]> {
  const received: string[] = [];
  for await (const chunk of chunks) received.push(chunk);
  return received;
}

let fake: FakeLanguageModel;
let model: PromptApiModel;

beforeEach(() => {
  fake = new FakeLanguageModel();
  installGlobal(fake);
  model = new PromptApiModel();
});

afterEach(() => {
  installGlobal(undefined);
});

function installGlobal(value: LanguageModelGlobal | undefined): void {
  const container = globalThis as { LanguageModel?: LanguageModelGlobal };
  if (value === undefined) {
    delete container.LanguageModel;
  } else {
    container.LanguageModel = value;
  }
}

async function session(): Promise<ModelSession> {
  return model.createSession();
}

describe("streaming", () => {
  it("yields deltas that concatenate into the whole reply", async () => {
    // THE headline test. The spike measured `["One", ".", " Two", …]` with a final chunk of
    // ".". Apple yields cumulative snapshots, so a port that assigns the last chunk — the
    // obvious "simplification" — renders " Two" and loses everything before it, silently, with
    // no error anywhere. If this suite ever accepts " Two", the bug is back.
    fake.streamScript = { chunks: ["One", ".", " Two"] };
    const chunks = await collect((await session()).stream("count"));

    expect(chunks).toEqual(["One", ".", " Two"]);
    expect(chunks.join("")).toBe("One. Two");
    expect(chunks.join("")).not.toBe(" Two");
  });

  it("does not empty a reply whose final chunk is empty", async () => {
    fake.streamScript = { chunks: ["Hello", " there", ""] };
    const text = (await collect((await session()).stream("hi"))).join("");
    expect(text).toBe("Hello there");
  });

  it("forwards the prompt to the session", async () => {
    await collect((await session()).stream("what is the capital of Peru?"));
    expect(fake.lastSession().prompted).toEqual(["what is the capital of Peru?"]);
  });
});

describe("the empty-response guard", () => {
  // D6 in PORTING.md: Chrome documents no refusal behaviour, so an empty string with no error is
  // the shape a guardrail is assumed to take. Swift already treats an empty compaction summary
  // as a failure, so the guard is a port rather than an invention.
  it("classifies a stream that produced nothing at all", async () => {
    fake.streamScript = { chunks: [] };
    const error = await captureModelError(async () => collect((await session()).stream("hi")));
    expect(error.kind).toBe("EMPTY_RESPONSE");
  });

  it("classifies a stream of nothing but empty and blank chunks", async () => {
    fake.streamScript = { chunks: ["", "  ", "\n"] };
    const error = await captureModelError(async () => collect((await session()).stream("hi")));
    expect(error.kind).toBe("EMPTY_RESPONSE");
  });

  it("classifies an empty one-shot generation", async () => {
    fake.promptScript = { text: "   " };
    const error = await captureModelError(async () => (await session()).generate("summarize"));
    expect(error.kind).toBe("EMPTY_RESPONSE");
  });

  it("leaves a non-empty generation alone, whitespace and all", async () => {
    fake.promptScript = { text: "  a summary  " };
    expect(await (await session()).generate("summarize")).toBe("  a summary  ");
  });
});

describe("the error taxonomy", () => {
  it("maps QuotaExceededError to REQUEST_TOO_LARGE and keeps the measurements", async () => {
    const raw = domException("QuotaExceededError", { requested: 20_006, quota: 9_216 });
    fake.promptScript = { error: raw };
    const error = await captureModelError(async () => (await session()).generate("war and peace"));

    expect(error.kind).toBe("REQUEST_TOO_LARGE");
    expect(error.requested).toBe(20_006);
    expect(error.quota).toBe(9_216);
    expect(error.diagnosticLabel).toBe("DOMException.QuotaExceededError");
    expect(error.cause).toBe(raw);
  });

  it("maps QuotaExceededError from a stream too", async () => {
    fake.streamScript = { error: domException("QuotaExceededError", { requested: 12, quota: 9 }) };
    const error = await captureModelError(async () => collect((await session()).stream("x")));
    expect(error.kind).toBe("REQUEST_TOO_LARGE");
    expect(error.requested).toBe(12);
  });

  it("maps InvalidStateError to SESSION_DESTROYED", async () => {
    const live = await session();
    live.destroy();
    const error = await captureModelError(() => live.generate("still there?"));
    expect(error.kind).toBe("SESSION_DESTROYED");
    expect(error.diagnosticLabel).toBe("DOMException.InvalidStateError");
  });

  it("maps a synchronous InvalidStateError from promptStreaming too", async () => {
    // `promptStreaming` throws before returning a stream, so a call hoisted out of the try
    // block would escape the taxonomy as a raw DOMException.
    const live = await session();
    live.destroy();
    const error = await captureModelError(() => collect(live.stream("still there?")));
    expect(error.kind).toBe("SESSION_DESTROYED");
  });

  it("maps NotSupportedError to NOT_AVAILABLE", async () => {
    fake.createError = domException("NotSupportedError");
    const error = await captureModelError(() => model.createSession());
    expect(error.kind).toBe("NOT_AVAILABLE");
  });

  it("classifies anything unrecognised as UNKNOWN without losing the cause", async () => {
    const raw = domException("DataError");
    fake.promptScript = { error: raw };
    const error = await captureModelError(async () => (await session()).generate("hi"));
    expect(error.kind).toBe("UNKNOWN");
    expect(error.diagnosticLabel).toBe("DOMException.DataError");
    expect(error.cause).toBe(raw);
  });

  it("classifies a non-DOMException throw as UNKNOWN with a content-free label", async () => {
    fake.promptScript = { error: "the prompt was: my private diary" };
    const error = await captureModelError(async () => (await session()).generate("hi"));
    expect(error.kind).toBe("UNKNOWN");
    expect(error.diagnosticLabel).toBe("LanguageModel.unknown");
    expect(error.message).not.toContain("diary");
  });
});

describe("cancellation", () => {
  // Load-bearing: `ChatEngine.respond(to:session:into:)` guards `!Task.isCancelled` in its catch
  // precisely so an abandoned turn is not overwritten with an error it never had. Wrapping
  // AbortError into the taxonomy would paint "Sorry, I couldn't finish that." over every
  // deliberately cancelled turn.
  it("propagates an aborted stream as cancellation, not as a ModelError", async () => {
    fake.streamScript = { error: domException("AbortError") };
    const error = await captureError(async () => collect((await session()).stream("hi")));

    expect(error).not.toBeInstanceOf(ModelError);
    expect(isCancellation(error)).toBe(true);
  });

  it("propagates an abort raised mid-stream, keeping the chunks already delivered", async () => {
    fake.streamScript = { chunks: ["One", ".", " Two"] };
    const controller = new AbortController();
    const received: string[] = [];

    const error = await captureError(async () => {
      for await (const chunk of (await session()).stream("hi", { signal: controller.signal })) {
        received.push(chunk);
        controller.abort();
      }
    });

    expect(received).toEqual(["One"]);
    expect(error).not.toBeInstanceOf(ModelError);
    expect(isCancellation(error)).toBe(true);
  });

  it("propagates an aborted one-shot generation as cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await captureError(async () =>
      (await session()).generate("hi", { signal: controller.signal }),
    );

    expect(error).not.toBeInstanceOf(ModelError);
    expect(isCancellation(error)).toBe(true);
  });
});

describe("an unsupported browser", () => {
  // Approved addition #1 in PORTING.md. Safari and Firefox have no `LanguageModel` at all.
  beforeEach(() => {
    installGlobal(undefined);
    model = new PromptApiModel();
  });

  it("reports itself unsupported without throwing at construction or probe", () => {
    expect(model.isSupported()).toBe(false);
  });

  it("answers availability instead of throwing, so a banner refresh never needs a guard", async () => {
    await expect(model.availability()).resolves.toBe("unavailable");
  });

  it("classifies every operation that needs the API as UNSUPPORTED_BROWSER", async () => {
    for (const run of [
      () => model.createSession(),
      () => model.contextWindow(),
      () => model.measureUsage("hi"),
    ]) {
      const error = await captureModelError(run);
      expect(error.kind).toBe("UNSUPPORTED_BROWSER");
      expect(error.diagnosticLabel).toBe("LanguageModel.undefined");
    }
  });

  it("reads the global on every call, so a late-arriving API is picked up", () => {
    // The module is imported during the server render of the app shell, where the global is
    // absent and always will be. Capturing it once at import would pin "unsupported" forever.
    expect(model.isSupported()).toBe(false);
    installGlobal(fake);
    expect(model.isSupported()).toBe(true);
  });
});

describe("availability", () => {
  it("passes through each of the four states", async () => {
    for (const state of ["unavailable", "downloadable", "downloading", "available"]) {
      fake.availabilityState = state;
      await expect(model.availability()).resolves.toBe(state);
    }
  });

  it("degrades an unrecognised state to unavailable", async () => {
    fake.availabilityState = "readily";
    await expect(model.availability()).resolves.toBe("unavailable");
  });

  it("never throws, even when the API does", async () => {
    fake.availabilityError = domException("InvalidStateError");
    await expect(model.availability()).resolves.toBe("unavailable");
  });
});

describe("token accounting", () => {
  it("reads the context window at runtime rather than assuming 9216", async () => {
    fake.contextWindowValue = 4096;
    await expect(model.contextWindow()).resolves.toBe(4096);
  });

  it("destroys the throwaway session it reads the window from", async () => {
    await model.contextWindow();
    expect(fake.sessions).toHaveLength(1);
    expect(fake.sessions[0]?.destroyed).toBe(true);
  });

  it("measures usage and destroys the throwaway session on every path", async () => {
    await expect(model.measureUsage("abc")).resolves.toBe(9);
    expect(fake.sessions[0]?.measured).toEqual(["abc"]);
    expect(fake.sessions[0]?.destroyed).toBe(true);
  });

  it("destroys the throwaway session even when the measurement fails", async () => {
    const failing = new PromptApiModel(() => ({
      availability: fake.availability.bind(fake),
      create: async (options) => {
        const created = await fake.create(options);
        return Object.assign(created, {
          measureContextUsage: async (): Promise<number> => {
            throw domException("DataError");
          },
        });
      },
    }));
    const error = await captureModelError(() => failing.measureUsage("abc"));
    expect(error.kind).toBe("UNKNOWN");
    expect(fake.sessions[0]?.destroyed).toBe(true);
  });

  it("exposes the session's live usage and window rather than a snapshot", async () => {
    const live = await session();
    expect(live.usage).toBe(0);
    expect(live.window).toBe(9216);

    // `contextUsage` is a live synchronous property; a turn moves it under the wrapper.
    fake.lastSession().contextUsage = 512;
    expect(live.usage).toBe(512);
  });
});

describe("session lifecycle", () => {
  it("seeds the system prompt first, then the history, role-tagged", async () => {
    await model.createSession({
      systemPrompt: "You are Ondas.",
      history: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    });

    expect(fake.lastSession().createOptions?.initialPrompts).toEqual([
      { role: "system", content: "You are Ondas." },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("omits initialPrompts entirely for a bare session", async () => {
    await model.createSession();
    expect(fake.lastSession().createOptions).toEqual({});
  });

  it("omits an empty system prompt rather than seeding a blank system turn", async () => {
    await model.createSession({ systemPrompt: "", history: [{ role: "user", content: "hi" }] });
    expect(fake.lastSession().createOptions?.initialPrompts).toEqual([
      { role: "user", content: "hi" },
    ]);
  });

  it("destroys once, however many times it is asked", async () => {
    const live = await session();
    live.destroy();
    live.destroy();
    expect(fake.lastSession().destroyCount).toBe(1);
  });
});

describe("telemetry identity", () => {
  it("reports the synthetic model name Chrome will not give us", async () => {
    await expect(model.baseModelName()).resolves.toBe("chrome-on-device");
  });
});
