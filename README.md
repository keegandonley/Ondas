# Ondas

A simple, private SwiftUI chat app built entirely on **Apple Intelligence**. Everything
runs on-device — no accounts, no sign-up, no server.

- **Chat** with the on-device language model (Apple's Foundation Models).
- **Multiple conversations** with full, searchable history in a sidebar.
- **iCloud sync** via SwiftData + CloudKit — your chats follow you across devices, using the
  iCloud account already signed in on the device.
- **On-device image generation** — ask for a picture ("draw a lighthouse", "generate a logo")
  and the app produces an image with Apple's Image Playground model.

## Requirements

- iOS 26 (Foundation Models + the GA on-device image APIs).
- A device that supports Apple Intelligence, with it enabled in Settings. On the Simulator
  or unsupported hardware the app runs but shows a friendly "unavailable" message in chat.
- Xcode 26.
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).

## Getting started

```sh
xcodegen generate      # writes Ondas.xcodeproj from project.yml
open Ondas.xcodeproj
```

Set your signing team and iCloud container in Xcode if the defaults don't match your account,
then build and run.

> The `.xcodeproj` and generated `Info.plist` are intentionally git-ignored — regenerate them
> with `xcodegen generate`.

## Architecture

| Area | File(s) |
| --- | --- |
| App entry | `Ondas/App/OndasApp.swift` |
| CloudKit-synced store | `Ondas/App/AppModelContainer.swift` |
| Data models | `Ondas/Models/` (`Conversation`, `ChatMessage`, `ChatRole`) |
| Chat orchestration | `Ondas/Services/ChatEngine.swift` |
| Image generation | `Ondas/Services/ImageGenerator.swift` |
| Image tool | `ImageGenerationTool` (a FoundationModels `Tool` the model calls) |
| UI | `Ondas/Features/` |

### How image requests work

Image generation is registered on the live `LanguageModelSession` as a FoundationModels
`Tool` (`ImageGenerationTool`), so the **model itself** decides when to create an image and
calls the tool with a clean visual description. The tool runs the on-device Image Playground
model (`ImageGenerator`) and the picture is handed back to the chat through a small `Sendable`
`GeneratedImageCollector` (the tool call runs off the main actor). Because the model made the
image, it writes a genuine natural-language reply about it — and handles follow-ups like
"make it bigger" natively, with no separate intent classifier or acknowledgment reframing.

### Context persistence and the chat cap

Opening a conversation rehydrates the model's working memory from the persisted transcript
(`ChatEngine.makeTranscript`), so follow-ups like "make it bigger" keep their context across
app relaunches and thread switches — not just within a single sitting. The **entire** history
is replayed into the session; generated-image turns seed as a short text note (plus any
caption) since the image bytes aren't part of the language transcript.

To keep the rehydrated transcript inside the on-device model's context window, each
conversation is **hard-capped** at `Conversation.messageLimit` messages. Rather than silently
dropping older turns, a full chat is closed to new input: the composer is disabled and a
banner invites the user to start a fresh chat. This keeps the model's view of every
conversation complete and truthful.
