import { describe, expect, it } from "vitest";

import { ChatMessage } from "../kit/models/ChatMessage";
import { ChatRole } from "../kit/models/ChatRole";
import { describeConversationRepository } from "./ConversationRepositoryContract";
import { InMemoryConversationRepository } from "./InMemoryConversationRepository";

/*
 * Note what this file does NOT import: `fake-indexeddb/auto`. That is the point of the class — spec
 * W6's `ChatEngine` suite runs in plain Node with no IndexedDB at all, so if this implementation
 * ever reached for one, every test here would fail rather than quietly depending on a global some
 * other test file happened to install.
 *
 * The behavioural cases live in `ConversationRepositoryContract` and run against the Dexie store
 * too. Only fake-specific facts belong here.
 */

describeConversationRepository("InMemoryConversationRepository", () => {
  const repository = new InMemoryConversationRepository();
  return Promise.resolve({
    repository,
    async allMessageIds(): Promise<string[]> {
      return repository.storedMessageIds();
    },
    async dispose(): Promise<void> {
      // Nothing to release; the next test constructs a fresh instance.
    },
  });
});

describe("InMemoryConversationRepository isolation", () => {
  it("shares no state between instances", async () => {
    const first = new InMemoryConversationRepository();
    const second = new InMemoryConversationRepository();

    const conversation = await first.createConversation();
    await first.insertMessage(
      conversation.id,
      ChatMessage.make({ role: ChatRole.user, text: "hi" }),
    );

    expect(await second.getConversation(conversation.id)).toBeUndefined();
    expect(await second.listConversations()).toEqual([]);
    expect(second.storedMessageIds()).toEqual([]);
  });
});
