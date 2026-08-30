import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChatMessage } from "../kit/models/ChatMessage";
import { ChatRole } from "../kit/models/ChatRole";
import { Conversation } from "../kit/models/Conversation";
import type { ConversationRepository } from "./ConversationRepository";

/**
 * The behavioural contract every `ConversationRepository` must satisfy, written once and run twice.
 *
 * `DexieConversationRepository` is what ships; `InMemoryConversationRepository` is what spec W6's
 * `ChatEngine` suite runs against. If the fake is allowed to be even slightly more forgiving than
 * the real store — a cascade that leaves orphans, a read that hands back a live reference, a
 * different sort — then W6's green tests stop being evidence about the shipping app. Running one
 * suite against both is what makes that impossible to do quietly, so **new cases belong here**,
 * not in either implementation's own file.
 *
 * Not a `.test.ts` on purpose. Vitest evaluates each test file in its own module graph, so a test
 * file importing another test file would re-register that file's suites inside the importer and
 * run them twice.
 */
export interface RepositoryHarness {
  readonly repository: ConversationRepository;

  /**
   * Every message id in the store, ignoring which conversation owns it.
   *
   * The cascade test cannot be written without this. An orphaned message — one whose conversation
   * was deleted — is unreachable through `getConversation` and `listConversations` by definition,
   * so asserting through the repository's own reads would pass whether the cascade ran or not.
   */
  allMessageIds(): Promise<string[]>;

  dispose(): Promise<void>;
}

/** A message with a fixed id and timestamp, so ordering assertions are deterministic. */
function message(
  id: string,
  at: number,
  options: {
    role?: ChatRole;
    text?: string;
    isError?: boolean;
    isCompactionSummary?: boolean;
  } = {},
): ChatMessage {
  const created = ChatMessage.make({
    role: options.role ?? ChatRole.user,
    text: options.text ?? `text ${id}`,
    createdAt: new Date(at),
    isError: options.isError ?? false,
    isCompactionSummary: options.isCompactionSummary ?? false,
  });
  created.id = id;
  return created;
}

