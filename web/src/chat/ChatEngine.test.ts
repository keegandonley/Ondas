import { beforeEach, describe, expect, it } from "vitest";

import { ChatEngine } from "./ChatEngine";
import { ModelError } from "./OnDeviceModel";
import type {
  ModelAvailability,
  ModelSession,
  OnDeviceModel,
  SessionConfig,
  TurnOptions,
} from "./OnDeviceModel";
import { InMemoryConversationRepository } from "../data/InMemoryConversationRepository";
import { RecordingTelemetryService } from "../kit/telemetry/RecordingTelemetryService";
import { Conversation } from "../kit/models/Conversation";
import { ChatMessage } from "../kit/models/ChatMessage";
import { ChatRole } from "../kit/models/ChatRole";
import { CapacityState } from "../kit/chat/TokenUsage";

/**
 * `ChatEngine` is the file this port most needs to be faithful, because almost every mechanism in
 * it encodes a bug that was actually hit on iOS: the turn cancellation discipline, the empty
 * placeholder cleanup, the compaction generation counter, the three-state capacity model.
 *
 * These tests exist to make those mechanisms load-bearing. Deleting any of them should turn one
 * of these red — that is the bar, and each test says which mechanism it pins.
 */

// MARK: - Fakes

/** A gate a test can open, so a stream can be suspended mid-flight and cancelled deterministically. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

class FakeSession implements ModelSession {
  usage = 20;
  window = 4096;
  destroyed = false;

  /** Deltas, as Chrome emits them. */
  chunks: string[] = ["Hel", "lo", " there"];
  /** Awaited before the chunk at [pauseAt], so a test can cancel at a chosen point. */
  pause: Promise<void> | null = null;
  pauseAt: number | null = null;
  /** Tokens the session grows by per chunk. Raised in the telemetry tests so that marginal and
   *  cumulative accounting produce visibly different numbers. */
  usageDelta = 1;
  streamError: unknown = null;
  generateResult = "a summary";
  generateError: unknown = null;

  seeded: SessionConfig | undefined;

  constructor(config?: SessionConfig) {
    this.seeded = config;
  }

  async *stream(_prompt: string, options?: TurnOptions): AsyncIterable<string> {
    if (this.streamError) throw this.streamError;
    let index = 0;
    for (const chunk of this.chunks) {
      if (this.pause && this.pauseAt === index) await this.pause;
      if (options?.signal?.aborted) {
        const abort = new Error("aborted");
        abort.name = "AbortError";
        throw abort;
      }
      this.usage += this.usageDelta;
      index += 1;
      yield chunk;
    }
  }

  async generate(_prompt: string, _options?: TurnOptions): Promise<string> {
    if (this.generateError) throw this.generateError;
    return this.generateResult;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

class FakeModel implements OnDeviceModel {
  supported = true;
  availabilityState: ModelAvailability = "available";
  sessions: FakeSession[] = [];
  measureResult = 5;
  /** Applied to every session this model hands out, so a test can arrange before `configure`. */
  configure: (session: FakeSession) => void = () => {};

  isSupported(): boolean {
    return this.supported;
  }

  async availability(): Promise<ModelAvailability> {
    return this.availabilityState;
  }

  async contextWindow(): Promise<number> {
    return 4096;
  }

  async measureUsage(_text: string): Promise<number> {
    return this.measureResult;
  }

  async createSession(config?: SessionConfig): Promise<ModelSession> {
    // The real `PromptApiModel.createSession` fails while the model is downloading or absent.
    // Without this the null-session state is unreachable in tests, and the bug it caused —
    // a session never rebuilt after availability clears — cannot be pinned.
    if (this.availabilityState !== "available") {
      throw new ModelError("NOT_AVAILABLE", "fake.notAvailable");
    }
    const session = new FakeSession(config);
    this.configure(session);
    this.sessions.push(session);
    return session;
  }

  async baseModelName(): Promise<string> {
    return "fake";
  }

  /** The session backing the live chat — the first one built, ignoring throwaway summarisers. */
  get chatSession(): FakeSession {
    const first = this.sessions[0];
    if (!first) throw new Error("no session created");
    return first;
  }
}

// MARK: - Harness

const RESERVE = 1024;

let model: FakeModel;
let repository: InMemoryConversationRepository;
let telemetry: RecordingTelemetryService;
let engine: ChatEngine;

async function makeEngine(): Promise<Conversation> {
  model = new FakeModel();
  repository = new InMemoryConversationRepository();
  telemetry = new RecordingTelemetryService(false);
  engine = new ChatEngine({
    model,
    repository,
    telemetry,
    capacity: { responseTokenReserve: RESERVE },
  });
  const conversation = await repository.createConversation();
  await engine.configure(conversation);
  return conversation;
}

/** The assistant placeholder's current text, or "" before it exists. */
function assistantText(target: ChatEngine): string {
  const messages = target.getSnapshot().conversation?.messages ?? [];
  const assistant = messages.filter((m) => m.role === ChatRole.assistant).at(-1);
  return assistant?.text ?? "";
}

/** Lets queued microtasks and awaited repository writes settle. */
async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Runs until `predicate` holds or the budget is exhausted, so tests never sleep on a timer. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

beforeEach(async () => {
  await makeEngine();
});

// MARK: - Streaming

describe("streaming", () => {
  it("CONCATENATES deltas rather than assigning the last chunk", async () => {
    // The headline test of the whole port. Chrome yields deltas; Apple yields cumulative
    // snapshots. Swift's `assistant.text = snapshot` is correct on iOS and would render " there"
    // here — a silent truncation with no error anywhere.
    engine.submit("hi");
    await engine.idle();

    const messages = engine.getSnapshot().conversation!.messages;
    expect(messages.at(-1)?.text).toBe("Hello there");
    expect(messages.at(-1)?.isError).toBe(false);
  });

  it("persists the reply so it survives a reload", async () => {
    const conversation = engine.getSnapshot().conversation!;
    engine.submit("hi");
    await engine.idle();
    await settle();

    const reloaded = await repository.getConversation(conversation.id);
    expect(reloaded?.messages.at(-1)?.text).toBe("Hello there");
  });

  it("derives the conversation title from the first user message only", async () => {
    engine.submit("What are tides?");
    await engine.idle();
    const titleAfterFirst = engine.getSnapshot().conversation!.title;

    engine.submit("And spring tides?");
    await engine.idle();

    expect(titleAfterFirst).toBe("What are tides?");
    expect(engine.getSnapshot().conversation!.title).toBe(titleAfterFirst);
  });
});

// MARK: - Cancellation

describe("cancellation", () => {
  it("removes the empty placeholder when a turn is abandoned before any content", async () => {
    // Otherwise the blank assistant bubble persists forever — the exact bug the Swift `defer`
    // guards. Pause before the FIRST chunk lands by making the stream produce nothing until told.
    const held = gate();
    model.chatSession.chunks = ["only"];
    model.chatSession.pause = held.wait;
    model.chatSession.pauseAt = 0;

    engine.submit("hi");
    await until(() => engine.getSnapshot().isResponding, "turn to start");
    engine.cancelActiveTurn();
    held.open();
    await engine.idle();
    await settle();

    const messages = engine.getSnapshot().conversation!.messages;
    expect(messages.filter((m) => m.role === ChatRole.assistant)).toHaveLength(0);
    const reloaded = await repository.getConversation(engine.getSnapshot().conversation!.id);
    expect(reloaded?.messages.filter((m) => m.role === ChatRole.assistant)).toHaveLength(0);
  });

  it("KEEPS partial text and does not overwrite it with an error", async () => {
    // `ChatEngine.swift:686-690`: cancellation surfaces as a thrown error, and painting
    // "Sorry, I couldn't finish that." over a deliberately stopped reply is the failure mode.
    const held = gate();
    model.chatSession.chunks = ["Par", "tial"];
    model.chatSession.pause = held.wait;
    model.chatSession.pauseAt = 1;

    engine.submit("hi");
    await until(() => assistantText(engine) !== "", "first chunk to land");
    engine.cancelActiveTurn();
    held.open();
    await engine.idle();
    await settle();

    const assistant = engine.getSnapshot().conversation!.messages.at(-1)!;
    expect(assistant.text).toBe("Par");
    expect(assistant.isError).toBe(false);
  });

  it("does not fire a turn signal for an abandoned turn", async () => {
    const held = gate();
    model.chatSession.pause = held.wait;
    model.chatSession.pauseAt = 1;

    engine.submit("hi");
    await until(() => engine.getSnapshot().isResponding, "turn to start");
    engine.cancelActiveTurn();
    held.open();
    await engine.idle();
    await settle();

    expect(engine.getSnapshot().lastTurn).toBeNull();
  });
});

// MARK: - Capacity

describe("capacity", () => {
  it("prefers the token budget over the message-count cap", () => {
    model.chatSession.usage = 4096 - RESERVE; // exactly at the limit
    engine.refreshTokenUsage();
    expect(engine.capacityState).toBe(CapacityState.full);
  });

  it("reports the warning band while still accepting input", () => {
    model.chatSession.usage = Math.ceil((4096 - RESERVE) * 0.85);
    engine.refreshTokenUsage();
    expect(engine.capacityState).toBe(CapacityState.approaching);
    expect(engine.canSend("hello")).toBe(true);
  });

  it("treats an undeterminable window as no token budget and falls back", () => {
    // A window no larger than the reserve must not wedge an empty chat at capacity.
    model.chatSession.window = RESERVE;
    engine.refreshTokenUsage();
    expect(engine.getSnapshot().tokenUsage).toBeNull();
    expect(engine.capacityState).toBe(CapacityState.normal);
  });

  it("blocks sending and disables the composer when full", () => {
    model.chatSession.usage = 4096;
    engine.refreshTokenUsage();
    expect(engine.canSend("hello")).toBe(false);
    expect(engine.isComposerDisabled).toBe(true);
  });

  it("refuses a blank draft", () => {
    expect(engine.canSend("   ")).toBe(false);
  });
});

// MARK: - Availability

describe("availability", () => {
  it("writes the availability notice as an error message rather than calling the model", async () => {
    model.availabilityState = "unavailable";
    engine.submit("hi");
    await engine.idle();

    const assistant = engine.getSnapshot().conversation!.messages.at(-1)!;
    expect(assistant.isError).toBe(true);
    expect(assistant.text.length).toBeGreaterThan(0);
    // Swift returns from `send` before the turn-signal block on this path
    // (`ChatEngine.swift`), so no completion/error signal fires. Ported as-is.
    expect(engine.getSnapshot().lastTurn).toBeNull();
  });

  it("rebuilds the session once the model becomes available mid-conversation", async () => {
    // Regression test. The session used to be built ONLY inside `configure`, and only when
    // availability happened to be clear at that instant. Open a conversation while the model is
    // still downloading and the session stayed null forever — then once availability cleared,
    // the banner and `canSend` both said "ready" while every send failed with the generic
    // message, until the user switched threads and back. Availability refreshes never rebuilt it.
    model.availabilityState = "downloading";
    const conversation = await repository.createConversation();
    await engine.configure(conversation);
    expect(engine.getSnapshot().availabilityMessage).not.toBeNull();

    // The download finishes.
    model.availabilityState = "available";
    engine.submit("hi");
    await engine.idle();

    const assistant = engine.getSnapshot().conversation!.messages.at(-1)!;
    expect(assistant.text).toBe("Hello there");
    expect(assistant.isError).toBe(false);
  });

  it("reports an unsupported browser without throwing", async () => {
    model.supported = false;
    await engine.refreshAvailability();
    expect(engine.getSnapshot().isSupported).toBe(false);
    expect(engine.getSnapshot().availabilityMessage).not.toBeNull();
  });
});

// MARK: - Seeding

describe("session seeding", () => {
  it("excludes app-generated error notices from replayed history", () => {
    // Seeding them would teach the rehydrated session it said "Sorry, I couldn't finish that."
    const history = [
      ChatMessage.make({ role: ChatRole.user, text: "hi" }),
      ChatMessage.make({ role: ChatRole.assistant, text: "a failure notice", isError: true }),
      ChatMessage.make({ role: ChatRole.assistant, text: "real reply" }),
    ];
    const turns = ChatEngine.seededTurns(history);
    expect(turns.map((t) => t.content)).toStrictEqual(["hi", "real reply"]);
  });

  it("folds a compaction summary into the instructions as background context", () => {
    const withSummary = ChatEngine.instructionsContent("They discussed tides.");
    expect(withSummary).toContain("They discussed tides.");
    expect(withSummary).toContain("do not repeat it back to the user");

    const without = ChatEngine.instructionsContent(undefined);
    expect(without).not.toContain("compacted to save space");
  });
});

// MARK: - Compaction

describe("compaction", () => {
  async function enterWarningBand(): Promise<void> {
    model.chatSession.usage = Math.ceil((4096 - RESERVE) * 0.85);
    const conversation = engine.getSnapshot().conversation!;
    conversation.messages.push(
      ChatMessage.make({ role: ChatRole.user, text: "a turn worth summarising" }),
      ChatMessage.make({ role: ChatRole.assistant, text: "a reply worth summarising" }),
    );
    engine.refreshTokenUsage();
    await settle();
  }

  it("only compacts from the warning band", async () => {
    // `normal` has nothing worth condensing; `full` is past the point where the summariser
    // itself would fit in the window.
    engine.compact();
    await settle();
    expect(engine.getSnapshot().isCompacting).toBe(false);
    expect(
      engine.getSnapshot().conversation!.messages.some((m) => m.isCompactionSummary),
    ).toBe(false);
  });

  it("appends a marker and rebuilds the session", async () => {
    await enterWarningBand();
    const sessionsBefore = model.sessions.length;

    engine.compact();
    await engine.idle();

    const marker = engine.getSnapshot().conversation!.messages.at(-1)!;
    expect(marker.isCompactionSummary).toBe(true);
    expect(marker.text).toBe("a summary");
    // A throwaway summariser session plus a rebuilt chat session.
    expect(model.sessions.length).toBeGreaterThan(sessionsBefore + 1);
    expect(engine.getSnapshot().isCompacting).toBe(false);
  });

  it("inserts an error notice and NO marker when the summary comes back empty", async () => {
    // An empty summary would silently discard the compacted context.
    await enterWarningBand();
    model.configure = (session) => {
      session.generateResult = "   ";
    };

    engine.compact();
    await engine.idle();
    await settle();

    const messages = engine.getSnapshot().conversation!.messages;
    expect(messages.some((m) => m.isCompactionSummary)).toBe(false);
    expect(messages.at(-1)?.isError).toBe(true);
  });

  it("inserts an error notice when the summariser throws", async () => {
    await enterWarningBand();
    model.configure = (session) => {
      session.generateError = new ModelError("UNKNOWN", "test");
    };

    engine.compact();
    await engine.idle();
    await settle();

    const messages = engine.getSnapshot().conversation!.messages;
    expect(messages.some((m) => m.isCompactionSummary)).toBe(false);
    expect(messages.at(-1)?.isError).toBe(true);
  });

  it("frees the capacity budget so the chat is no longer stuck", async () => {
    await enterWarningBand();
    model.configure = (session) => {
      // The rebuilt session starts near-empty, which is the entire point of compacting.
      session.usage = 30;
    };

    engine.compact();
    await engine.idle();
    expect(engine.capacityState).toBe(CapacityState.normal);
  });
});

// MARK: - Telemetry

describe("telemetry", () => {
  it("skips the reply measurement entirely when undeliverable", async () => {
    // The guard is not decoration: `measureUsage` is a real model call.
    let measured = 0;
    model.measureResult = 5;
    const original = model.measureUsage.bind(model);
    model.measureUsage = async (text: string) => {
      measured += 1;
      return original(text);
    };

    engine.submit("hi");
    await engine.idle();
    await settle();

    expect(telemetry.records).toHaveLength(0);
    expect(measured).toBe(0);
  });

  it("reports a chat span with marginal, not cumulative, token counts", async () => {
    // The point of this test is the arithmetic, so the numbers have to be able to disagree.
    // With `usage` starting at 20 and growing 10 per chunk over 3 chunks, the first turn ends at
    // 50: marginal input is (50 - 20) - 5 = 25, cumulative would be 50 - 5 = 45. An assertion
    // like `toBeGreaterThanOrEqual(0)` cannot tell those apart — and could not tell either from
    // the `Math.max(0, ...)` clamp returning zero.
    telemetry.isDeliverable = true;
    model.chatSession.usageDelta = 10;

    engine.submit("hi");
    await engine.idle();
    await until(() => telemetry.records.length > 0, "telemetry to land");

    const first = telemetry.recordsForFeature("chat")[0]!;
    expect(first.feature).toBe("chat");
    expect(first.completion).toBe("Hello there");
    expect(first.outputTokens).toBe(5);
    expect(first.inputTokens).toBe(25);

    // A second turn is what actually pins the subtraction of the PRIOR count: it starts from a
    // non-zero baseline, so cumulative accounting would report 75 here rather than 25.
    engine.submit("and again");
    await engine.idle();
    await until(() => telemetry.recordsForFeature("chat").length > 1, "second span");

    const second = telemetry.recordsForFeature("chat")[1]!;
    expect(second.inputTokens).toBe(25);
    expect(second.outputTokens).toBe(5);
  });

  it("reports nothing for a failed turn", async () => {
    telemetry.isDeliverable = true;
    model.availabilityState = "unavailable";
    engine.submit("hi");
    await engine.idle();
    await settle();

    expect(telemetry.records).toHaveLength(0);
  });
});

// MARK: - Turn gating

describe("turn gating", () => {
  it("ignores a second submit while a turn is in flight", async () => {
    const held = gate();
    model.chatSession.pause = held.wait;
    model.chatSession.pauseAt = 1;

    engine.submit("first");
    await until(() => engine.getSnapshot().isResponding, "turn to start");
    engine.submit("second");
    held.open();
    await engine.idle();
    await settle();

    const userMessages = engine
      .getSnapshot()
      .conversation!.messages.filter((m) => m.role === ChatRole.user);
    expect(userMessages.map((m) => m.text)).toStrictEqual(["first"]);
    // The stray submit must not disturb the live turn. Without the `isResponding` guard in
    // `submit`, the second call reaches `cancelActiveTurn()` and aborts the reply that is still
    // streaming — the new turn then declines to run (the flag is still set), so the only visible
    // symptom is a silently truncated answer. Asserting the FULL reply is what pins the guard;
    // asserting the user messages alone does not.
    expect(assistantText(engine)).toBe("Hello there");
  });

  it("ignores a second submit issued in the SAME TICK as the first", async () => {
    // The previous test does not pin the `submit` guard: by the time it fires the second submit,
    // `isResponding` is already true and the guard inside `#send` catches it. The hazard Swift's
    // comment describes is narrower — two submits before the first turn's body has run far enough
    // to set the flag. Without the guard, the second cancels the first and replaces `activeTurn`,
    // leaving the real in-flight turn uncancellable. Verified by mutation: removing the guard
    // fails this test and nothing else.
    engine.submit("first");
    engine.submit("second");
    await engine.idle();
    await settle();

    const userMessages = engine
      .getSnapshot()
      .conversation!.messages.filter((m) => m.role === ChatRole.user);
    // The LAST submit wins, matching Swift: `submit` cancels the not-yet-run predecessor so the
    // handle always points at one live turn. What must never happen is BOTH running.
    expect(userMessages.map((m) => m.text)).toStrictEqual(["second"]);
    expect(engine.getSnapshot().conversation!.messages.at(-1)?.text).toBe("Hello there");
  });

  it("bumps the turn counter so the UI can distinguish consecutive turns", async () => {
    engine.submit("one");
    await until(() => engine.getSnapshot().lastTurn?.id === 1, "first signal");
    engine.submit("two");
    await until(() => engine.getSnapshot().lastTurn?.id === 2, "second signal");

    expect(engine.getSnapshot().lastTurn).toStrictEqual({ id: 2, failed: false });
  });
});
