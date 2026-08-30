import "fake-indexeddb/auto";

import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";

import { ChatMessage } from "../kit/models/ChatMessage";
import { ChatRole } from "../kit/models/ChatRole";
import { describeConversationRepository } from "./ConversationRepositoryContract";
import { DexieConversationRepository } from "./DexieConversationRepository";
import { OndasDatabase } from "./OndasDatabase";

/*
 * `fake-indexeddb/auto` installs `indexedDB` and `IDBKeyRange` as globals, which is all Dexie needs
 * to run under vitest's `node` environment. No jsdom, and no change to `vitest.config.mts`: the
 * config's `node` default is deliberate (a stray `document` in `src/kit` must fail, not pass under
 * an ambient DOM), and a per-file environment pragma here would only pull in a DOM this file has
 * no use for.
 *
 * The shared behavioural suite lives in `ConversationRepositoryContract` and runs against the
 * in-memory implementation too. Only Dexie-specific facts belong in this file.
 */

/** A fresh database per test. Dexie caches open connections by name, so reuse would leak state. */
function openHarness() {
  const name = `ondas-test-${crypto.randomUUID()}`;
  const db = new OndasDatabase(name);
  return Promise.resolve({
    repository: new DexieConversationRepository(db),
    db,
    async allMessageIds(): Promise<string[]> {
      return db.messages.toCollection().primaryKeys();
    },
    async dispose(): Promise<void> {
      db.close();
      await Dexie.delete(name);
    },
  });
}

describeConversationRepository("DexieConversationRepository", openHarness);

describe("OndasDatabase schema", () => {
  let open: Awaited<ReturnType<typeof openHarness>> | undefined;

  afterEach(async () => {
    await open?.dispose();
    open = undefined;
  });

  /**
   * The indexes are the reason `listConversations` and `getConversation` are index scans rather
   * than "read everything, sort in JS". Losing one would not fail any behavioural test — the rows
   * would still come back in the right order, just by a different and much worse route — so the
   * schema is asserted directly.
   */
  it("indexes what the repository's reads depend on", async () => {
    open = await openHarness();
    const { db } = open;
    await db.open();

    expect(db.conversations.schema.primKey.keyPath).toBe("id");
    expect(db.conversations.schema.indexes.map((index) => index.name)).toContain("updatedAt");

    expect(db.messages.schema.primKey.keyPath).toBe("id");
    const messageIndexes = db.messages.schema.indexes.map((index) => index.name);
    expect(messageIndexes).toContain("conversationId");
    expect(messageIndexes).toContain("[conversationId+createdAt]");
  });

  /**
   * `Date` is assumed nowhere. IndexedDB round-trips it through the structured clone algorithm and
   * accepts it as a key, which is what lets `[conversationId+createdAt]` sort on it directly — but
   * that was verified here rather than taken on trust. Had it not held, the fallback was storing
   * epoch milliseconds and converting in `OndasDatabase`'s mappers.
   */
  it("stores Date as a Date, not a string or a number", async () => {
    open = await openHarness();
    const { db, repository } = open;
    const conversation = await repository.createConversation();
    const message = ChatMessage.make({
      role: ChatRole.user,
      text: "hi",
      createdAt: new Date(1_700_000_000_123),
    });
    await repository.insertMessage(conversation.id, message);

    const conversationRow = await db.conversations.get(conversation.id);
    const messageRow = await db.messages.get(message.id);
    expect(conversationRow?.createdAt).toBeInstanceOf(Date);
    expect(conversationRow?.updatedAt).toBeInstanceOf(Date);
    expect(messageRow?.createdAt).toBeInstanceOf(Date);
    expect(messageRow?.createdAt.getTime()).toBe(1_700_000_000_123);
  });

  /**
   * Two tables, not one row carrying an embedded array. If messages ever moved back onto the
   * conversation row, every message write would rewrite the whole transcript — a cost invisible in
   * a two-message test and real in a forty-message chat.
   */
  it("keeps messages out of the conversation row, and carries the foreign key on the message", async () => {
    open = await openHarness();
    const { db, repository } = open;
    const conversation = await repository.createConversation();
    const message = ChatMessage.make({ role: ChatRole.assistant, text: "hi" });
    await repository.insertMessage(conversation.id, message);

    const conversationRow = await db.conversations.get(conversation.id);
    expect(Object.keys(conversationRow ?? {}).sort()).toEqual([
      "createdAt",
      "id",
      "title",
      "updatedAt",
    ]);

    const messageRow = await db.messages.get(message.id);
    expect(messageRow?.conversationId).toBe(conversation.id);
    // The raw role value matches Swift's `roleRaw`, so a row written by either port reads the same.
    expect(messageRow?.role).toBe("assistant");
  });

  /**
   * `conversationId` never reaches `src/kit`. The mappers in `OndasDatabase` are the only place it
   * exists, so a domain `ChatMessage` must come back without it.
   */
  it("does not leak the foreign key into the domain model", async () => {
    open = await openHarness();
    const { repository } = open;
    const conversation = await repository.createConversation();
    await repository.insertMessage(
      conversation.id,
      ChatMessage.make({ role: ChatRole.user, text: "hi" }),
    );

    const stored = await repository.getConversation(conversation.id);
    expect(stored?.messages[0]).toBeDefined();
    expect(Object.keys(stored!.messages[0]!).sort()).toEqual([
      "createdAt",
      "id",
      "isCompactionSummary",
      "isError",
      "role",
      "text",
    ]);
  });

  /**
   * An unrecognised stored role degrades to `user` rather than throwing — Swift's
   * `ChatRole(rawValue: roleRaw) ?? .user` (`ChatMessage.swift:54`). Written straight to the table
   * because the repository cannot produce one; the case exists for a row from an older build or a
   * hand-edited store, and a message whose role we cannot parse is still a message worth showing.
   */
  it("degrades an unrecognised stored role to user", async () => {
    open = await openHarness();
    const { db, repository } = open;
    const conversation = await repository.createConversation();
    await db.messages.put({
      id: "corrupt",
      conversationId: conversation.id,
      role: "system",
      text: "from somewhere else",
      createdAt: new Date(1_000),
      isError: false,
      isCompactionSummary: false,
    });

    const stored = await repository.getConversation(conversation.id);
    expect(stored?.messages[0]?.role).toBe(ChatRole.user);
  });
});
