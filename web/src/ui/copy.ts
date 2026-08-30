/**
 * Every user-visible string in the web app, in one place.
 *
 * Ported verbatim from the Swift source unless marked. Named constants rather than inline strings
 * because the Android port adopted this convention only after duplicated copy drifted between a
 * screen and its tests — tests here assert against the constant, so the rendered string and the
 * asserted string cannot diverge.
 */
export const Copy = {
  // ConversationListView.swift
  chatsTitle: "Chats",
  newChat: "New Chat",
  searchChats: "Search chats",
  clearSearch: "Clear search",
  settings: "Settings",
  deleteAction: "Delete",
  emptyChatsTitle: "No Chats Yet",
  emptyChatsBody: "Start a new conversation to chat with the on-device model.",
  pickAChatTitle: "Pick a Chat",
  pickAChatBody: "Select a conversation or start a new one.",
  backToChats: "Back to chats",

  // ChatView.swift
  contextLabel: "Context",
  tokensSuffix: "tokens",
  chatGettingLong: "This chat is getting long.",
  compactingConversation: "Compacting the conversation…",
  compactAction: "Compact",
  chatIsFull: "This chat is full.",
  composerPlaceholder: "Message",
  sendMessage: "Send message",
  stopGenerating: "Stop generating",
  scrollToLatest: "Scroll to latest message",
  assistantIsTyping: "Assistant is typing",

  // CompactionDivider.swift
  conversationCompacted: "Conversation compacted",
  conversationCompactedAccessible:
    "Conversation compacted. Earlier messages are summarized from here up.",

  // Settings — the sheet is rebuilt for the web (PORTING.md § Approved additions 2); every Swift
  // row is cut, stubbed or unportable, so this copy is new.
  settingsTitle: "Settings",
  done: "Done",
  modelSection: "Model",
  modelStatus: "Status",
  storageSection: "Storage",
  storageChats: "Chats",
  storagePersistent: "Persistent storage",
  storagePersistentGranted: "Granted",
  storagePersistentRequest: "Request",
  storagePersistentFooter:
    "Ask the browser to keep your chats even when storage runs low. This cannot be undone from here.",
  dataSection: "Data",
  deleteAllChats: "Delete all chats",
  deleteAllChatsConfirm: "Delete every conversation? This cannot be undone.",
  aboutSection: "About",
  version: "Version",

  // Settings, continued. `ModelAvailability` (src/chat/OnDeviceModel.ts) humanised for the Model
  // → Status row. Web-only: Swift's Settings sheet has no model row at all, and Apple's
  // `SystemLanguageModel.Availability` has a different set of cases, so there is nothing to port
  // these from. Keyed off the union's members, never off a message string — PORTING.md
  // § Approved additions 1 gives the reason: rewording copy must not be able to remove a state.
  modelStatusAvailable: "Available",
  modelStatusDownloadable: "Ready to download",
  modelStatusDownloading: "Downloading…",
  modelStatusUnavailable: "Unavailable",

  /** Shown where the browser supports the Storage API but declines to report a number. */
  storageUnknown: "—",
  /** Shown where the browser has no Storage API at all. Kept distinct from `storageUnknown`,
   * because `StoragePersistence.isSupported()` keeps those two cases distinguishable on purpose. */
  storageUnsupported: "Not reported by this browser",
  storagePersistentNotGranted: "Not granted",
  cancel: "Cancel",
  /** The second step of the inline delete-all confirm. Distinct from `deleteAllChats`, which is
   * the row that opens the confirm. */
  deleteAllChatsAction: "Delete all",

  // Unsupported browser — approved addition 1, no Swift counterpart.
  unsupportedTitle: "Ondas needs Chrome",
  unsupportedBody:
    "This app runs a language model built into the browser itself. That API ships only in desktop Chrome and Edge — Safari and Firefox have no equivalent yet.",
} as const;
