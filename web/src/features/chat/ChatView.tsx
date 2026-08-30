"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { ChatEngine, ChatEngineState } from "../../chat/ChatEngine";
import { CapacityState, TokenUsage } from "../../kit/chat/TokenUsage";
import { ChatRole } from "../../kit/models/ChatRole";
import { Conversation } from "../../kit/models/Conversation";
import type { ChatMessage } from "../../kit/models/ChatMessage";
import { Copy } from "../../ui/copy";
import { useChatEngineState } from "../../ui/useChatEngine";
import { CompactionDivider } from "./CompactionDivider";
import { MessageBubble } from "./MessageBubble";

/**
 * Port of `Ondas/Features/Chat/ChatView.swift`.
 *
 * The scroll management below is the load-bearing part and the easiest thing to "simplify" into a
 * bug. Read the comments on `onScroll` before changing any of it.
 */

/** Swift's `atBottomThreshold`: within this many px of the bottom counts as at the bottom. */
const AT_BOTTOM_THRESHOLD = 40;
/** Swift's `jumpButtonThreshold`: past this, the jump-to-bottom affordance appears. */
const JUMP_BUTTON_THRESHOLD = 120;
/** Swift's meter tint flips here. The ramp only ever spans [0, 0.8) — see `capacityBanner`. */
const METER_WARNING_FRACTION = 0.6;

/**
 * Backstop for releasing the user-scroll attribution when no `scrollend` arrives.
 *
 * `scrollend` is the real signal and fires when scrolling genuinely stops, momentum included —
 * it is the web's counterpart of Swift's `.decelerating` phase. But a gesture that does not
 * actually move the transcript (a wheel tick at the very bottom, a pointer-down with no drag)
 * fires no `scrollend` at all, and a flag left stuck true is worse than one released early:
 * streamed text growing the content would then look like a user scroll and release the stream's
 * own auto-follow. Generous, because a short value is exactly the bug this replaced.
 */
const USER_SCROLL_FALLBACK_MS = 2500;

/** Blank frame between two announcements, so an identical reply still registers as a change. */
const ANNOUNCEMENT_SETTLE_MS = 50;

