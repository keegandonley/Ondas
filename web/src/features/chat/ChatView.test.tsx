// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { ChatEngine } from "../../chat/ChatEngine";
import { ModelError, availabilityMessage } from "../../chat/OnDeviceModel";
import type {
  ModelAvailability,
  ModelSession,
  OnDeviceModel,
  SessionConfig,
  TurnOptions,
} from "../../chat/OnDeviceModel";
import { InMemoryConversationRepository } from "../../data/InMemoryConversationRepository";
import { RecordingTelemetryService } from "../../kit/telemetry/RecordingTelemetryService";
import { ChatRole } from "../../kit/models/ChatRole";
import { Copy } from "../../ui/copy";
import { ChatView } from "./ChatView";

/**
 * `Ondas/Features/Chat/ChatView.swift`, exercised through the DOM.
 *
 * The scroll block is what this file mostly exists for. Its rules are not cosmetic — each one
 * records a bug:
 *
 *  1. Only a *user-attributed* scroll releases auto-follow (`ChatView.swift:150-158`). Streamed
 *     text growing the content also increases the distance from the bottom, so a bare `scroll`
 *     event is not evidence of anything: without the attribution guard the stream hands control
 *     away from itself on its first token.
 *  2. The attribution is released by `scrollend`, not by a fixed timer. The web port's first
 *     version used a flat 150ms window, which lost every flick whose momentum outlasted it —
 *     PORTING.md § Verified end to end records the defect. A test that only ever fires a short
 *     gesture cannot tell the two implementations apart, so the timing test below deliberately
 *     lets a gesture run well past any plausible flat window.
 *  3. Only a threshold *crossing* is written to state. Swift's comment records that storing
 *     continuous scroll geometry pegged Mac Catalyst at 100% CPU in a
 *     layout → geometry-callback → layout loop.
 *
 * jsdom performs no layout, so `scrollHeight` / `clientHeight` / `scrollTop` are all 0 and every
 * distance would be 0. They are stubbed per element so `distance` can be driven directly, and
 * `scrollTo` is stubbed so "did the transcript follow?" is observable at all — `autoScroll` lives
 * in a ref precisely so it never reaches the DOM.
 *
 * The model fakes are the ones from `src/chat/ChatEngine.test.ts`, in the same shape, so the two
 * suites drive the engine identically. Every asserted string comes from `Copy`.
 *
 * ## One mutation this file does NOT kill, recorded rather than hidden
 *
 * Rewriting `setShowJumpButton((current) => (current === shouldShow ? current : shouldShow))` as
 * the unguarded `setShowJumpButton(shouldShow)` leaves every test below green, and no test here
 * can catch it: React's eager-state bailout makes the two forms observationally identical from the
 * DOM, so there is no rendered difference to assert on. That guard is a transcription of Swift's,
 * where it IS load-bearing — SwiftUI has no bailout, and writing on every geometry callback is
 * what pegged Mac Catalyst at 100% CPU. The half of it that IS observable — that only a threshold
 * *crossing* changes what is rendered — is pinned by the 120px tests below. The web's real
 * counterpart hazard would be storing the live distance in state rather than a boolean, which is a
 * rewrite rather than a mutation.
 */

// MARK: - Fakes (see `ChatEngine.test.ts`)

/** A gate a test can open, so a stream can be suspended mid-flight at a chosen delta. */
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
  chunks: string[] = ["Hel", "lo"];
  /** Awaited before the chunk at [pauseAt], so a test can suspend the stream at a chosen point. */
  pause: Promise<void> | null = null;
  pauseAt: number | null = null;
  usageDelta = 1;

  seeded: SessionConfig | undefined;

  constructor(config?: SessionConfig) {
    this.seeded = config;
  }

  async *stream(_prompt: string, options?: TurnOptions): AsyncIterable<string> {
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
    return "a summary";
  }

  destroy(): void {
    this.destroyed = true;
  }
}

