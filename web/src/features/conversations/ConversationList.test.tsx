// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { ChatRole } from "../../kit/models/ChatRole";
import type { ChatMessage } from "../../kit/models/ChatMessage";
import { Conversation } from "../../kit/models/Conversation";
import { Copy } from "../../ui/copy";
import { ConversationList, filterConversations } from "./ConversationList";

/**
 * `ConversationListView.swift`'s sidebar, exercised through the DOM.
 *
 * The three behaviours that are easy to get subtly wrong, and that each encode a note the Swift
 * source carries explicitly:
 *
 *  1. The empty state keys off the UNFILTERED list (`ConversationListView.swift:75-79`), so a
 *     search that matches nothing shows an empty list rather than "No Chats Yet".
 *  2. Search matches message text, not only titles (`:106-119`).
 *  3. Deleting the open conversation clears the selection FIRST (`:150-160`).
 *
 * Every assertion goes through `Copy`, never through a second transcription of a string, so the
 * rendered copy and the asserted copy cannot drift.
 */

afterEach(cleanup);

let nextId = 0;

function message(text: string): ChatMessage {
  nextId += 1;
  return {
    id: `message-${nextId}`,
    role: ChatRole.user,
    text,
    createdAt: new Date(2026, 0, 1, 0, nextId),
    isError: false,
    isCompactionSummary: false,
  };
}

/** Ids are explicit rather than generated so order assertions read as the fixture wrote them. */
function conversation(id: string, title: string, texts: string[] = []): Conversation {
  return {
    id,
    title,
    createdAt: new Date(2026, 0, 1),
    updatedAt: new Date(2026, 0, 1),
    messages: texts.map(message),
  };
}

interface Handlers {
  onSelect: Mock<(id: string | null) => void>;
  onNewChat: Mock<() => void>;
  onDelete: Mock<(id: string) => void>;
  onOpenSettings: Mock<() => void>;
}

function renderList(
  conversations: Conversation[],
  selectedId: string | null = null,
): Handlers {
  const handlers: Handlers = {
    onSelect: vi.fn<(id: string | null) => void>(),
    onNewChat: vi.fn<() => void>(),
    onDelete: vi.fn<(id: string) => void>(),
    onOpenSettings: vi.fn<() => void>(),
  };
  render(
    <ConversationList conversations={conversations} selectedId={selectedId} {...handlers} />,
  );
  return handlers;
}

function search(text: string): void {
  fireEvent.change(screen.getByRole("searchbox", { name: Copy.searchChats }), {
    target: { value: text },
  });
}

/** Row titles in the order they are rendered. The title is the first line of each list item. */
function renderedTitles(): string[] {
  return screen
    .queryAllByRole("listitem")
    .map((item) => item.querySelector("span")?.textContent ?? "");
}

describe("rows", () => {
  it("shows each conversation's title over its preview text", () => {
    renderList([conversation("a", "Tide charts", ["how do tides work", "The moon pulls."])]);

    expect(screen.getByText("Tide charts")).toBeTruthy();
    // `previewText` is the latest non-compaction message — see `Conversation.latestMessage`.
    expect(screen.getByText("The moon pulls.")).toBeTruthy();
  });

  it("falls back to the no-messages preview for an empty thread", () => {
    renderList([conversation("a", Conversation.defaultTitle)]);

    expect(screen.getByText(Conversation.noMessagesPreviewText)).toBeTruthy();
  });

  /**
   * The repository's contract is "newest `updatedAt` first" — the order Swift's
   * `@Query(sort:order:.reverse)` supplies — and this component renders that order rather than
   * restating the sort. The fixture is deliberately in an order the timestamps do NOT justify, so
   * a re-sort introduced here would show up as a reordered list.
   */
  it("renders in the order it is given, without re-sorting", () => {
    const older = conversation("older", "Older");
    older.updatedAt = new Date(2020, 0, 1);
    const newer = conversation("newer", "Newer");
    newer.updatedAt = new Date(2030, 0, 1);

    renderList([older, newer]);

    expect(renderedTitles()).toEqual(["Older", "Newer"]);
  });

  it("marks only the selected row as current", () => {
    renderList([conversation("a", "Alpha"), conversation("b", "Beta")], "b");

    const current = screen
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-current") === "true");
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain("Beta");
  });

  it("selects the conversation whose row was clicked", () => {
    const handlers = renderList([conversation("a", "Alpha"), conversation("b", "Beta")]);

    fireEvent.click(screen.getByText("Beta"));

    expect(handlers.onSelect).toHaveBeenCalledWith("b");
  });
});

