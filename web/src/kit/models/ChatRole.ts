/**
 * Port of `Ondas/Models/ChatRole.swift`.
 *
 * Who authored a message in a conversation. Swift declares `enum ChatRole: String` and stores the
 * raw string on `ChatMessage`, because a CloudKit-backed SwiftData store requires defaulted scalar
 * properties. A TypeScript string-literal union IS its raw value at runtime, so the union and the
 * persisted form are the same thing and the raw values still match Swift exactly — a row written
 * by either implementation reads the same.
 *
 * The union and the object share a name deliberately: the type lives in type space, the object in
 * value space, so `ChatRole.user` reads like the Swift case and `role: ChatRole` reads like the
 * Swift type. Same pattern in every file in this layer.
 */
export type ChatRole = "user" | "assistant";

export const ChatRole = {
  user: "user",
  assistant: "assistant",

  /**
   * Mirrors Swift's `ChatRole(rawValue: roleRaw) ?? .user` (`ChatMessage.swift:54`): an
   * unrecognised value degrades to `user` rather than throwing, because a message whose role we
   * cannot parse is still a message worth showing. Used at the persistence boundary (spec W5),
   * where a stored string has not been proven to be one of the two cases.
   */
  fromRaw(raw: string): ChatRole {
    return raw === ChatRole.assistant ? "assistant" : "user";
  },
} as const;