class FakeModel implements OnDeviceModel {
  supported = true;
  availabilityState: ModelAvailability = "available";
  sessions: FakeSession[] = [];

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
    return 5;
  }

  async createSession(config?: SessionConfig): Promise<ModelSession> {
    if (this.availabilityState !== "available") {
      throw new ModelError("NOT_AVAILABLE", "fake.notAvailable");
    }
    const session = new FakeSession(config);
    this.sessions.push(session);
    return session;
  }

  async baseModelName(): Promise<string> {
    return "fake";
  }

  /** The session backing the live chat — the first one built. */
  get chatSession(): FakeSession {
    const first = this.sessions[0];
    if (!first) throw new Error("no session created");
    return first;
  }
}

// MARK: - Harness

const RESERVE = 1024;
/** `FakeSession.window` minus the reserve — the meter's denominator. */
const LIMIT = 4096 - RESERVE;

/** Stubbed transcript geometry. Only the distance from the bottom is ever varied. */
const SCROLL_HEIGHT = 2000;
const CLIENT_HEIGHT = 500;

let model: FakeModel;
let engine: ChatEngine;
let onStartNewChat: Mock<() => void>;
let onBack: Mock<() => void>;
let scrollTo: Mock<(options: ScrollToOptions) => void>;
let scrollTop = 0;
let openGate: (() => void) | null = null;

beforeEach(() => {
  scrollTop = SCROLL_HEIGHT - CLIENT_HEIGHT; // distance 0: pinned to the bottom
  openGate = null;
  scrollTo = vi.fn<(options: ScrollToOptions) => void>();
  // `scrollToBottom` is the only externally visible consequence of `autoScroll`, which is a ref.
  // jsdom implements no scrolling at all, so this is a stub rather than a spy.
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value: scrollTo,
  });
});

afterEach(() => {
  // Release any stream still suspended on a gate before the view unmounts, so nothing is left
  // pending on a promise no test will ever resolve.
  openGate?.();
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

/** Drains the microtask queue inside `act`. Nothing in the engine or the repository uses a timer. */
async function settleUntil(predicate: () => boolean, label: string): Promise<void> {
  await act(async () => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (predicate()) return;
      await Promise.resolve();
    }
    throw new Error(`timed out waiting for: ${label}`);
  });
}

async function mountChat(): Promise<void> {
  model = new FakeModel();
  const repository = new InMemoryConversationRepository();
  engine = new ChatEngine({
    model,
    repository,
    telemetry: new RecordingTelemetryService(false),
    capacity: { responseTokenReserve: RESERVE },
  });
  const conversation = await repository.createConversation();
  await engine.configure(conversation);

  onStartNewChat = vi.fn<() => void>();
  onBack = vi.fn<() => void>();
  render(<ChatView engine={engine} onStartNewChat={onStartNewChat} onBack={onBack} />);
  stubGeometry(transcript());
  scrollTo.mockClear();
}

/** The scroll container. It carries no role of its own — it is a plain scrolling div in Swift too. */
function transcript(): HTMLDivElement {
  const element = document.querySelector<HTMLDivElement>(".ondas-transcript");
  if (!element) throw new Error("transcript not rendered");
  return element;
}

function stubGeometry(element: HTMLElement): void {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => SCROLL_HEIGHT,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => CLIENT_HEIGHT,
  });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
}

/** Moves the transcript to `distance` px from the bottom and fires the resulting `scroll`. */
function scrollToDistance(distance: number): void {
  scrollTop = SCROLL_HEIGHT - CLIENT_HEIGHT - distance;
  fireEvent.scroll(transcript());
}

function assistantText(): string {
  const messages = engine.getSnapshot().conversation?.messages ?? [];
  return messages.filter((message) => message.role === ChatRole.assistant).at(-1)?.text ?? "";
}

/**
 * Sends a turn and suspends the stream between its first and second delta.
 *
 * The suspension is the whole point: `messageCount` has already changed (the user message plus the
 * assistant placeholder), so the count-driven effect has run and re-engaged auto-follow. Anything
 * a test does from here is measured against *text* growth alone, which is the case the attribution
 * guard exists for.
 */
