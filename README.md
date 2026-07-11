# Ondas

Ondas is a SwiftUI chat app built on Apple's on-device intelligence APIs. Core text
generation and image generation use Foundation Models and Image Playground on a
compatible device. Conversations and generated images are stored locally and configured
to sync through iCloud/CloudKit; there is no Ondas account, sign-up flow, or
Ondas-operated model endpoint.

## Features

- **Chat** with Apple's on-device Foundation Models language model.
- **Searchable conversation history** with multiple threads.
- **iCloud sync** for conversations, messages, generated images, and associated metadata.
- **On-device image generation** through Image Playground.
- **Optional OTLP telemetry**, disabled by default and sent only to an endpoint the user
  explicitly configures.

## Privacy at a glance

“On-device” describes the core model inference, not every data path. Chat data is
CloudKit-backed so it can sync using the Apple Account signed in on the device. Optional
telemetry can include usage metadata—and, only with a separate setting, text
transcripts—to a user-selected OTLP endpoint. Read [PRIVACY.md](PRIVACY.md) before
using or distributing the app.

## Requirements

- iOS or iPadOS 26.4. Mac Catalyst builds target macOS 26.4.
- A device that supports Apple Intelligence with it enabled. The app can build and test
  on a Simulator, but model features may report themselves unavailable there.
- Xcode 26.4.1 (build 17E202).
- [XcodeGen 2.45.4](https://github.com/yonaskolb/XcodeGen/releases/tag/2.45.4), the
  version pinned by the CI bootstrap script.

## Quick start

The tracked identity configuration uses a safe example bundle identifier and no signing
team, which is suitable for generating the project and running Simulator tests.

```sh
xcodegen generate --spec project.yml
open Ondas.xcodeproj
```

The `.xcodeproj` and generated `Info.plist` files are intentionally ignored. Regenerate
them after changing `project.yml` or the identity configuration.

## Running your own fork

Do not change signing or capabilities only in Xcode: `xcodegen generate` recreates the
project from the tracked configuration. Create a local identity override instead:

```sh
cp Config/Identity.local.xcconfig.example Config/Identity.local.xcconfig
```

Set these values in `Config/Identity.local.xcconfig`:

- `ONDAS_DEVELOPMENT_TEAM` — your Apple Developer Team ID.
- `ONDAS_MAIN_APP_BUNDLE_IDENTIFIER` — a bundle ID owned by your team, such as
  `com.example.myondas`.
- `ONDAS_MENU_BAR_URL_SCHEME` — a unique scheme if your Mac menu-bar helper can coexist
  with another build.

The base configuration derives the helper and test bundle IDs, CloudKit container, iOS
and macOS App Groups, ubiquity key-value store, and keychain access group from the main
bundle ID. Those derived settings can be overridden in the local file when a team uses
different capability names. The local override is git-ignored; do not commit your team
or service configuration.

For a signed device build or a CloudKit-enabled distribution, register the derived app
identifiers and CloudKit container in your own Apple Developer account, then enable the
needed iCloud/CloudKit, Push Notifications, and (for the Mac menu-bar configuration)
App Groups and Keychain Sharing capabilities. Do not point a fork at the upstream
project's Apple identifiers or CloudKit container. Regenerate the project after editing
the local config.

## Test

```sh
xcodegen generate --spec project.yml
xcodebuild test \
  -project Ondas.xcodeproj \
  -scheme Ondas \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max'
```

Choose another installed iOS Simulator if that destination is unavailable.

## Architecture

| Area | File(s) |
| --- | --- |
| App entry | `Ondas/App/OndasApp.swift` |
| CloudKit-synced store | `Ondas/App/AppModelContainer.swift` |
| Data models | `Ondas/Models/` (`Conversation`, `ChatMessage`, `ChatRole`) |
| Chat orchestration | `Ondas/Services/ChatEngine.swift` |
| Image generation | `Ondas/Services/ImageCommand.swift`, `Ondas/Services/ImageGenerator.swift` |
| UI | `Ondas/Features/` |

### How image requests work

Enter `/image ` followed by a prompt to generate an image directly with the on-device Image
Playground model. Image turns do not invoke the language model; the generated image is saved as
an assistant message in the conversation and appears in the gallery. Plain chat turns continue
to use the Foundation Models session.

### Context persistence and the chat cap

Opening a conversation rehydrates the model's working memory from the persisted transcript
(`ChatEngine.makeTranscript`), so follow-ups like "make it bigger" keep their context across
app relaunches and thread switches — not just within a single sitting. The **entire** history
is replayed into the session; generated-image turns seed as a short text note (plus any
caption) since the image bytes aren't part of the language transcript.

To keep the rehydrated transcript inside the on-device model's context window, the app tracks
the model's token budget and shows a warning before capacity. The user can compact a long
conversation: Ondas stores a concise summary of the older turns and rebuilds the live model
context from that summary plus the newest messages. A message-count cap remains as a fallback
when a token count is unavailable.

## Build variants

The `Ondas` scheme archives the clean `Release` configuration used for App Store/TestFlight
work; that configuration excludes the Mac menu-bar helper. `Ondas Direct` archives the
`Distribute` configuration, including the helper, for direct macOS distribution and
requires the appropriate Developer ID signing, provisioning, and notarization setup.

For Xcode Cloud, configure `ONDAS_DEVELOPMENT_TEAM`,
`ONDAS_MAIN_APP_BUNDLE_IDENTIFIER`, and `ONDAS_MENU_BAR_URL_SCHEME` as workflow
environment variables. `ci_scripts/ci_post_clone.sh` turns them into the ignored local identity
override before generating the project, so cloud archives do not use the public example identity.

## Contributing and support

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and pull-request guidance,
[SECURITY.md](SECURITY.md) for private vulnerability reporting, and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for participation expectations. General
questions and reproducible bugs belong in the
[issue tracker](https://github.com/keegandonley/Ondas/issues).

## License and distribution

Copyright © 2026 Keegan Donley. Unless a file says otherwise, this repository is
licensed under the [GNU GPL-3.0](LICENSE). Contributions are licensed under the same
terms; see [CONTRIBUTING.md](CONTRIBUTING.md).

GPL-3.0 licensing and Apple-platform distribution are separate questions. Whether a
particular App Store, TestFlight, direct-download, or other channel is compatible with
the license and the relevant Apple terms requires a distribution-specific legal and
product decision. This project makes no promise that every channel is available or
appropriate for every build. See [TRADEMARKS.md](TRADEMARKS.md) for the project-identity
policy for forks and modified distributions.