describe("search", () => {
  it("matches message text, not only titles", () => {
    renderList([
      conversation("a", "Tide charts", ["The moon pulls the ocean."]),
      conversation("b", "Sourdough", ["Feed the starter."]),
    ]);

    search("starter");

    expect(renderedTitles()).toEqual(["Sourdough"]);
  });

  it("matches titles", () => {
    renderList([conversation("a", "Tide charts"), conversation("b", "Sourdough")]);

    search("tide");

    expect(renderedTitles()).toEqual(["Tide charts"]);
  });

  it("ignores case and surrounding whitespace", () => {
    renderList([conversation("a", "Tide charts", ["The MOON pulls."])]);

    search("   mOoN   ");

    expect(renderedTitles()).toEqual(["Tide charts"]);
  });

  /**
   * The distinction Swift's `.overlay { if conversations.isEmpty }` makes and a filtered-list
   * empty check would lose: with chats on file, a search that matches nothing leaves an EMPTY
   * LIST. Claiming "No Chats Yet" here would tell the user their history was gone.
   */
  it("shows an empty list, not the empty state, when a search matches nothing", () => {
    renderList([conversation("a", "Tide charts", ["The moon pulls."])]);

    search("zzzzz");

    expect(renderedTitles()).toEqual([]);
    expect(screen.queryByText(Copy.emptyChatsTitle)).toBeNull();
    expect(screen.queryByText(Copy.emptyChatsBody)).toBeNull();
  });

  it("shows the empty state when there are no chats at all", () => {
    renderList([]);

    expect(screen.getByText(Copy.emptyChatsTitle)).toBeTruthy();
    expect(screen.getByText(Copy.emptyChatsBody)).toBeTruthy();
  });

  it("offers New Chat from the empty state", () => {
    const handlers = renderList([]);

    // Two controls carry this name once the empty state is up — the toolbar's icon button and the
    // empty state's prominent one. This is the latter, the only one with visible text.
    const emptyStateAction = screen
      .getAllByRole("button", { name: Copy.newChat })
      .find((button) => button.textContent === Copy.newChat);
    fireEvent.click(emptyStateAction as HTMLElement);

    expect(handlers.onNewChat).toHaveBeenCalledTimes(1);
  });

  it("offers the clear button only once something is typed, and restores the full list", () => {
    renderList([conversation("a", "Tide charts"), conversation("b", "Sourdough")]);

    expect(screen.queryByRole("button", { name: Copy.clearSearch })).toBeNull();

    search("tide");
    expect(renderedTitles()).toEqual(["Tide charts"]);

    fireEvent.click(screen.getByRole("button", { name: Copy.clearSearch }));

    expect(renderedTitles()).toEqual(["Tide charts", "Sourdough"]);
    expect(screen.queryByRole("button", { name: Copy.clearSearch })).toBeNull();
  });

  it("returns focus to the field after clearing, so the keyboard is not stranded", () => {
    renderList([conversation("a", "Tide charts")]);
    search("tide");

    fireEvent.click(screen.getByRole("button", { name: Copy.clearSearch }));

    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: Copy.searchChats }));
  });
});

describe("filterConversations", () => {
  it("returns everything for a blank query", () => {
    const all = [conversation("a", "Alpha"), conversation("b", "Beta")];

    expect(filterConversations(all, "   ")).toEqual(all);
  });

  it("does not mutate or reorder the input", () => {
    const all = [conversation("a", "Alpha"), conversation("b", "Beta")];

    const result = filterConversations(all, "");

    expect(result).not.toBe(all);
    expect(result.map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("delete", () => {
  /**
   * Swift clears the selection first and defers the delete a main-actor hop, because a detail pane
   * still rendering a deleted model reads an invalidated object and crashes on Catalyst. The web
   * has no such crash, but the ordering is the behaviour being ported: the selection must not
   * survive its conversation.
   */
  it("clears the selection before deleting the selected conversation", () => {
    const handlers = renderList([conversation("a", "Alpha"), conversation("b", "Beta")], "b");

    const deleteButtons = screen.getAllByRole("button", { name: Copy.deleteAction });
    fireEvent.click(deleteButtons[1] as HTMLElement);

    expect(handlers.onSelect).toHaveBeenCalledWith(null);
    expect(handlers.onDelete).toHaveBeenCalledWith("b");
    // Order matters, not merely that both happened.
    expect(handlers.onSelect.mock.invocationCallOrder[0]).toBeLessThan(
      handlers.onDelete.mock.invocationCallOrder[0] as number,
    );
  });

  it("leaves the selection alone when a different conversation is deleted", () => {
    const handlers = renderList([conversation("a", "Alpha"), conversation("b", "Beta")], "b");

    const deleteButtons = screen.getAllByRole("button", { name: Copy.deleteAction });
    fireEvent.click(deleteButtons[0] as HTMLElement);

    expect(handlers.onDelete).toHaveBeenCalledWith("a");
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  /**
   * Deletion indexes into the RENDERED list. Swift's `deleteConversations(at:)` carries the note:
   * offsets resolving against the unfiltered query would delete the wrong row during a search.
   * Passing the conversation itself is how this port makes that unrepresentable — this pins it.
   */
  it("deletes the row that is visible, not the one at that index unfiltered", () => {
    const handlers = renderList([
      conversation("a", "Tide charts"),
      conversation("b", "Sourdough"),
    ]);

    search("sour");
    fireEvent.click(screen.getByRole("button", { name: Copy.deleteAction }));

    expect(handlers.onDelete).toHaveBeenCalledWith("b");
  });

  it("keeps the delete control in the tab order rather than hiding it until hover", () => {
    renderList([conversation("a", "Alpha")]);

    const button = screen.getByRole("button", { name: Copy.deleteAction });
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-hidden")).toBeNull();
  });
});

describe("toolbar", () => {
  it("opens settings", () => {
    const handlers = renderList([conversation("a", "Alpha")]);

    fireEvent.click(screen.getByRole("button", { name: Copy.settings }));

    expect(handlers.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("starts a new chat", () => {
    const handlers = renderList([conversation("a", "Alpha")]);

    fireEvent.click(screen.getByRole("button", { name: Copy.newChat }));

    expect(handlers.onNewChat).toHaveBeenCalledTimes(1);
  });
});
