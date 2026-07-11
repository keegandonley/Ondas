# Privacy

Last updated: July 11, 2026

Ondas is designed so its core chat and image-generation features use Apple's on-device
Foundation Models and Image Playground APIs. The source code does not send prompts or
replies to an Ondas-operated model service, and Ondas has no separate user account or
sign-up system. That does **not** mean that all data always stays on one device: chat
data is configured to sync through iCloud/CloudKit, and optional telemetry can send
data to an endpoint that the user chooses.

This notice describes the behavior of the open-source app. A fork or a separately
distributed build can have different behavior; review its source and release notes
before using it.

## Data stored by the app

Ondas stores the following data locally so it can provide conversations, history,
and the image gallery:

- Conversation identifiers, titles, timestamps, and chat messages, including any
  compaction summaries created for a conversation.
- Generated-image prompts, image data, and timestamps.
- App preferences, including the telemetry on/off setting and its endpoint. A
  telemetry bearer key, if supplied, is stored in the system Keychain rather than
  in the app's preferences.

If the user chooses **Save** for a generated image, Ondas writes that image to the
user's Photos library. The app requests add-only Photos permission for that action;
it does not browse the user's photo library.

## iCloud and CloudKit sync

The production data store is CloudKit-backed. Conversations, message text, generated
image data, image prompts, and their associated metadata may be synchronized through
the private CloudKit database for the Apple Account signed in on the device. This is
what lets a user's data appear on their other devices using the same iCloud account.

CloudKit and iCloud are Apple services, governed by Apple's terms and privacy
practices. Ondas does not operate the CloudKit service or receive access to the user's
Apple Account credentials. Deleting a conversation in Ondas deletes it from the local
store and requests that change be synchronized; the timing of synchronization and any
backup or retention behavior are controlled by Apple.

Fork maintainers should use their own bundle identifiers and CloudKit container. Do
not configure a fork to use the upstream project's container.

## Optional telemetry

Telemetry is **off by default**. No telemetry request can be sent until a user turns
it on, supplies an OTLP endpoint, and supplies a bearer key in Settings. When enabled,
Ondas sends OTLP/HTTP JSON to the user-configured endpoint (with `/v1/traces` appended
to the supplied base URL). Use an HTTPS endpoint that you trust.

The normal telemetry payload can include:

- The app version and the synthetic model name `apple-on-device`.
- A conversation-scoped random identifier, trace/span identifiers, feature name,
  tool name, token counts, and start/end timing.
- For image generation, the `generate_image` tool name and timing; it does not include
  generated-image bytes.

**Send transcripts** is a separate, off-by-default control. When it is enabled as
well, successful text prompts, model replies, and model-generated conversation
summaries are included in telemetry spans. Those contents may be sensitive. The app
does not send transcript content when this setting is off. Turning transcript capture
off removes transcript fields from telemetry waiting in the in-memory retry buffer.

The endpoint operator—not Ondas—determines how received telemetry is stored, used,
shared, and retained. The app retains failed telemetry only in memory during the
current launch, with a bounded queue; it does not write a separate on-disk activity
log. Turning telemetry off stops new telemetry recording and delivery while it is
off, but cannot withdraw data an endpoint has already received. A failed in-memory
event can be retried if telemetry is enabled and configured again later.

## Your choices

- Leave telemetry disabled, or disable it at any time in Settings.
- Enable transcript capture only when you intend to send prompt and reply content to
  the configured endpoint.
- Delete conversations in the app to remove their local records and sync the deletion
  through CloudKit.
- Manage data held by a telemetry endpoint directly with that endpoint's operator.
- Control iCloud and Photos permissions through the device's Settings app.

## Questions

For a question about this notice or a privacy issue in the source code, open a
[GitHub issue](https://github.com/keegandonley/Ondas/issues) without including private
conversation content, credentials, or security-sensitive details. For security
vulnerabilities, follow [SECURITY.md](SECURITY.md) instead.