async function sendAndSuspendMidStream(chunks = ["Hel", "lo"]): Promise<void> {
  const held = gate();
  openGate = held.open;
  model.chatSession.chunks = chunks;
  model.chatSession.pause = held.wait;
  model.chatSession.pauseAt = 1;
  await act(async () => {
    engine.submit("hi");
  });
  await settleUntil(() => assistantText() === chunks[0], "the first delta to land");
}

/** Releases the suspended stream and waits for the turn — deltas and teardown — to settle. */
async function deliverRemainingDeltas(): Promise<void> {
  openGate?.();
  openGate = null;
  await settleUntil(() => !engine.getSnapshot().isResponding, "the turn to settle");
}

/**
 * Releases exactly ONE suspended delta, re-arming the pause at the next chunk.
 *
 * Needed because the only observable consequence of `autoScroll` is a `scrollTo` call driven by
 * *text growth*. A test that scrolls away and then immediately finishes the turn cannot tell a
 * released auto-follow from an engaged one — both end up back at the bottom for different
 * reasons. Delivering a single delta while still mid-turn is what makes the released state
 * visible, and it is what turns these tests from decorative into discriminating.
 *
 * Re-arming works because `FakeSession.stream` re-reads `pause`/`pauseAt` on every iteration.
 */
async function deliverOneDelta(): Promise<void> {
  const next = gate();
  const releaseCurrent = openGate;
  model.chatSession.pauseAt = (model.chatSession.pauseAt ?? 0) + 1;
  model.chatSession.pause = next.wait;
  openGate = next.open;
  const before = assistantText();
  releaseCurrent?.();
  await settleUntil(() => assistantText() !== before, "the next delta to land");
}

/**
 * Like [settleUntil] but lets real time pass, for behaviour behind a `setTimeout`.
 *
 * `settleUntil` only drains microtasks, so it can never advance the announcement region's
 * clear-then-set timer.
 */
async function settleOverTime(predicate: () => boolean, label: string): Promise<void> {
  // The predicate is checked BETWEEN `act` calls, never inside one. React defers flushing until
  // `act` returns, so a loop that polls the DOM from within a single `act` never observes the
  // update it is waiting for and always times out.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/**
 * The screen-reader announcement region.
 *
 * Queried by class rather than by `role="status"` on purpose: the thinking indicator inside
 * `MessageBubble` also carries `role="status"`, so a role query is ambiguous mid-turn.
 */
function announcement(): string {
  return document.querySelector(".ondas-visually-hidden")?.textContent ?? "";
}

function jumpButton(): HTMLButtonElement {
  return screen.getByLabelText(Copy.scrollToLatest) as HTMLButtonElement;
}

function composer(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: Copy.composerPlaceholder }) as HTMLTextAreaElement;
}

function type(text: string): void {
  fireEvent.change(composer(), { target: { value: text } });
}

/** Puts the conversation at a chosen point on the token budget and republishes. */
function setTokenUsage(used: number): void {
  act(() => {
    model.chatSession.usage = used;
    engine.refreshTokenUsage();
  });
}

async function setUnavailable(): Promise<void> {
  model.availabilityState = "unavailable";
  await act(async () => {
    await engine.refreshAvailability();
  });
}

// MARK: - Scroll following

