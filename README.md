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
| Image-intent detection | `ImageRequestHeuristic` (keyword prefilter) + `ImageIntent` (model classifier) |
| UI | `Ondas/Features/` |

### How image requests work

Generating an image on every turn would be wasteful, so Ondas decides in two cheap
steps: a keyword prefilter (`ImageRequestHeuristic`) narrows candidates, then the language
model confirms intent and writes a clean image prompt (`ImageIntent`). Only then does
`ImageGenerator` run the on-device Image Playground model. Otherwise the message is answered
as normal text.

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