export function ChatView({
  engine,
  onStartNewChat,
  onBack,
}: {
  engine: ChatEngine;
  onStartNewChat: () => void;
  /**
   * Returns to the list in the single-pane layout.
   *
   * SwiftUI's `NavigationSplitView` supplies a back button for free when it collapses to a push
   * stack; the web supplies nothing. The Android port shipped a chat screen with no title bar and
   * no way back, and 143 passing tests, mutation testing and an adversarial review all missed it —
   * a single screenshot on a real device found it. Hidden by CSS above the breakpoint rather than
   * conditionally rendered, so the narrow layout can never be the untested path.
   */
  onBack: () => void;
}) {
  const state = useChatEngineState(engine);
  const [draft, setDraft] = useState("");

  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Whether the transcript follows streamed text.
   *
   * Held in a ref as well as state: the scroll handler reads it on every frame and must not
   * re-subscribe, while the render needs it for nothing — only `showJumpButton` is rendered.
   */
  const autoScroll = useRef(true);
  /**
   * Set by genuinely user-driven input only. **This guard is the entire point of the design.**
   * Streamed text growing the content also increases the distance from the bottom, and without
   * attributing the scroll to the user, the stream would hand control away from itself on the
   * first token. A raw `scroll` event cannot be used for this — a programmatic scroll fires one
   * too — so it is set from `wheel` / `pointerdown` / `touchstart` and cleared shortly after.
   */
  const isUserScrolling = useRef(false);
  /**
   * A threshold-crossed boolean, deliberately NOT the live distance.
   *
   * Swift's comment records that storing continuous scroll geometry in view state created a
   * layout → geometry-callback → layout loop that pegged Mac Catalyst at 100% CPU. The web has
   * the same hazard in a different costume: a scroll handler calling `setState` every frame.
   * Only a threshold *crossing* is written.
   */
  const [showJumpButton, setShowJumpButton] = useState(false);

  const conversation = state.conversation;
  // Sorted once per render and threaded down, as Swift does — `orderedMessages` re-sorts on every
  // access and this re-renders on every streamed token.
  const messages = conversation ? Conversation.orderedMessages(conversation) : [];
  const latest = messages.at(-1);
  const messageCount = messages.length;
  const latestText = latest?.text ?? "";

  const scrollToBottom = useCallback((smooth: boolean) => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  const userScrollFallback = useRef<ReturnType<typeof setTimeout> | null>(null);

  const endUserScroll = useCallback(() => {
    isUserScrolling.current = false;
    if (userScrollFallback.current !== null) {
      clearTimeout(userScrollFallback.current);
      userScrollFallback.current = null;
    }
  }, []);

  /**
   * Marks the scrolling that follows as the user's.
   *
   * Released by `scrollend`, NOT by a fixed timer. The first version used a flat 150ms window,
   * which loses any flick or trackpad fling whose momentum outlasts it: the flag flips back to
   * false while the browser is still animating the user's own scroll, the release branch in
   * `onScroll` never fires, and the next streamed token yanks the transcript back down under
   * them. Swift avoids this by tracking the real interaction lifecycle
   * (`.tracking` / `.interacting` / `.decelerating`); `scrollend` is the web equivalent.
   */
  const markUserScroll = useCallback(() => {
    isUserScrolling.current = true;
    if (userScrollFallback.current !== null) clearTimeout(userScrollFallback.current);
    userScrollFallback.current = setTimeout(endUserScroll, USER_SCROLL_FALLBACK_MS);
  }, [endUserScroll]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.addEventListener("scrollend", endUserScroll);
    return () => {
      element.removeEventListener("scrollend", endUserScroll);
      if (userScrollFallback.current !== null) clearTimeout(userScrollFallback.current);
    };
  }, [endUserScroll]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;

    if (distance <= AT_BOTTOM_THRESHOLD) {
      // Re-engage whether the user or our own auto-scroll got us here.
      autoScroll.current = true;
    } else if (isUserScrolling.current && autoScroll.current) {
      autoScroll.current = false;
    }

    const shouldShow = distance > JUMP_BUTTON_THRESHOLD;
    // Written only on a flip. See the note on `showJumpButton`.
    setShowJumpButton((current) => (current === shouldShow ? current : shouldShow));
  }, []);

  // A new message always re-engages following and scrolls, animated. Swift keys this on the
  // message COUNT only, never on token text.
  useLayoutEffect(() => {
    if (messageCount === 0) return;
    autoScroll.current = true;
    scrollToBottom(true);
  }, [messageCount, scrollToBottom]);

  // Streamed text keeps the view glued, UNANIMATED — animating per token stutters.
  useLayoutEffect(() => {
    if (autoScroll.current) scrollToBottom(false);
  }, [latestText, scrollToBottom]);

  // Availability can change while the tab is hidden (a model download finishing, say). Swift
  // refreshes on `scenePhase == .active`; this is the web equivalent.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void engine.refreshAvailability();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [engine]);

  // Leaving the conversation stops a reply streaming into an off-screen thread.
  useEffect(() => () => engine.cancelActiveTurn(), [engine]);

  // Focus follows the open conversation, and returns after a send. Swift does this on Catalyst
  // explicitly; on the web it is table stakes.
  useEffect(() => {
    composerRef.current?.focus();
  }, [conversation?.id]);

  /**
   * Announces a completed reply to assistive technology, exactly once.
   *
   * A live region on the transcript itself would be unusable: `assistant.text` is mutated on
   * every streamed delta, so a screen reader would read the answer letter by letter as it
   * arrives. Instead the finished text is published to a visually-hidden polite region when the
   * turn signal fires — one announcement per turn, after it settles.
   *
   * No Swift counterpart: VoiceOver reads the SwiftUI transcript directly. This is the web's
   * substitute for that, not a port.
   */
  const [announcement, setAnnouncement] = useState("");
  const lastTurnId = state.lastTurn?.id;
  useEffect(() => {
    if (lastTurnId === undefined) return;
    const text = assistantTextOf(state.conversation);
    // Cleared, then set on the next tick. A live region only speaks when its content CHANGES, so
    // writing the same string twice is silent — ask the same question twice, get the same answer
    // back, and a screen reader would announce it once. The blank frame is what makes the second
    // one land.
    setAnnouncement("");
    const timer = setTimeout(() => setAnnouncement(text), ANNOUNCEMENT_SETTLE_MS);
    return () => clearTimeout(timer);
    // `state.conversation` is deliberately not a dependency: it changes identity on every streamed
    // delta, and re-running this per token is the chattiness being avoided. `lastTurn` is reset by
    // `ChatEngine.configure`, so a conversation switch cannot re-fire this with a stale turn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastTurnId]);

  const canSend = engine.canSend(draft);

  const send = () => {
    if (!canSend) return;
    const outgoing = draft;
    // Cleared BEFORE the engine call, so the field empties in the same frame the message is
    // submitted and a slow engine cannot see the value change under it.
    setDraft("");
    engine.submit(outgoing);
    composerRef.current?.focus();
  };

  if (!conversation) return null;

  return (
    <section className="ondas-chat" aria-label={conversation.title}>
      <header className="ondas-chat-header">
        <button type="button" className="ondas-back" aria-label={Copy.backToChats} onClick={onBack}>
          ‹
        </button>
        <h2 className="ondas-chat-title">{conversation.title}</h2>
      </header>

      <div className="ondas-transcript-wrap">
        <div
          className="ondas-transcript"
          ref={scrollRef}
          onScroll={onScroll}
          onWheel={markUserScroll}
          onPointerDown={markUserScroll}
          onTouchStart={markUserScroll}
        >
          {messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              isAwaitingResponse={
                state.isResponding && message.id === latest?.id && message.text === ""
              }
              isStreaming={
                state.isResponding &&
                message.role === ChatRole.assistant &&
                message.text !== "" &&
                message.id === latest?.id
              }
            />
          ))}
        </div>

        <button
          type="button"
          className="ondas-jump"
          aria-label={Copy.scrollToLatest}
          hidden={!showJumpButton}
          onClick={() => {
            autoScroll.current = true;
            scrollToBottom(true);
          }}
        >
          ↓
        </button>
      </div>

      <p className="ondas-visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>

      <Banner engine={engine} onStartNewChat={onStartNewChat} />

      <form
        className="ondas-composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          ref={composerRef}
          className="ondas-field"
          value={draft}
          rows={1}
          placeholder={Copy.composerPlaceholder}
          // A placeholder is not an accessible name: it vanishes on focus and several screen
          // readers do not expose it. SwiftUI's `TextField("Message", …)` supplies both at once.
          aria-label={Copy.composerPlaceholder}
          disabled={engine.isComposerDisabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift/Cmd/Ctrl+Enter inserts a newline. This is the Mac Catalyst
            // branch of the Swift source, not the iOS one — on a keyboard-first platform a
            // multiline field that cannot make a newline is the wrong trade.
            if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        <button
          type={state.isResponding ? "button" : "submit"}
          className="ondas-send"
          // The stop control is NEVER disabled — the escape hatch for a runaway generation has to
          // stay reachable. Swift: `.disabled(engine.isResponding ? false : !canSend)`.
          disabled={state.isResponding ? false : !canSend}
          aria-label={state.isResponding ? Copy.stopGenerating : Copy.sendMessage}
          onClick={state.isResponding ? () => engine.cancelActiveTurn() : undefined}
        >
          {state.isResponding ? "■" : "↑"}
        </button>
      </form>
    </section>
  );
}