export function describeConversationRepository(
  label: string,
  openHarness: () => Promise<RepositoryHarness>,
): void {
  describe(label, () => {
    let harness: RepositoryHarness;
    let repository: ConversationRepository;

    beforeEach(async () => {
      harness = await openHarness();
      repository = harness.repository;
    });

    afterEach(async () => {
      await harness.dispose();
    });

    describe("createConversation", () => {
      it("inserts a conversation that reads back with Swift's defaults", async () => {
        const created = await repository.createConversation();

        const stored = await repository.getConversation(created.id);
        expect(stored).toBeDefined();
        expect(stored?.id).toBe(created.id);
        expect(stored?.title).toBe(Conversation.defaultTitle);
        expect(stored?.messages).toEqual([]);
        // `Conversation.make` sets both from one instant; the store must not drift them apart.
        expect(stored?.createdAt.getTime()).toBe(created.createdAt.getTime());
        expect(stored?.updatedAt.getTime()).toBe(created.createdAt.getTime());
      });
    });

    describe("getConversation", () => {
      it("returns messages in createdAt order regardless of insertion order", async () => {
        const conversation = await repository.createConversation();
        await repository.insertMessage(conversation.id, message("c", 3_000));
        await repository.insertMessage(conversation.id, message("a", 1_000));
        await repository.insertMessage(conversation.id, message("b", 2_000));

        const stored = await repository.getConversation(conversation.id);
        expect(stored?.messages.map((each) => each.id)).toEqual(["a", "b", "c"]);
      });

      /**
       * The invariant Android had to store nanoseconds to keep. `ChatEngine` inserts the assistant
       * placeholder at `userMessage.createdAt + 0.001s` precisely so the two sort deterministically
       * rather than by insertion order. A JS `Date` is millisecond-resolution, so that offset is
       * exactly one representable tick — it survives, with nothing to spare. This test is what
       * notices if the store ever rounds or truncates below a millisecond.
       */
      it("keeps a one-millisecond turn offset apart", async () => {
        const conversation = await repository.createConversation();
        await repository.insertMessage(conversation.id, message("assistant", 1_001));
        await repository.insertMessage(conversation.id, message("user", 1_000));

        const stored = await repository.getConversation(conversation.id);
        expect(stored?.messages.map((each) => each.id)).toEqual(["user", "assistant"]);
      });

      /**
       * The companion to the tie-break on `listConversations`, and the case the 1 ms offset above
       * is designed to avoid ever reaching. If two messages do land on the same instant, the
       * `[conversationId+createdAt]` index falls back to the primary key — so the fake must too,
       * or the two implementations disagree about the order of a turn.
       */
      it("breaks a createdAt tie by id, ascending", async () => {
        const conversation = await repository.createConversation();
        await repository.insertMessage(conversation.id, message("b", 1_000));
        await repository.insertMessage(conversation.id, message("a", 1_000));
        await repository.insertMessage(conversation.id, message("c", 1_000));

        const stored = await repository.getConversation(conversation.id);
        expect(stored?.messages.map((each) => each.id)).toEqual(["a", "b", "c"]);
        const listed = await repository.listConversations();
        expect(listed[0]?.messages.map((each) => each.id)).toEqual(["a", "b", "c"]);
      });

      it("round-trips timestamps as Date values, not strings or numbers", async () => {
        const conversation = await repository.createConversation();
        await repository.insertMessage(conversation.id, message("a", 1_234_567));

        const stored = await repository.getConversation(conversation.id);
        expect(stored?.createdAt).toBeInstanceOf(Date);
        expect(stored?.updatedAt).toBeInstanceOf(Date);
        expect(stored?.messages[0]?.createdAt).toBeInstanceOf(Date);
        expect(stored?.messages[0]?.createdAt.getTime()).toBe(1_234_567);
      });

      it("narrows the stored role back to a ChatRole", async () => {
        const conversation = await repository.createConversation();
        await repository.insertMessage(
          conversation.id,
          message("a", 1_000, { role: ChatRole.assistant }),
        );

        const stored = await repository.getConversation(conversation.id);
        expect(stored?.messages[0]?.role).toBe(ChatRole.assistant);
      });

      it("returns undefined for a conversation that was never created", async () => {
        expect(await repository.getConversation("no-such-id")).toBeUndefined();
      });
    });

    describe("listConversations", () => {
      it("returns conversations newest updatedAt first", async () => {
        const oldest = await repository.createConversation();
        const middle = await repository.createConversation();
        const newest = await repository.createConversation();
        await repository.updateConversation(oldest.id, { updatedAt: new Date(1_000) });
        await repository.updateConversation(middle.id, { updatedAt: new Date(2_000) });
        await repository.updateConversation(newest.id, { updatedAt: new Date(3_000) });

        const listed = await repository.listConversations();
        expect(listed.map((each) => each.id)).toEqual([newest.id, middle.id, oldest.id]);
      });

      /**
       * Two conversations written in the same `Date.now()` tick share an `updatedAt`, which is not
       * exotic — it is what a loop over `createConversation` produces. IndexedDB orders index
       * records by key then primary key, so a reverse scan yields descending id; the fake has to
       * agree, or the two implementations disagree about a case the app hits.
       */
      it("breaks an updatedAt tie by id, descending", async () => {
        const ids: string[] = [];
        for (let index = 0; index < 3; index += 1) {
          const conversation = await repository.createConversation();
          await repository.updateConversation(conversation.id, { updatedAt: new Date(5_000) });
          ids.push(conversation.id);
        }

        const listed = await repository.listConversations();
        expect(listed.map((each) => each.id)).toEqual([...ids].sort().reverse());
      });

      /**
       * The list is NOT allowed to hollow out `messages`, and this is the case that says why: the
       * New Chat path calls `Conversation.reusableEmpty` on this list, and that function is defined
       * as "the first conversation with no messages". Returning `messages: []` for every row would
       * make it return the user's most recent thread, so New Chat would reopen an existing chat
       * instead of starting one — and `previewText` would show "No messages yet" for every row
       * while it happened.
       */
      it("loads each conversation's messages, so the kit's list helpers work", async () => {
        const withMessages = await repository.createConversation();
        await repository.insertMessage(withMessages.id, message("a", 1_000, { text: "hello" }));
        await repository.insertMessage(
          withMessages.id,
          message("b", 2_000, { text: "summary", isCompactionSummary: true }),
        );
        await repository.updateConversation(withMessages.id, { updatedAt: new Date(2_000) });
        const empty = await repository.createConversation();
        await repository.updateConversation(empty.id, { updatedAt: new Date(1_000) });

        const listed = await repository.listConversations();
        const [first, second] = listed;
        expect(first?.id).toBe(withMessages.id);
        expect(first?.messages.map((each) => each.id)).toEqual(["a", "b"]);
        // The compaction marker is skipped, so the preview is a real turn.
        expect(Conversation.previewText(first!)).toBe("hello");
        expect(Conversation.previewText(second!)).toBe(Conversation.noMessagesPreviewText);
        expect(Conversation.reusableEmpty(listed)?.id).toBe(empty.id);
      });

      it("returns an empty list before anything is created", async () => {
        expect(await repository.listConversations()).toEqual([]);
      });
    });

    describe("deleteConversation", () => {
      /**
       * SwiftData gets this from `deleteRule: .cascade` and Room from a SQLite foreign key.
       * IndexedDB enforces neither, so a half-delete leaves message rows that no query reaches and
       * nothing ever cleans up — which is why this asserts on the raw store, not on a read.
       */
      it("deletes the conversation's messages with it", async () => {
        const doomed = await repository.createConversation();
        const survivor = await repository.createConversation();
        await repository.insertMessage(doomed.id, message("a", 1_000));
        await repository.insertMessage(doomed.id, message("b", 2_000));
        await repository.insertMessage(survivor.id, message("c", 3_000));

        await repository.deleteConversation(doomed.id);

        expect((await harness.allMessageIds()).sort()).toEqual(["c"]);
      });

      it("returns undefined from getConversation afterwards", async () => {
        const conversation = await repository.createConversation();
        await repository.insertMessage(conversation.id, message("a", 1_000));

        await repository.deleteConversation(conversation.id);

        expect(await repository.getConversation(conversation.id)).toBeUndefined();
        expect(await repository.listConversations()).toEqual([]);
      });

      it("is a no-op for an id that is not there", async () => {
        const conversation = await repository.createConversation();
        await repository.deleteConversation("no-such-id");
        expect(await repository.getConversation(conversation.id)).toBeDefined();
      });
    });

    describe("writes for a conversation that is gone", () => {
      /**
       * The race `ChatEngine` guards with `conversation.isDeleted`: the user deletes a thread while
       * its reply is still streaming, and the end-of-turn commit lands after the delete. Persisting
       * it would create the orphan row the cascade above exists to prevent, for a conversation no
       * UI can open again.
       */
      it("drops inserts and saves rather than creating orphans", async () => {
        const conversation = await repository.createConversation();
        await repository.deleteConversation(conversation.id);

        await repository.insertMessage(conversation.id, message("a", 1_000));
        await repository.saveMessage(conversation.id, message("b", 2_000));

        expect(await harness.allMessageIds()).toEqual([]);
      });

      it("does not resurrect the conversation from updateConversation", async () => {
        const conversation = await repository.createConversation();
        await repository.deleteConversation(conversation.id);

        await repository.updateConversation(conversation.id, {
          title: "Ghost",
          updatedAt: new Date(9_000),
        });

        expect(await repository.getConversation(conversation.id)).toBeUndefined();
        expect(await repository.listConversations()).toEqual([]);
      });
    });

    describe("saveMessage", () => {
      it("persists text and isError over the inserted values", async () => {
        const conversation = await repository.createConversation();
        const assistant = message("a", 1_000, { role: ChatRole.assistant, text: "" });
        await repository.insertMessage(conversation.id, assistant);

        assistant.text = "Something went wrong.";
        assistant.isError = true;
        await repository.saveMessage(conversation.id, assistant);

        const stored = await repository.getConversation(conversation.id);
        expect(stored?.messages).toHaveLength(1);
        expect(stored?.messages[0]?.text).toBe("Something went wrong.");
        expect(stored?.messages[0]?.isError).toBe(true);
      });

      it("persists isCompactionSummary", async () => {
        const conversation = await repository.createConversation();
        await repository.insertMessage(
          conversation.id,
          message("a", 1_000, { role: ChatRole.assistant, isCompactionSummary: true }),
        );

        const stored = await repository.getConversation(conversation.id);
        expect(stored?.messages[0]?.isCompactionSummary).toBe(true);
      });
    });

    describe("deleteMessage", () => {
      it("removes only the target message", async () => {
        const conversation = await repository.createConversation();
        await repository.insertMessage(conversation.id, message("a", 1_000));
        await repository.insertMessage(conversation.id, message("b", 2_000));
        await repository.insertMessage(conversation.id, message("c", 3_000));

        await repository.deleteMessage(conversation.id, "b");

        const stored = await repository.getConversation(conversation.id);
        expect(stored?.messages.map((each) => each.id)).toEqual(["a", "c"]);
      });

      /**
       * A message id carried over from a turn on another thread must not delete a live message out
       * of a conversation the user is still reading. A primary-key delete would do exactly that
       * and look entirely correct.
       */
      it("ignores a message id belonging to another conversation", async () => {
        const mine = await repository.createConversation();
        const theirs = await repository.createConversation();
        await repository.insertMessage(theirs.id, message("a", 1_000));

        await repository.deleteMessage(mine.id, "a");

        expect((await repository.getConversation(theirs.id))?.messages.map((m) => m.id)).toEqual([
          "a",
        ]);
      });
    });

    describe("updateConversation", () => {
      it("writes title and updatedAt in one call", async () => {
        const conversation = await repository.createConversation();

        await repository.updateConversation(conversation.id, {
          title: "Porting Ondas",
          updatedAt: new Date(7_000),
        });

        const stored = await repository.getConversation(conversation.id);
        expect(stored?.title).toBe("Porting Ondas");
        expect(stored?.updatedAt.getTime()).toBe(7_000);
        // `createdAt` is not in the patch and must not be touched by it.
        expect(stored?.createdAt.getTime()).toBe(conversation.createdAt.getTime());
      });

      it("leaves out what it was not given", async () => {
        const conversation = await repository.createConversation();
        await repository.updateConversation(conversation.id, { updatedAt: new Date(7_000) });

        await repository.updateConversation(conversation.id, { title: "Renamed" });

        const stored = await repository.getConversation(conversation.id);
        expect(stored?.title).toBe("Renamed");
        expect(stored?.updatedAt.getTime()).toBe(7_000);
      });

      it("accepts an empty patch without disturbing the row", async () => {
        const conversation = await repository.createConversation();
        await repository.updateConversation(conversation.id, {});

        const stored = await repository.getConversation(conversation.id);
        expect(stored?.title).toBe(Conversation.defaultTitle);
        expect(stored?.updatedAt.getTime()).toBe(conversation.updatedAt.getTime());
      });
    });

    /**
     * IndexedDB stores and returns *copies* — it is the structured clone algorithm that moves
     * values in and out. A fake that shared references would be more permissive than the real
     * store, so a W6 test could mutate a returned message, observe the change on the next read,
     * and pass, while the same code against Dexie silently persisted nothing.
     *
     * `Date` gets its own assertions because it is mutable: a shallow copy of a row still hands
     * out a live reference to its timestamps.
     */
    describe("value semantics", () => {
      it("does not hand out live references from getConversation", async () => {
        const conversation = await repository.createConversation();
        await repository.insertMessage(conversation.id, message("a", 1_000, { text: "original" }));

        const first = await repository.getConversation(conversation.id);
        first!.title = "mutated";
        first!.updatedAt.setTime(0);
        first!.messages[0]!.text = "mutated";
        first!.messages[0]!.isError = true;
        first!.messages[0]!.createdAt.setTime(0);
        first!.messages.push(message("b", 2_000));

        const second = await repository.getConversation(conversation.id);
        expect(second?.title).toBe(Conversation.defaultTitle);
        expect(second?.updatedAt.getTime()).toBe(conversation.updatedAt.getTime());
        expect(second?.messages).toHaveLength(1);
        expect(second?.messages[0]?.text).toBe("original");
        expect(second?.messages[0]?.isError).toBe(false);
        expect(second?.messages[0]?.createdAt.getTime()).toBe(1_000);
      });

      it("does not hand out live references from listConversations", async () => {
        const conversation = await repository.createConversation();
        await repository.insertMessage(conversation.id, message("a", 1_000, { text: "original" }));

        const listed = await repository.listConversations();
        listed[0]!.title = "mutated";
        listed[0]!.messages[0]!.text = "mutated";

        const again = await repository.listConversations();
        expect(again[0]?.title).toBe(Conversation.defaultTitle);
        expect(again[0]?.messages[0]?.text).toBe("original");
      });

      it("does not keep a reference to what was written in", async () => {
        const conversation = await repository.createConversation();
        const written = message("a", 1_000, { text: "original" });
        await repository.insertMessage(conversation.id, written);

        written.text = "mutated after the write";
        written.createdAt.setTime(0);

        const stored = await repository.getConversation(conversation.id);
        expect(stored?.messages[0]?.text).toBe("original");
        expect(stored?.messages[0]?.createdAt.getTime()).toBe(1_000);
      });
    });
  });
}
