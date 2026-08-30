"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ChatEngine } from "../chat/ChatEngine";
import { MEASURED_CAPACITY } from "../chat/capacityConstants";
import { PromptApiModel } from "../chat/PromptApiModel";
import type { ModelAvailability } from "../chat/OnDeviceModel";
import { DexieConversationRepository } from "../data/DexieConversationRepository";
import type { ConversationRepository } from "../data/ConversationRepository";
import { Conversation } from "../kit/models/Conversation";
import { telemetryService } from "../kit/telemetry/TelemetryService";
import { ChatView } from "../features/chat/ChatView";
import { ConversationList } from "../features/conversations/ConversationList";
import { SettingsSheet } from "../features/settings/SettingsSheet";
import { Copy } from "./copy";

/**
 * The composition root: the one place that builds the real model, the real store and the engine,
 * and wires them to the UI. Everything below it takes its dependencies as props or constructor
 * arguments, which is what keeps the rest of the app testable in Node.
 *
 * Everything here is client-only. `LanguageModel` is a `window` global and Dexie needs
 * `indexedDB`, so both are constructed inside an effect rather than at module scope — Next
 * prerenders this component during `next build`, where neither exists.
 */

interface Wiring {
  repository: ConversationRepository;
  engine: ChatEngine;
  model: PromptApiModel;
}

export function OndasApp() {
  const [wiring, setWiring] = useState<Wiring | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [availability, setAvailability] = useState<ModelAvailability>("unavailable");
  const [pane, setPane] = useState<"list" | "chat">("list");
  const [showSettings, setShowSettings] = useState(false);
  const startedRef = useRef(false);

  // Build once, on the client.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const model = new PromptApiModel();
    setSupported(model.isSupported());
    if (!model.isSupported()) return;

    const repository = new DexieConversationRepository();
    const engine = new ChatEngine({
      model,
      repository,
      telemetry: telemetryService,
      capacity: MEASURED_CAPACITY,
    });
    setWiring({ repository, engine, model });

    void (async () => {
      setAvailability(await model.availability());
      const existing = await repository.listConversations();
      // DEVIATION (recorded in PORTING.md): Swift launches to the list with NOTHING selected and
      // shows the "Pick a Chat" placeholder; selection is a deliberate tap. A permanently visible
      // two-pane desktop layout makes that an empty half-screen on every launch, so the most
      // recent thread is opened instead.
      //
      // Preferring the most recent EXISTING thread over `reusableEmpty` matters: reusing an empty
      // one first would mint a fresh "New Chat" row on any launch where none happened to be empty,
      // and the row would then be the newest, so the next launch reuses it — an empty thread
      // permanently pinned to the top of the list. Creating is the last resort, for a cold store.
      const target =
        existing[0] ?? Conversation.reusableEmpty(existing) ?? (await repository.createConversation());
      const refreshed = await repository.listConversations();
      setConversations(refreshed);
      setSelectedId(target.id);
      const opened = refreshed.find((candidate) => candidate.id === target.id) ?? target;
      await engine.configure(opened);
    })();
  }, []);

  /**
   * Keeps Settings → Model → Status live.
   *
   * PORTING.md § Approved additions 2 requires this row to refresh on `visibilitychange` — the
   * web counterpart of Swift's `scenePhase == .active` refresh, which exists because availability
   * changes while the app is away (a model download finishing, most obviously). `ChatView` already
   * does this for its own banner, but the Settings row reads a separate piece of state held here,
   * so without this listener the sheet can sit showing a stale status indefinitely.
   */
  useEffect(() => {
    if (!wiring) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void wiring.model.availability().then(setAvailability);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [wiring]);

  const refreshList = useCallback(async () => {
    if (!wiring) return;
    setConversations(await wiring.repository.listConversations());
  }, [wiring]);

  // The engine mutates its conversation in place; the sidebar reads from a separate list, so it
  // needs a nudge when a turn finishes (a new title, a new preview, a new recency order).
  useEffect(() => {
    if (!wiring) return;
    return wiring.engine.subscribe(() => {
      void refreshList();
    });
  }, [wiring, refreshList]);

  const select = useCallback(
    async (id: string) => {
      if (!wiring) return;
      setSelectedId(id);
      setPane("chat");
      const conversation = await wiring.repository.getConversation(id);
      if (conversation) await wiring.engine.configure(conversation);
    },
    [wiring],
  );

  const newChat = useCallback(async () => {
    if (!wiring) return;
    const existing = await wiring.repository.listConversations();
    const target =
      Conversation.reusableEmpty(existing) ?? (await wiring.repository.createConversation());
    await refreshList();
    await select(target.id);
  }, [wiring, refreshList, select]);

  const remove = useCallback(
    async (id: string) => {
      if (!wiring) return;
      await wiring.repository.deleteConversation(id);
      const remaining = await wiring.repository.listConversations();
      setConversations(remaining);
      if (id !== selectedId) return;
      // Deleting the open thread must not leave the detail pane pointed at a deleted row.
      const next = remaining[0];
      if (next) {
        await select(next.id);
      } else {
        setSelectedId(null);
        setPane("list");
      }
    },
    [wiring, selectedId, select],
  );

  /**
   * Settings → Data → Delete all chats. Deletes each conversation through the repository rather
   * than dropping the database, so the cascade that removes each conversation's messages is the
   * same one every other delete uses — a `db.delete()` here would work today and silently stop
   * matching the moment the schema grows a third table.
   */
  const deleteAll = useCallback(async () => {
    if (!wiring) return;
    const all = await wiring.repository.listConversations();
    for (const conversation of all) {
      await wiring.repository.deleteConversation(conversation.id);
    }
    setConversations([]);
    setSelectedId(null);
    setPane("list");
    setShowSettings(false);
  }, [wiring]);

  if (supported === false) {
    return (
      <main className="ondas-unsupported">
        <h1>{Copy.unsupportedTitle}</h1>
        <p>{Copy.unsupportedBody}</p>
      </main>
    );
  }

  if (!wiring || supported === null) {
    return <main className="ondas-empty" />;
  }

  const selected = conversations.find((candidate) => candidate.id === selectedId) ?? null;

  return (
    <div className="ondas-app" data-pane={pane}>
      <aside className="ondas-sidebar">
        <ConversationList
          conversations={conversations}
          selectedId={selectedId}
          onSelect={(id) => {
            if (id !== null) void select(id);
          }}
          onNewChat={() => void newChat()}
          onDelete={(id) => void remove(id)}
          onOpenSettings={() => setShowSettings(true)}
        />
      </aside>
      <main className="ondas-detail">
        {selected ? (
          <ChatView
            engine={wiring.engine}
            onStartNewChat={() => void newChat()}
            onBack={() => setPane("list")}
          />
        ) : (
          <div className="ondas-empty">
            <h3>{Copy.pickAChatTitle}</h3>
            <p>{Copy.pickAChatBody}</p>
          </div>
        )}
      </main>
      {showSettings ? (
        <SettingsSheet
          availability={availability}
          onDeleteAll={() => void deleteAll()}
          onClose={() => setShowSettings(false)}
        />
      ) : null}
    </div>
  );
}