/** The most recent assistant message's text, for the announcement region. */
function assistantTextOf(conversation: ChatEngineState["conversation"]): string {
  const messages = conversation?.messages ?? [];
  return messages.filter((m) => m.role === ChatRole.assistant).at(-1)?.text ?? "";
}

function MessageRow({
  message,
  isAwaitingResponse,
  isStreaming,
}: {
  message: ChatMessage;
  isAwaitingResponse: boolean;
  isStreaming: boolean;
}) {
  if (message.isCompactionSummary) return <CompactionDivider />;
  return (
    <MessageBubble
      message={message}
      isAwaitingResponse={isAwaitingResponse}
      isStreaming={isStreaming}
    />
  );
}

/**
 * Exactly ONE of these renders, in this order: full → unavailable → approaching → meter.
 *
 * The precedence is ordered, not additive, and the order matters: the full banner wins even when
 * the model is also unavailable, because its New Chat action is the only way out of a full chat
 * and it must work when nothing else does.
 */
function Banner({
  engine,
  onStartNewChat,
}: {
  engine: ChatEngine;
  onStartNewChat: () => void;
}) {
  const state = useChatEngineState(engine);
  const capacity = engine.capacityState;

  if (capacity === CapacityState.full) {
    return (
      <div className="ondas-banner">
        <span>{Copy.chatIsFull}</span>
        <button type="button" className="ondas-banner-action" onClick={onStartNewChat}>
          {Copy.newChat}
        </button>
      </div>
    );
  }

  if (state.availabilityMessage !== null) {
    return (
      <div className="ondas-banner" role="status">
        <span>{state.availabilityMessage}</span>
      </div>
    );
  }

  if (capacity === CapacityState.approaching) {
    return (
      <div className="ondas-banner">
        <span>{state.isCompacting ? Copy.compactingConversation : Copy.chatGettingLong}</span>
        <button
          type="button"
          className="ondas-banner-action"
          disabled={state.isResponding || state.isCompacting}
          onClick={() => engine.compact()}
        >
          {Copy.compactAction}
        </button>
      </div>
    );
  }

  if (state.tokenUsage) {
    const fraction = TokenUsage.fraction(state.tokenUsage);
    return (
      <div className="ondas-meter">
        <div className="ondas-meter-head">
          <span>{Copy.contextLabel}</span>
          <span className="ondas-meter-count">
            {state.tokenUsage.used.toLocaleString()} / {state.tokenUsage.limit.toLocaleString()}{" "}
            {Copy.tokensSuffix}
          </span>
        </div>
        <div
          className="ondas-meter-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={state.tokenUsage.limit}
          aria-valuenow={state.tokenUsage.used}
          aria-label={Copy.contextLabel}
        >
          <div
            className="ondas-meter-fill"
            style={{
              width: `${fraction * 100}%`,
              // Swift: `.accentColor` below 0.6, `.orange` above. The ramp only ever spans
              // [0, 0.8) because at 0.8 the warning banner replaces this meter entirely.
              background:
                fraction < METER_WARNING_FRACTION
                  ? "var(--ondas-accent)"
                  : "var(--ondas-meter-warning)",
            }}
          />
        </div>
      </div>
    );
  }

  return null;
}
