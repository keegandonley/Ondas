"use client";

import { useId, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { Conversation } from "../../kit/models/Conversation";
import { Copy } from "../../ui/copy";

/**
 * Port of the sidebar half of `Ondas/Features/Conversations/ConversationListView.swift`.
 *
 * Stateless except for the search field, exactly as
 * `android/.../conversations/ConversationListScreen.kt` is: every other piece of state arrives as
 * a prop and every mutation leaves through a callback, so search, deletion and the empty state are
 * testable without a repository. **This component never constructs a repository** — the
 * composition root wires that, the way `ConversationListModel` does on Android.
 *
 * ## What is NOT here, and why
 *
 * Swift's toolbar also carries a Gallery button and a bottom-bar "Generate Image" action
 * (`ConversationListView.swift:52-73`). Both are absent rather than disabled: image generation is
 * cut from web v1 (PORTING.md § Mandatory drifts 1), the same way `Conversation.previewText`'s
 * image branch and `ConversationRow`'s thumbnail branch (`:170-178`) are.
 *
 * The detail pane — `ChatView` and the "Pick a Chat" `ContentUnavailableView`
 * (`:91-103`) — is not here either. This is the sidebar only; the two-pane shell is W8.
 */

/**
 * Conversations narrowed by the search field. Ports
 * `ConversationListView.swift:106-119`'s `filteredConversations`.
 *
 * In memory rather than a re-issued store query, which is what Swift does and what Android's
 * `filterConversations` does: at personal chat-history scale the whole set is already resident,
 * and re-querying per keystroke would fight the live sort. Titles AND message text are matched,
 * case-insensitively, against the trimmed query.
 *
 * Reads `messages` directly rather than `Conversation.orderedMessages` — membership does not care
 * about order, so there is no reason to pay for the sort. Swift and Android both carry this note.
 *
 * Exported so the filter can be exercised on its own, as Android exercises its counterpart.
 */
export function filterConversations(
  conversations: readonly Conversation[],
  query: string,
): Conversation[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [...conversations];
  const needle = trimmed.toLocaleLowerCase();
  const contains = (haystack: string): boolean => haystack.toLocaleLowerCase().includes(needle);
  return conversations.filter(
    (conversation) =>
      contains(conversation.title) ||
      conversation.messages.some((message) => contains(message.text)),
  );
}

export interface ConversationListProps {
  /**
   * The UNFILTERED list, in the order it should render.
   *
   * Rendered as given and never re-sorted here. `ConversationRepository.listConversations()`
   * documents its result as "newest `updatedAt` first" — the order Swift gets from
   * `@Query(sort: \Conversation.updatedAt, order: .reverse)` (`ConversationListView.swift:9-10`) —
   * and re-sorting would restate that contract in a second place where the two could disagree.
   * `ConversationList.test.tsx` § "renders in the order it is given" pins the choice.
   */
  conversations: readonly Conversation[];

  /** Swift's `selectedConversationID: UUID?`. `null` is its `nil`. */
  selectedId: string | null;

  /**
   * Selection changed. Called with `null` to clear it — which is how deleting the open
   * conversation clears the detail pane, so the signature has to admit the empty case.
   */
  onSelect: (id: string | null) => void;

  /** Swift's `startNewConversation()`. The reuse-an-empty-thread policy lives in the caller. */
  onNewChat: () => void;

  /** Deletes one conversation by id. The selection is already cleared by the time this runs. */
  onDelete: (id: string) => void;

  onOpenSettings: () => void;
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onNewChat,
  onDelete,
  onOpenSettings,
}: ConversationListProps) {
  const [searchText, setSearchText] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();

  // Derived during render rather than mirrored into state: it is a pure function of a prop and
  // this component's own search text, so an Effect would only add a render pass and a way to go
  // stale.
  const visible = filterConversations(conversations, searchText);

  /**
   * Ports `ConversationListView.swift:150-160`'s `delete(_:)`.
   *
   * The selection is cleared FIRST, in the same event, so nothing is still rendering the
   * conversation when it stops existing. On Catalyst that ordering is the difference between a
   * working delete and a crash; here React batches both updates into one pass, which is the same
   * guarantee by a different mechanism. Android's `ConversationListModel.delete` carries the note.
   */
  const handleDelete = (conversation: Conversation): void => {
    if (conversation.id === selectedId) onSelect(null);
    onDelete(conversation.id);
  };

  const clearSearch = (): void => {
    setSearchText("");
    // The button that was focused is about to be removed; without this, focus falls to the body.
    searchInputRef.current?.focus();
  };

  return (
    <section className={css.root} aria-labelledby={titleId} style={styles.root}>
      <style>{stylesheet}</style>

      <header style={styles.header}>
        <button
          type="button"
          className={css.iconButton}
          style={styles.iconButton}
          onClick={onOpenSettings}
          aria-label={Copy.settings}
          title={Copy.settings}
        >
          <GearIcon />
        </button>
        <h2 id={titleId} style={styles.title}>
          {Copy.chatsTitle}
        </h2>
        <button
          type="button"
          className={css.iconButton}
          style={styles.iconButton}
          onClick={onNewChat}
          aria-label={Copy.newChat}
          title={Copy.newChat}
        >
          <ComposeIcon />
        </button>
      </header>

      {/* Swift gets this from `.searchable(text:prompt:)` (`:44`); the web has no such modifier,
          so the field is hand-built exactly as Android's `SearchField` is — leading glyph, and a
          clear button that appears only once something is typed. */}
      <div className={css.searchRow} style={styles.searchRow}>
        <span style={styles.searchIcon} aria-hidden="true">
          <SearchIcon />
        </span>
        <input
          ref={searchInputRef}
          type="search"
          className={css.searchInput}
          style={styles.searchInput}
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          placeholder={Copy.searchChats}
          aria-label={Copy.searchChats}
        />
        {searchText.length > 0 && (
          <button
            type="button"
            className={css.clearButton}
            style={styles.clearButton}
            onClick={clearSearch}
            aria-label={Copy.clearSearch}
            title={Copy.clearSearch}
          >
            <ClearIcon />
          </button>
        )}
      </div>

      {conversations.length === 0 ? (
        // Conditioned on the UNFILTERED list, as Swift's `.overlay { if conversations.isEmpty }`
        // (`:75-79`) is: a search that matches nothing leaves an empty list, it does not claim
        // there are no chats.
        <EmptyState onNewChat={onNewChat} />
      ) : (
        <ul className={css.list} style={styles.list}>
          {visible.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              isSelected={conversation.id === selectedId}
              onSelect={() => onSelect(conversation.id)}
              onDelete={() => handleDelete(conversation)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One row: title over a one-line preview of the latest message, both ellipsised — Swift's
 * `ConversationRow` (`:165-192`), minus the thumbnail branch.
 *
 * Swift offers deletion three ways (`.contextMenu`, `.swipeActions`, `.onDelete`) because each is
 * the discoverable one on a different platform. On the web the primary affordance is a per-row
 * button: it is the only one of the three that is reachable from the keyboard and announced by a
 * screen reader, and a swipe is not discoverable with a mouse at all. It is a sibling of the row
 * button rather than nested inside it, because a button inside a button is invalid HTML and the
 * inner one stops being operable.
 */
function ConversationRow({
  conversation,
  isSelected,
  onSelect,
  onDelete,
}: {
  conversation: Conversation;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const titleId = useId();

  return (
    <li className={css.row} style={isSelected ? styles.rowSelected : styles.row}>
      <button
        type="button"
        className={css.rowButton}
        style={styles.rowButton}
        onClick={onSelect}
        // `aria-current` rather than `aria-selected`: the latter is only valid inside a listbox,
        // which would also oblige this list to implement roving-tabindex arrow navigation.
        aria-current={isSelected ? "true" : undefined}
      >
        <span id={titleId} className={css.rowTitle} style={styles.rowTitle}>
          {conversation.title}
        </span>
        <span className={css.rowPreview} style={styles.rowPreview}>
          {/* Already skips compaction markers — see `Conversation.latestMessage`. */}
          {Conversation.previewText(conversation)}
        </span>
      </button>
      <button
        type="button"
        className={css.deleteButton}
        style={styles.deleteButton}
        onClick={onDelete}
        // "Delete" is what Swift's `Label` and Android's `contentDescription` both say. The row's
        // title is attached as the description so the announcement is still unambiguous without
        // inventing a second string that would then be able to drift from `Copy.deleteAction`.
        aria-label={Copy.deleteAction}
        aria-describedby={titleId}
        title={Copy.deleteAction}
      >
        <TrashIcon />
      </button>
    </li>
  );
}

/** `ContentUnavailableView("No Chats Yet", …)` and its New Chat action (`:122-132`). */
function EmptyState({ onNewChat }: { onNewChat: () => void }) {
  return (
    <div style={styles.emptyState}>
      <p style={styles.emptyTitle}>{Copy.emptyChatsTitle}</p>
      <p style={styles.emptyBody}>{Copy.emptyChatsBody}</p>
      <button type="button" className={css.primaryButton} style={styles.primaryButton} onClick={onNewChat}>
        {Copy.newChat}
      </button>
    </div>
  );
}

/*
 * Icons stand in for the SF Symbols Swift names inline: `gearshape`, `square.and.pencil`,
 * `magnifyingglass`, `xmark.circle.fill`, `trash`. Drawn here rather than pulled from an icon
 * package because the port adds no dependencies for five glyphs. Every one is `aria-hidden`; the
 * accessible name lives on the button, as it does on Swift's `Label`.
 */

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1.125rem"
      height="1.125rem"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

function GearIcon() {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
    </Glyph>
  );
}

function ComposeIcon() {
  return (
    <Glyph>
      <path d="M11 4.5H5.5A1.5 1.5 0 0 0 4 6v12a1.5 1.5 0 0 0 1.5 1.5h12A1.5 1.5 0 0 0 19 18v-5.5" />
      <path d="M17.2 3.3a1.9 1.9 0 0 1 2.7 2.7L12.6 13.3l-3.4.7.7-3.4z" />
    </Glyph>
  );
}

function SearchIcon() {
  return (
    <Glyph>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.3-4.3" />
    </Glyph>
  );
}

function ClearIcon() {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" />
    </Glyph>
  );
}

function TrashIcon() {
  return (
    <Glyph>
      <path d="M4.5 6.5h15M9.5 6.5V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7" />
      <path d="M6.8 6.5l.8 12a1.5 1.5 0 0 0 1.5 1.4h5.8a1.5 1.5 0 0 0 1.5-1.4l.8-12" />
    </Glyph>
  );
}

/*
 * Styling.
 *
 * Inline style objects plus one `<style>` element for the states inline styles cannot express
 * (`:hover`, `:focus-visible`, `::placeholder`, and hiding Chrome's own search-cancel glyph so
 * there are not two clear buttons). No CSS framework and no new dependency, per the spec.
 *
 * Every colour is a `var(--ondas-*)` custom property from app/globals.css — the chain from the
 * Xcode asset catalog through `src/design/Theme.ts` to the rendered pixel is closed by
 * `Theme.test.ts`, and a hard-coded hex here would step outside it.
 *
 * Sizes are in `rem` so browser text scaling — the web's Dynamic Type — moves the layout with the
 * text. The point values that Swift specifies are noted where they are ported.
 */

const css = {
  root: "ondas-cl-root",
  iconButton: "ondas-cl-icon-button",
  searchRow: "ondas-cl-search-row",
  searchInput: "ondas-cl-search-input",
  clearButton: "ondas-cl-clear-button",
  list: "ondas-cl-list",
  row: "ondas-cl-row",
  rowButton: "ondas-cl-row-button",
  rowTitle: "ondas-cl-row-title",
  rowPreview: "ondas-cl-row-preview",
  deleteButton: "ondas-cl-delete-button",
  primaryButton: "ondas-cl-primary-button",
} as const;

const stylesheet = `
.${css.root} :focus-visible {
  outline: 2px solid var(--ondas-accent);
  outline-offset: -2px;
  border-radius: 0.5rem;
}
.${css.iconButton}:hover,
.${css.clearButton}:hover,
.${css.deleteButton}:hover {
  color: var(--ondas-label);
}
.${css.searchInput}::placeholder {
  color: var(--ondas-tertiary-label);
}
.${css.searchInput}::-webkit-search-cancel-button {
  -webkit-appearance: none;
  appearance: none;
}
.${css.row}:hover .${css.deleteButton} {
  opacity: 1;
}
.${css.deleteButton}:focus-visible {
  opacity: 1;
}
`;

const ellipsised = {
  display: "block",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const satisfies CSSProperties;

/** Shared by the plain and the selected row, so the two cannot drift apart in anything but tint. */
const rowBase = {
  display: "flex",
  alignItems: "stretch",
  background: "transparent",
} as const satisfies CSSProperties;

const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    height: "100%",
    background: "var(--ondas-bar)",
    color: "var(--ondas-label)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.5rem 0.75rem",
  },
  title: {
    flex: 1,
    margin: 0,
    textAlign: "center",
    // SwiftUI `.navigationBarTitleDisplayMode(.inline)`'s headline weight and size.
    fontSize: "1.0625rem",
    fontWeight: 600,
  },
  iconButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    // 2.75rem = 44pt, Apple's minimum hit target.
    width: "2.75rem",
    height: "2.75rem",
    padding: 0,
    border: "none",
    background: "transparent",
    color: "var(--ondas-accent)",
    cursor: "pointer",
  },
  searchRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    margin: "0 0.75rem 0.5rem",
    padding: "0 0.5rem",
    borderRadius: "0.625rem",
    background: "var(--ondas-assistant-bubble)",
  },
  searchIcon: {
    display: "inline-flex",
    color: "var(--ondas-secondary-label)",
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    padding: "0.5rem 0",
    border: "none",
    background: "transparent",
    color: "var(--ondas-label)",
    font: "inherit",
    fontSize: "1.0625rem",
  },
  clearButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0.25rem",
    border: "none",
    background: "transparent",
    color: "var(--ondas-secondary-label)",
    cursor: "pointer",
  },
  list: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    margin: 0,
    // The 1rem tail matches the 16dp bottom content padding Android's LazyColumn carries.
    padding: "0 0 1rem",
    listStyle: "none",
  },
  row: rowBase,
  rowSelected: {
    ...rowBase,
    // Swift's `List(selection:)` highlight; Android uses `secondaryContainer`. The web has no
    // system-supplied selection role, so the brand accent is used at low opacity.
    background: "color-mix(in srgb, var(--ondas-accent) 16%, transparent)",
  },
  rowButton: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: "0.1875rem", // Swift's `VStack(alignment: .leading, spacing: 3)`.
    // The 0.5rem block padding stands in for Swift's `.padding(.vertical, 2)` plus the row insets
    // `List` supplies for free; the web has no List, so the two are folded into one number.
    padding: "0.5rem 0.25rem 0.5rem 1rem",
    border: "none",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
  },
  rowTitle: {
    ...ellipsised,
    // `.font(.headline)`, one line, ellipsised.
    fontSize: "1.0625rem",
    fontWeight: 600,
  },
  rowPreview: {
    ...ellipsised,
    // `.font(.subheadline).foregroundStyle(.secondary)`, one line, ellipsised.
    fontSize: "0.9375rem",
    color: "var(--ondas-secondary-label)",
  },
  deleteButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "2.75rem",
    flexShrink: 0,
    border: "none",
    background: "transparent",
    color: "var(--ondas-secondary-label)",
    cursor: "pointer",
    // Quiet until the row is hovered or the button is focused — the same "present but not
    // shouting" weight Swift's swipe action has. Never `display: none`: it has to stay in the tab
    // order and in the accessibility tree.
    opacity: 0.55,
  },
  emptyState: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.5rem",
    padding: "2rem",
    textAlign: "center",
  },
  emptyTitle: {
    margin: 0,
    fontSize: "1.375rem",
    fontWeight: 600,
  },
  emptyBody: {
    margin: "0 0 0.75rem",
    fontSize: "0.9375rem",
    color: "var(--ondas-secondary-label)",
  },
  primaryButton: {
    padding: "0.5rem 1.25rem",
    border: "none",
    borderRadius: "0.625rem",
    background: "var(--ondas-accent)",
    color: "var(--ondas-on-user-bubble)",
    font: "inherit",
    fontWeight: 600,
    cursor: "pointer",
  },
} as const satisfies Record<string, CSSProperties>;
