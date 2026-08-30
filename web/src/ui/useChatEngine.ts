"use client";

import { useSyncExternalStore } from "react";

import type { ChatEngine, ChatEngineState } from "../chat/ChatEngine";

/**
 * Subscribes a component to `ChatEngine`'s state.
 *
 * The engine is deliberately framework-agnostic — it is a plain class with `subscribe` and
 * `getSnapshot`, which is what lets the whole thing be tested in Node against a fake model. This
 * hook is the entire React adapter.
 *
 * `getSnapshot` returns a stable object identity that only changes when the engine republishes,
 * so `useSyncExternalStore` can compare by reference. That is also why the engine bumps the
 * snapshot on streamed text: the message object is mutated in place (as in Swift), and React would
 * otherwise never see it.
 */
export function useChatEngineState(engine: ChatEngine): ChatEngineState {
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
}