describe("scroll following", () => {
  it("does NOT release auto-follow when the distance grows without a user gesture", async () => {
    // The load-bearing case. Streamed text lengthens the content, which lengthens the distance
    // from the bottom and fires a `scroll` — indistinguishable, on its own, from the user pushing
    // the transcript up. Treating it as a user scroll is the exact bug the design prevents: the
    // stream would hand control away from itself on its first token.
    await mountChat();
    await sendAndSuspendMidStream();
    scrollTo.mockClear();

    scrollToDistance(400);
    await deliverRemainingDeltas();

    // UNANIMATED: animating per token stutters, so streamed follow-up is `behavior: "auto"`.
    expect(scrollTo).toHaveBeenCalledWith({ top: SCROLL_HEIGHT, behavior: "auto" });
  });

  it.each([
    ["wheel", (element: HTMLElement) => fireEvent.wheel(element)],
    ["pointerdown", (element: HTMLElement) => fireEvent.pointerDown(element)],
    ["touchstart", (element: HTMLElement) => fireEvent.touchStart(element)],
  ])("releases auto-follow when %s attributes the scroll to the user", async (_name, gesture) => {
    await mountChat();
    await sendAndSuspendMidStream();
    scrollTo.mockClear();

    gesture(transcript());
    scrollToDistance(400);
    await deliverRemainingDeltas();

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("keeps the transcript put for every later delta, not just the first", async () => {
    // The release is a state change, not a one-shot suppression: a stream that resumed following
    // itself on the next token would be just as broken, and only shows up past the first delta.
    const chunks = ["Hel", "lo", " there"];
    await mountChat();
    await sendAndSuspendMidStream(chunks);
    scrollTo.mockClear();

    fireEvent.wheel(transcript());
    scrollToDistance(400);
    await deliverRemainingDeltas();

    expect(assistantText()).toBe("Hello there");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("re-engages auto-follow within 40px of the bottom, whoever caused the scroll", async () => {
    // "Whoever caused it" is the point: the return scroll here carries NO user gesture, because
    // the auto-scroll's own arrival at the bottom has to re-engage following too.
    //
    // The intermediate assertion is what makes this test discriminate. Without it, the sequence
    // ends at the bottom whether or not the user-attribution guard ever released auto-follow, so
    // the final expectation passes either way — it would still be green with the guard deleted.
    await mountChat();
    await sendAndSuspendMidStream(["Hel", "lo", " there"]);
    scrollTo.mockClear();

    fireEvent.wheel(transcript());
    scrollToDistance(400);
    fireEvent(transcript(), new Event("scrollend"));

    // Released: streamed text must NOT drag the view back down.
    await deliverOneDelta();
    expect(scrollTo).not.toHaveBeenCalled();

    scrollToDistance(39);
    await deliverRemainingDeltas();

    expect(scrollTo).toHaveBeenCalledWith({ top: SCROLL_HEIGHT, behavior: "auto" });
  });

  it("stays released 41px from the bottom", async () => {
    await mountChat();
    await sendAndSuspendMidStream();
    scrollTo.mockClear();

    fireEvent.wheel(transcript());
    scrollToDistance(400);
    fireEvent(transcript(), new Event("scrollend"));
    scrollToDistance(41);
    await deliverRemainingDeltas();

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("re-engages auto-follow when a NEW MESSAGE arrives, even after the user broke away", async () => {
    // Swift keys this on the message count and re-engages unconditionally
    // (`ChatView.swift:170-175`): sending is itself a statement that you want to watch the reply.
    await mountChat();
    await sendAndSuspendMidStream();
    scrollTo.mockClear();

    fireEvent.wheel(transcript());
    scrollToDistance(400);
    await deliverRemainingDeltas();
    expect(scrollTo).not.toHaveBeenCalled(); // released, and still 400px from the bottom

    await sendAndSuspendMidStream(["Nex", "t"]);
    scrollTo.mockClear();
    await deliverRemainingDeltas();

    expect(scrollTo).toHaveBeenCalledWith({ top: SCROLL_HEIGHT, behavior: "auto" });
  });

  it("shows the jump-to-bottom button past 120px and hides it again inside 120px", async () => {
    await mountChat();

    expect(jumpButton().hidden).toBe(true);

    scrollToDistance(121);
    expect(jumpButton().hidden).toBe(false);

    scrollToDistance(120);
    expect(jumpButton().hidden).toBe(true);
  });

  it("re-engages auto-follow when the jump-to-bottom button is pressed", async () => {
    await mountChat();
    await sendAndSuspendMidStream();
    scrollTo.mockClear();

    fireEvent.wheel(transcript());
    scrollToDistance(400);
    fireEvent.click(jumpButton());
    // The button's own animated jump is not what is under test — the following that survives it is.
    expect(scrollTo).toHaveBeenCalledWith({ top: SCROLL_HEIGHT, behavior: "smooth" });
    scrollTo.mockClear();

    await deliverRemainingDeltas();

    expect(scrollTo).toHaveBeenCalledWith({ top: SCROLL_HEIGHT, behavior: "auto" });
  });

  it("scrolls animated when a new message arrives, and unanimated as it streams", async () => {
    // Swift keys the animated jump on the message COUNT only, never on token text
    // (`ChatView.swift:170-181`): animating each delta stutters the glue.
    await mountChat();
    await sendAndSuspendMidStream();

    // The user message and the assistant placeholder arrive together, so the count-driven effect
    // has run exactly once by now — animated.
    expect(scrollTo).toHaveBeenCalledWith({ top: SCROLL_HEIGHT, behavior: "smooth" });
    scrollTo.mockClear();

    await deliverRemainingDeltas();

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: SCROLL_HEIGHT, behavior: "auto" });
  });
});

// MARK: - Scroll attribution lifetime

describe("user-scroll attribution", () => {
  it("is still the user's a full second into a gesture, until `scrollend` arrives", async () => {
    // The regression this file exists for. The first implementation released the attribution on a
    // flat 150ms timer, so any flick or trackpad fling whose momentum outlasted it flipped the
    // flag back while the browser was still animating the USER's own scroll — the release branch
    // never fired and the next token yanked the transcript back down under them. A test that only
    // fired a short gesture would pass against both implementations, so this one runs long.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    await mountChat();
    await sendAndSuspendMidStream();
    scrollTo.mockClear();

    fireEvent.wheel(transcript());
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    scrollToDistance(400);
    await deliverRemainingDeltas();

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("ends at `scrollend`, so the next distance change is no longer the user's", async () => {
    // The contrast with "stays released 41px from the bottom" is the whole content of this test:
    // the identical move releases auto-follow while the gesture is live, and does not once
    // `scrollend` has ended it. Delivering a delta mid-turn, rather than finishing the turn,
    // keeps the assertion about text growth — which is the only thing auto-follow governs.
    await mountChat();
    await sendAndSuspendMidStream(["Hel", "lo", " there"]);
    scrollTo.mockClear();

    fireEvent.wheel(transcript());
    fireEvent(transcript(), new Event("scrollend"));
    scrollToDistance(400);

    await deliverOneDelta();
    expect(scrollTo).toHaveBeenCalledWith({ top: SCROLL_HEIGHT, behavior: "auto" });
  });

  it("falls back to a timer for a gesture that scrolls nothing and fires no `scrollend`", async () => {
    // A wheel tick at the very bottom or a pointer-down with no drag never produces a `scrollend`.
    // A flag stuck true is worse than one released early — streamed growth would then read as a
    // user scroll — so the attribution expires on its own.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    await mountChat();
    await sendAndSuspendMidStream();
    scrollTo.mockClear();

    fireEvent.wheel(transcript());
    act(() => {
      vi.advanceTimersByTime(2600);
    });
    scrollToDistance(400);
    await deliverRemainingDeltas();

    expect(scrollTo).toHaveBeenCalledWith({ top: SCROLL_HEIGHT, behavior: "auto" });
  });
});

// MARK: - Composer

describe("composer", () => {
  it("sends on Enter and clears the draft", async () => {
    await mountChat();
    const submit = vi.spyOn(engine, "submit");

    type("hello there");
    const notCancelled = fireEvent.keyDown(composer(), { key: "Enter" });

    expect(submit).toHaveBeenCalledWith("hello there");
    expect(composer().value).toBe("");
    // The keystroke must be swallowed, or the textarea takes a newline as well as sending.
    expect(notCancelled).toBe(false);
  });

  it.each([
    ["Shift", { shiftKey: true }],
    ["Cmd", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
  ])("inserts a newline rather than sending on %s+Enter", async (_name, modifier) => {
    await mountChat();
    const submit = vi.spyOn(engine, "submit");

    type("hello there");
    const notCancelled = fireEvent.keyDown(composer(), { key: "Enter", ...modifier });

    expect(submit).not.toHaveBeenCalled();
    expect(composer().value).toBe("hello there");
    // Not cancelled, so the textarea's own default — inserting the newline — still happens.
    expect(notCancelled).toBe(true);
  });

  it("gives the field an accessible name, because a placeholder is not one", async () => {
    await mountChat();
    // Queried BY that name — a placeholder alone would not satisfy this, which is the point.
    expect(composer().getAttribute("aria-label")).toBe(Copy.composerPlaceholder);
  });

  it("disables the send button for a blank draft and enables it once there is text", async () => {
    await mountChat();

    const send = () => screen.getByLabelText(Copy.sendMessage) as HTMLButtonElement;
    expect(send().disabled).toBe(true);

    type("   ");
    expect(send().disabled).toBe(true);

    type("hello");
    expect(send().disabled).toBe(false);
  });

  it("NEVER disables the stop button while responding, and stops the turn", async () => {
    // The escape hatch for a runaway generation has to stay reachable. Swift:
    // `.disabled(engine.isResponding ? false : !canSend)` — note the draft is empty by now, so
    // anything that falls through to `!canSend` disables it.
    await mountChat();
    await sendAndSuspendMidStream();
    scrollTo.mockClear();

    const stop = screen.getByLabelText(Copy.stopGenerating) as HTMLButtonElement;
    expect(composer().value).toBe("");
    expect(stop.disabled).toBe(false);
    expect(screen.queryByLabelText(Copy.sendMessage)).toBeNull();

    fireEvent.click(stop);
    await deliverRemainingDeltas();

    expect(engine.getSnapshot().isResponding).toBe(false);
    expect(assistantText()).toBe("Hel");
  });
});

// MARK: - Banner precedence

describe("banner precedence", () => {
  it("shows the full banner even when the model is ALSO unavailable", async () => {
    // Ordered, not additive. The full banner's New Chat action is the only way out of a full
    // chat, so it has to work when nothing else does.
    await mountChat();
    setTokenUsage(LIMIT);
    await setUnavailable();

    expect(screen.getByText(Copy.chatIsFull)).toBeTruthy();
    expect(screen.queryByText(availabilityMessage("unavailable")!)).toBeNull();

    // By role, not by text: the default conversation title is also "New Chat".
    fireEvent.click(screen.getByRole("button", { name: Copy.newChat }));
    expect(onStartNewChat).toHaveBeenCalledTimes(1);
  });

  it("shows the availability banner ahead of the approaching-capacity warning", async () => {
    await mountChat();
    setTokenUsage(Math.ceil(LIMIT * 0.85));
    await setUnavailable();

    expect(screen.getByText(availabilityMessage("unavailable")!)).toBeTruthy();
    expect(screen.queryByText(Copy.chatGettingLong)).toBeNull();
    expect(screen.queryByText(Copy.compactAction)).toBeNull();
  });

  it("shows the approaching-capacity warning ahead of the meter", async () => {
    await mountChat();
    setTokenUsage(Math.ceil(LIMIT * 0.85));

    expect(screen.getByText(Copy.chatGettingLong)).toBeTruthy();
    expect(screen.getByText(Copy.compactAction)).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(Copy.chatIsFull)).toBeNull();
  });

  it("falls through to the meter when nothing else applies", async () => {
    await mountChat();
    setTokenUsage(100);

    const meter = screen.getByRole("progressbar", { name: Copy.contextLabel });
    expect(meter.getAttribute("aria-valuenow")).toBe("100");
    expect(meter.getAttribute("aria-valuemax")).toBe(String(LIMIT));
    expect(screen.getByText(`${(100).toLocaleString()} / ${LIMIT.toLocaleString()} ${Copy.tokensSuffix}`)).toBeTruthy();
    expect(screen.queryByText(Copy.chatGettingLong)).toBeNull();
    expect(screen.queryByText(Copy.chatIsFull)).toBeNull();
  });

  it("tints the meter at 0.6 of the budget", async () => {
    // Swift: `.accentColor` below 0.6, `.orange` above. The ramp only ever spans [0, 0.8) because
    // the warning banner replaces the meter at 0.8.
    await mountChat();

    const fill = () => document.querySelector<HTMLElement>(".ondas-meter-fill")!;
    setTokenUsage(Math.floor(LIMIT * 0.59));
    expect(fill().style.background).toBe("var(--ondas-accent)");

    setTokenUsage(Math.ceil(LIMIT * 0.61));
    expect(fill().style.background).toBe("var(--ondas-meter-warning)");
  });
});

// MARK: - Navigation

describe("back button", () => {
  it("carries its accessible name and returns to the list", async () => {
    // The Android port shipped a chat screen with no way back and a full green suite. Hidden by
    // CSS above the breakpoint rather than conditionally rendered, so it is always in the DOM.
    await mountChat();

    const back = screen.getByRole("button", { name: Copy.backToChats });
    fireEvent.click(back);

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

// MARK: - Screen-reader announcements

/**
 * The announcement region is the one piece of this component carrying a suppressed
 * `react-hooks/exhaustive-deps`, and it had no coverage at all until these tests. The suppression
 * is only safe because `lastTurn` fires exactly once per completed turn and is reset by
 * `ChatEngine.configure`, so all three of those properties are pinned here.
 */
describe("reply announcement", () => {
  it("publishes the finished reply, not the streamed fragments", async () => {
    // A live region on the transcript itself would read the answer out letter by letter as the
    // deltas arrive. This region must only ever receive the settled text.
    await mountChat();
    await sendAndSuspendMidStream(["Hel", "lo", " there"]);
    expect(announcement()).toBe("");

    await deliverRemainingDeltas();
    await settleOverTime(() => announcement() !== "", "the announcement to land");

    expect(announcement()).toBe("Hello there");
  });

  it("clears before re-publishing, so an identical second reply is still announced", async () => {
    // A live region only speaks when its content CHANGES. Ask the same thing twice, get the same
    // answer, and writing the same string would be silent. The blank frame is the mechanism, and
    // it is the only part of "announced again" that is observable in jsdom — so it is what this
    // asserts, deliberately, rather than pretending to test the utterance.
    await mountChat();
    await sendAndSuspendMidStream(["Hel", "lo", " there"]);
    await deliverRemainingDeltas();
    await settleOverTime(() => announcement() !== "", "the first announcement");
    expect(announcement()).toBe("Hello there");

    await sendAndSuspendMidStream(["Hel", "lo", " there"]);
    await deliverRemainingDeltas();

    // The region is cleared first. Without that step it would still hold "Hello there" from the
    // previous turn, writing the same string would be a no-op, and this wait would never finish —
    // which is precisely the silent-second-reply bug.
    await settleOverTime(() => announcement() === "", "the region to clear");

    // Then re-published, so the identical text registers as a change.
    await settleOverTime(() => announcement() !== "", "the second announcement");
    expect(announcement()).toBe("Hello there");
  });

  it("never announces a turn the user abandoned", async () => {
    // A cancelled turn fires no `lastTurn`, so nothing should reach the region — a partial reply
    // being read aloud after the user stopped it would be worse than silence.
    await mountChat();
    await sendAndSuspendMidStream(["Par", "tial"]);
    act(() => {
      engine.cancelActiveTurn();
    });
    await deliverRemainingDeltas();
    // Give the announcement timer several times its delay to fire, so "still empty" means the
    // effect never ran rather than that the assertion was simply early.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    expect(announcement()).toBe("");
  });
});
