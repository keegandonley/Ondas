# Porting Ondas to the web

This is the binding document for the web port. Every subagent brief must point at it.

## The rule

Verbatim from the vault entry that governs this project:

> **The source app is the spec.** Port it faithfully.
>
> Any deviation — behavioral, structural, or visual — **needs Keegan's approval BEFORE it
> lands.** Flag and ask. A deviation that seems obviously better is still a deviation.
> "I judged this was better" is the exact failure mode.

For Ondas, "the source app" is the Swift code in `Ondas/`.

## Scope: the web gets the same investment iOS got

Ondas's efficiency and stability are the product of a lot of accumulated work: the
turn-cancellation hardening, the session-identity guard on the token count, the compaction
generation counter, the drain-on-every-path discipline, the three-state capacity model, the
curated error taxonomy. **Every one of them encodes a bug that was actually hit.**

1. The Swift source is the spec. Port it faithfully.
2. Any deviation needs approval **before** it lands. "I judged this was better" is the exact
   failure mode.
3. Never write an ad-hoc substitute for a component that exists in Swift. Port the component.
4. Never present a reduced-scope option as if it were the faithful one. If an option is a
   fragment of the source behavior, say so plainly.
5. Size is not a reason to cut. A 770-line `ChatEngine` gets a 770-line port.
6. **Test the claim before accepting a platform-limitation excuse, including your own.** On the
   Android port, five of eight claimed platform limits dissolved on contact. On this port the
   opposite also happened — see *sampling* below, where the limit was real and my own first
   reading of the spike was the thing that was wrong.

## Decisions taken at kickoff (2026-08-28, approved by Keegan)

| Decision | Choice |
|---|---|
| Location | `web/` beside the Swift app and `android/`, same repo. CI is path-filtered three ways. |
| Stack | Next.js 15 + React 19 + TypeScript, matching `website/`. App Router, client-only. |
| Image generation | **Cut from web v1.** No browser API exists and none is proposed. |
| Storage / sync | **IndexedDB, local-only.** No account, no backend. |
| Telemetry | **Stubbed** to a no-op interface. No encoder, no exporter, no config types. |
| Settings | **Kept, refilled** with new web-specific rows. See *Approved additions*. |
| Scope | Full parity, phased over specs W1–W8. |

### Why the app is client-only

`LanguageModel` is a `window` global. It is `undefined` in a Worker (verified) and has no server
counterpart, so nothing under `src/chat`, `src/data` or `src/features` can be server-rendered or
moved off the main thread. Next.js is here for the toolchain, routing and deploy story, not for
SSR of chat state.

### Decisions taken autonomously (2026-08-28)

Keegan asked for continuous progress rather than a check-in per decision: *"Continue on your own,
stop pausing and checking in. Next time we chat I want something working to play with."* The calls
below were therefore made without approval. **Each is recorded here precisely so it can be
reverted**, and none is buried in a commit message. This section is the first thing to review.

| # | Call | Reasoning | Cost to revert |
|---|---|---|---|
| D7 | **Keep** the `Assets.xcassets/**` → web.yml CI overlap | It closes a one-directional drift guard. Dropping it also means dropping the `Theme.test.ts` catalog read, which is the only thing tying the web brand to the iOS master. | One line in two workflows |
| — | **Stay on Next 15**, not 16 | It is what was approved, and it matches `website/`. The high-severity postcss advisory it carries is *already present in `website/`*, so this is a pre-existing repo-wide condition, not one the web port introduces. | Low now, higher later |
| D4 | **Hand-write an inline-only Markdown renderer**, porting `android/.../InlineMarkdown.kt`'s semantics | Swift's `.inlineOnlyPreservingWhitespace` renders emphasis/strong/strikethrough/code/links and **no block elements**. Every general-purpose library emits blocks, so "configure one down" means fighting it. Android already matched this behaviour once against the same source; porting a solved 267-line problem beats re-deriving it. | A rewrite of one file |
| D2 | Moot for now | Telemetry is stubbed, so no CORS preflight is ever issued. The question returns with the real exporter. | None |
| D6 | **Implement the empty-reply guard** | Chrome documents no refusal behaviour and an empty string with no error is possible. Swift already treats an empty compaction summary as a failure, so the pattern is ported, not invented. | None |
| — | `website/**` **added** to `ci.yml`'s `paths-ignore` | Pre-existing gap, fixed while cleaning up: a marketing copy change was starting a 45-minute macOS Xcode job. `website/` has no test suite here and deploys from Vercel, so it needs no workflow of its own. | One line |

Everything under *Awaiting approval* below remains genuinely open.

## Module graph

```
src/kit/       pure TS — no DOM, no LanguageModel, no React
  models/      Conversation, ChatMessage, ChatRole
  chat/        Compaction, ConversationTitle, TokenUsage/CapacityState/TurnSignal
  telemetry/   TelemetryService — no-op stub, interface only
src/chat/      ChatEngine, OnDeviceModel (interface), PromptApiModel
src/data/      IndexedDB store + repository
src/features/  chat/, conversations/, settings/
src/design/    Theme
app/           Next App Router shell
```

`src/kit/` is the boundary `:ondaskit` enforces on Android, for the same reason: it is the part
testable without a model or a browser. `vitest.config.mts` runs on the `node` environment
precisely so a stray `document` reference in that layer fails rather than passing under a global
jsdom.

**`OnDeviceModel` is an interface, ported from `android/app/.../chat/OnDeviceModel.kt`.** The
justification carries over exactly: the model exists only in a real Chrome, so an interface is the
only way `ChatEngine`'s turn cancellation, capacity model and compaction-generation guard can be
tested in CI. **`ChatEngine` must never touch `LanguageModel` directly.**

| Swift | Web |
|---|---|
| `Ondas/Models/` | `src/kit/models/` |
| `Services/{Compaction,ConversationTitle}.swift`, `TokenUsage` | `src/kit/chat/` |
| `Services/Telemetry/` | `src/kit/telemetry/` (stub) |
| `Services/ChatEngine.swift` | `src/chat/ChatEngine.ts` |
| `Features/{Chat,Conversations,Settings}/` | `src/features/{chat,conversations,settings}/` |
| `App/AppModelContainer.swift` | `src/data/OndasDatabase.ts` |
| `Support/Theme.swift` | `src/design/Theme.ts` |

## Toolchain traps

Paid for once. **Not re-litigated per file.**

- **A `.tsx` test will not load without `oxc.jsx.runtime` in `vitest.config.mts`.** The root
  `tsconfig.json` sets `"jsx": "preserve"` because Next compiles JSX itself; Vite reads that and
  hands preserved JSX to its own SSR transform, which cannot parse it. Every `.tsx` test file dies
  at load with `RolldownError: Unexpected JSX expression` before a single assertion runs.
  `esbuild: { jsx: "automatic" }` does **not** work under vitest 4 / rolldown — it must be the
  `oxc` key. The symptom looks like a broken test, not a broken config.
- **`vitest.config.mts`, not `.ts`.** With no `"type": "module"` in `package.json`, a `.ts` config
  is loaded as CommonJS and Vite warns about ESM syntax.
- **`vitest run` carries no `--passWithNoTests`, deliberately.** A suite reporting success while
  running nothing is the "tests that cannot fail" pattern; "no test files found" is the correct
  failure.
- **`src/kit` and `src/design` run on the `node` environment**, so a stray `document` reference in
  the pure layer fails rather than passing under a global jsdom. Component tests opt in per file
  with a `// @vitest-environment jsdom` pragma — do not make jsdom the global default.

## The verified Prompt API surface

Measured on Chrome 152 (macOS) from the `https://ondas.keegan.codes` origin, 2026-08-28. This is
the web counterpart of spec #88's on-device Pixel spike. **Reproduce it before trusting any of
it** — the W2 debug probe route exists for that.

**Do not write this API from memory or from a blog post.** Two published facts are wrong:

- The token-accounting properties were renamed. Sessions expose `contextUsage` / `contextWindow` /
  `measureContextUsage()` / `oncontextoverflow` — **not** `inputUsage` / `inputQuota` /
  `measureInputUsage`. `LanguageModel.params()` **does not exist**.
- **`create()` validates nothing.** It accepted `{ totallyMadeUpOption: 12345 }` without error.
  "No error" proves nothing about whether an option works. Verify by behaviour.

| Finding | Value |
|---|---|
| Availability | `"available"` on a plain public origin — no origin trial, no flag, no user gesture. Stable since Chrome 148. |
| Platform | **Desktop Chromium only.** `chrome_android` false, Mozilla *Negative*, WebKit **Oppose**. |
| Other built-ins | `Summarizer`, `Translator`, `LanguageDetector` present. `Writer`, `Rewriter`, `Proofreader` absent — their trials closed before current stable. |
| `contextWindow` | **9216.** Read it from the session at runtime; never hard-code it. |
| Streaming | **DELTAS, not cumulative snapshots.** |
| History seeding | `initialPrompts` accepts role-tagged `system`/`user`/`assistant`; a recall probe answered correctly. |
| Sampling | **Does not exist.** See below. |
| `measureContextUsage` | Does **not** throw on oversize input (returned `20006` for ~20k tokens). |
| Oversize prompt | `QuotaExceededError`, carrying `.requested` / `.quota`. |
| Cancellation | `AbortSignal` works; throws `AbortError`; the aborted turn does not commit to context. |
| Destroyed session | `InvalidStateError`. |
| Concurrent prompts | **Succeed.** No counterpart to Apple's `concurrentRequests`. |
| Workers | `LanguageModel` is `undefined`. Main thread only. |
| Extras | `clone()`, `append()`, `responseConstraint` (JSON schema) all work. |

### Streaming is DELTA — the one that would have been a silent bug

`promptStreaming` emitted `["One", ".", " Two", …]` with a final chunk of `"."`. Apple's
`ResponseStream` yields cumulative snapshots, so Swift's `assistant.text = snapshot` is correct
there and would render a single period here. **Callers concatenate.** An empty final chunk must
not read as an empty reply. Identical to the Android finding.

### There is no sampling control

The docs say `temperature`/`topK` are Extensions-only and the web uses `samplingMode` behind an
origin trial. Measured, nothing works at all:

- `temperature: 0` produced **four different** completions for one prompt. A real temperature 0 is
  greedy and deterministic.
- `temperature: 2.0` was indistinguishable from `temperature: 0`.
- `samplingMode: 'greedy'` produced three different completions.
- `create({ totallyMadeUpOption: 12345 })` was accepted — which is why none of the above can be
  inferred from the absence of an error.

`ResponseStyle`, `GenerationSettingsStore` and the Settings picker are therefore **unported**.
This is the one place where my own first reading of the spike was too optimistic: `create()`
accepting `{temperature: 0.3}` looked like support, and was not.

## Mandatory drifts

Nothing gets on this list without the justification: **a faithful implementation is impossible,
not merely more work.**

1. **No image generation.** No browser API exists and none is proposed — verified across Chrome's
   `/docs/ai/` tree, the webmachinelearning proposals repo, and chromestatus. transformers.js
   cannot do image generation at all; the only working path is ONNX Runtime Web + WebGPU with a
   2.58 GB SD-Turbo download, which breaks what Ondas is. Mirrors Android exactly. *(Approved.)*
2. **No CloudKit.** IndexedDB, local-only. Field names and types stay identical to Swift so the
   model layers stay line-comparable. *(Approved.)*
3. **`ChatMessage.id` becomes a real IndexedDB key path.** Same reasoning as Android's Room drift:
   the CloudKit constraints that forced a defaulted, un-unique `UUID` are gone.
4. **Streaming chunks are deltas.** `assistant.text = snapshot` becomes concatenation.
5. **Inference is main-thread only.** No Worker offload is possible.
6. **No generation options.** `GenerationOptions(temperature:)` has no counterpart that functions.
7. **`navigator.storage.estimate().quota` is synthetic in Chrome** — roughly 10 GiB regardless of
   the real allowance (the probe returned exactly 10242 MB, which is the tell). The *enforced*
   quota is still ~60% of disk. `usage` is real; `quota` is not. **No capacity UI, eviction
   heuristic or "running low" warning may be built on it.**

## Approved additions — new UI with no Swift counterpart

Held to the same bar as a drift: named here, not invented during implementation.

1. **The unsupported-browser state.** Safari and Firefox have no `LanguageModel` at all — a harder
   failure than any of Apple's three unavailable reasons. Key off the capability probe, **never off
   a message string**, for the reason Android's download banner does: rewording the copy would
   otherwise silently remove the state from every browser that needs it.

2. **Settings, rebuilt.** All six Swift rows are cut, stubbed or unportable (iCloud Sync →
   local-only; Response style → no sampling control; the four telemetry rows → stubbed), so the
   sheet would otherwise be empty. It is kept and refilled:

   | Section | Row |
   |---|---|
   | Model | Status — refreshed on `visibilitychange` |
   | Storage | Chats — `estimate().usage` only, **never `quota`** (drift 7) |
   | Storage | Persistent storage — see below |
   | Data | Delete all chats (destructive; needs a confirm) |
   | About | Version |

   **`navigator.storage.persist()` is one-way.** There is no un-persist API, so this is a status
   row plus a "Request" action that disappears once granted — *not* a `Toggle`. A toggle is the
   obvious-looking implementation and it would be a control that cannot be switched back.

   Swift's save-on-any-dismissal behaviour still ports: `.onDisappear(perform: save)` means Done
   and an interactive dismiss save identically.

## What does NOT carry over from iOS

- **App Groups, the `flock` single-instance guard, `0xdead10cc`, Keychain access groups.** All
  exist because a Catalyst app and a separate macOS agent are two processes. The browser has one.
- **CloudKit's schema constraints.** Every property defaulted, no unique attributes, optional
  relationships — all of it exists to satisfy CloudKit. Keep the field names and types identical
  anyway so the two model layers stay line-comparable.
- **The Mac Catalyst `LazyVStack` livelock.** The iOS transcript is a deliberately non-lazy
  `VStack` because `LazyVStack` never converged in a single SwiftUI layout pass with mixed row
  heights. That is a SwiftUI ideal-size measurement problem. **Virtualising the web transcript is
  correct**, the way `LazyColumn` was on Android; porting the workaround would be cargo-culting a
  fix for a bug that does not exist here.

## Known unported Swift

- `Services/ImageGenerator.swift`, `ImageCommand.swift`, `PhotoLibrarySaver.swift`,
  `Support/ImageThumbnail.swift`, all of `Features/Gallery/` (579 LOC), the `GeneratedImage` model,
  `GalleryImageMerger`, `ChatMessage.imageData`, and the `ondas.tool` / `generate_image` span.
  `ondas.feature` stays, so the span can return if image generation ever does.
- `Services/GenerationSettingsStore.swift` and `ResponseStyle` — no sampling control exists.
- `Services/Telemetry/` — stubbed to an interface. `OTLPExporter`, `TelemetrySpan`,
  `TelemetryConfig` and the Keychain secret store are unbuilt.
- `Services/CloudKitSyncMonitor.swift` and the iCloud Sync row — local-only.
- `OndasMenuBar/` (556 LOC), `App/AppDelegate.swift`, `SingleInstanceGuard`, the `ondas-menubar://`
  scheme, `Support/ContainerPreferences.swift`, `SharedSettings` — macOS/multi-process only.
- **App icon and favicon.** Not yet derived. Generate from `Assets.xcassets/AppIcon.appiconset`
  rather than hand-cutting a lookalike, the way Scalene's `GenerateBrandAssets.java` does. Until
  then there is no icon, which is honest.

## Awaiting approval

**D2 — CORS may make web telemetry impossible, not merely unbuilt.** `OTLPExporter` POSTs with an
`Authorization` header, which forces a CORS preflight. A collector that does not return
`Access-Control-Allow-Origin` / `-Headers` for this origin rejects every span, and the page gets no
diagnostic beyond a network failure. Check whether `stats.keegan.codes` sends those headers
**before** scheduling the real telemetry spec — the answer may be "never ships".

**D1 — the OTLP bearer key has no Keychain.** Deferred with telemetry. A browser has neither the
Keychain nor the Android Keystore, so the key would sit in IndexedDB in plaintext, readable by any
script on the origin. Solve before telemetry ships, not during.

**D3 — the capacity constants. → RESOLVED BY MEASUREMENT (2026-08-28).** Taken on Chrome 152
against the real summariser prompt: the summariser condensed an **8570-token** body successfully
and refused a **8998-token** one with `QuotaExceededError`, against a 9216 window. With
`responseTokenReserve = 1024` the limit is 8192 and the 0.8 warning point is 6554 — about 2000
tokens (23%) below the measured ceiling, which is the margin that absorbs prose tokenising less
densely than the test transcript.

So Swift's 0.8 is **kept, because it was measured to be safe here** — not inherited. That
distinction is the whole point of the exercise: on Android the same procedure *killed* the
inherited value (§ A2, where the ported temperature turned out to be illegal). Here it survived.
Full derivation in `src/chat/capacityConstants.ts`; `/probe` reproduces the measurement.

**D4 — inline Markdown.** Swift gets this from one call to `AttributedString(markdown:)` with
`.inlineOnlyPreservingWhitespace`. Android had to hand-write 267 lines (`InlineMarkdown.kt`) to
match. A general Markdown library would emit block elements the iOS app never shows. Either
configure a library down to inline-only or port `InlineMarkdown.kt`'s already-matched semantics.
**This is the single largest hidden cost in the port**; settle it before W7.

**D6 — safety filtering is undocumented.** Chrome documents no guardrail or refusal behaviour, and
it could not be verified from any live page. Swift has curated copy for `guardrailViolation` /
`refusal`; the web may simply return an **empty string with no error**. The port needs an
empty-reply guard — Swift already treats an empty compaction summary as a failure for exactly this
reason, so the pattern exists to copy.

**D7 — the `Assets.xcassets/**` → web.yml CI overlap is a correction to the approved plan, not
part of it.** The plan Keegan approved said web.yml fires on `web/**` **only**. Building
`Theme.test.ts` created a real cross-platform read (the web suite opens the Xcode asset catalog),
which made that filter a one-directional guard: editing the iOS accent would have gone green while
un-branding the web app. The overlap was added to close it, and raised with Keegan in the same
message that reported W1 — but it was documented in the CI table as settled before he answered.
Recorded here so it reads as pending rather than approved. Revert to `web/**`-only if he prefers
the guard dropped, but note that also means dropping the `Theme.test.ts` catalog read.

**D8 — the app opens the most recent conversation on launch; Swift opens nothing.**
`ConversationListView` launches with no selection and shows the "Pick a Chat" placeholder, because
on iPhone the split view is a push stack and the list *is* the first screen. On a desktop
two-pane layout that is a permanently empty half-screen on every launch, so `OndasApp` selects
`existing[0]`. Note it deliberately does NOT consult `reusableEmpty` first: doing so would mint a
fresh "New Chat" on any launch where none happened to be empty, and since that row is then the
newest, the next launch reuses it — an empty thread pinned to the top of the list forever.
Reverting is a two-line change in `OndasApp`.

**D9 — `listConversations` loads every conversation's messages.** Raised by spec W5 against a
brief that leaned the other way, and the argument is right: `Conversation.reusableEmpty` is
*defined* as "the first conversation with no messages", so a sidebar projection with hollow
`messages` arrays would make **New Chat silently reopen the user's most recent thread**, with every
row reading "No messages yet". The cost is bounded (two index scans, one bucketing pass, at most
`Conversation.messageLimit` = 40 messages per thread) and is not N+1. If a sidebar-only projection
is ever wanted it belongs in a new method with its own return type, never as a quietly hollowed-out
`Conversation`.

**D10 — `insertMessage` / `saveMessage` silently DROP writes for a deleted conversation.** Dexie
has no foreign keys, so spec W5 enforces ownership in application code. This covers the exact race
`ChatEngine` guards with Swift's `conversation.isDeleted`: a thread deleted mid-stream whose
end-of-turn commit lands afterwards would otherwise create an orphan row no query can reach.
Swallowing matches Swift's `saveOrLog()`. **Callers must know these are no-ops, not throws.**

**D11 — one delete button per row, where Swift offers three paths.** `ConversationListView.swift`
gives delete via `.contextMenu`, `.swipeActions` and `.onDelete`. On the web a swipe is
undiscoverable with a mouse and neither a swipe nor a context menu is keyboard-reachable or
announced, so a visible per-row button is the primary affordance. It sits at `opacity: 0.55` until
row hover/focus and is never `display: none`, so it stays in the tab order.

**D14 — the `.continuous` squircle is now approximated, not ignored.** Swift's bubble is
`RoundedRectangle(cornerRadius: 20, style: .continuous)` — a superellipse, not the circular arc
`border-radius` draws. Chrome 151 supports `corner-shape: squircle`, which is the same curve
family, so the bubbles now carry it with the plain radius as the fallback. **It is not proven
pixel-identical to Apple's curve** — there is no iOS reference here to measure against — so this
is a good approximation rather than a match. Android still sits on the plain radius, recorded
there as a divergence.

**D15 — accessibility additions with no Swift counterpart.** VoiceOver reads a SwiftUI transcript
directly; the web needs help. Added: an accessible name on the composer (a placeholder is not one
— it disappears on focus and several screen readers ignore it); `role="progressbar"` with live
values on the token meter, which SwiftUI's `ProgressView(value:)` carries for free; and a
visually-hidden polite region that announces the finished reply **once**. That last one is
deliberately not a live region on the transcript itself: `assistant.text` is mutated on every
streamed delta, so a live transcript would be read out letter by letter.

The region clears itself for one frame before re-publishing. A live region only speaks when its
content *changes*, so asking the same question twice and getting the same answer back would
otherwise be announced once and then silently — the blank frame is what makes the repeat land.
`ChatEngine.configure` also resets `lastTurn` now, so a turn can never be announced into a
conversation it did not happen in.

**D12 — `ThemePalette` gained a `destructive` entry with no directly-named Swift counterpart.**
Every other entry transcribes a role the SwiftUI code names outright; this one comes from
`Button(role: .destructive)`, which the OS resolves to `systemRed`. It was added because the
alternative was the rebuilt Settings sheet tinting "Delete all chats" with the token meter's
orange, which reads as a warning rather than a danger. Values are iOS `systemRed` light/dark.

**D13 — storage sizes use decimal units.** `Intl.NumberFormat` unit formatting means `kB` = 1000
bytes; dividing by 1024 under that label is wrong by 2.4%, and by 7.4% at `GB`. So `formatBytes`
divides by 1000. Consistent with what the label claims, and it avoids hard-coded unit strings.

Workers report deviations in their final report; the lead consolidates them here with the Swift
file and line, what Swift does, what the web did, and why — pending a keep-or-revert call.

## Verified end to end (2026-08-28)

Built, served, and driven in a real Chrome 152 — because the Android port shipped a chat screen
with no title bar while 143 tests, mutation testing and an adversarial review all passed.

Working: a real streamed reply from the on-device model; delta concatenation (a multi-sentence
answer arrives whole, not as its last fragment); title derivation from the first user message;
the token meter reading `56 / 8,192`, which is the measured 9216 window minus the derived 1024
reserve; conversation persistence across a full reload; search matching message text as well as
titles; the settings sheet showing usage-only storage and a one-way "Request" rather than a
toggle.

**The anomaly is closed, and it was a real bug.** The very first turn of the very first session
returned the generic failure message and never reproduced. Review found the mechanism: the model
session was built **only** inside `configure`, and only when availability happened to be clear at
that instant. Open a conversation while the model is still downloading and `#session` stayed
`null` forever — the availability refreshes on `visibilitychange` cleared the *banner* but never
rebuilt the session, so `canSend` and the UI both said "ready" while every send failed with the
generic message until the user switched threads and back.

Swift has no such gap: `makeSession(for:)` is a synchronous constructor that cannot fail and is
never gated on availability. The web's `createSession` is async and *can* fail, so a null session
is a web-only state that needs a web-only repair. Fixed by building unconditionally in `configure`
and re-attempting at the point of use in `#send`. Pinned by a regression test that fails against
both the old gating and the removal of the repair.

The lesson worth keeping: **"it didn't reproduce" is not "it didn't happen."** The single
intermittent failure was the only symptom of a bug that would have hit every user whose model was
still downloading on first load — which is every new user.

Two further defects came out of the same review, both now fixed and mutation-pinned:

- **The scroll-gesture attribution used a flat 150ms timer.** Swift tracks the real interaction
  lifecycle (`.tracking` / `.interacting` / `.decelerating`). A flick or trackpad fling whose
  momentum outlasted 150ms released the flag while the browser was still animating the user's own
  scroll, so `autoScroll` was never released and the next streamed token yanked the transcript
  back down under them — the exact failure the design exists to prevent. Now released by
  `scrollend`, with a deliberately generous fallback for gestures that scroll nothing and
  therefore fire no `scrollend` at all.
- **The telemetry test could not fail.** It asserted `inputTokens >= 0` against an implementation
  that clamps with `Math.max(0, ...)` — structurally vacuous. Now asserts exact values across two
  turns, so cumulative-instead-of-marginal accounting and a missing reply subtraction both fail.

**`ChatEngine.logFailure` was missing and is now ported** (`ChatEngine.swift:731-739`). Swift logs
a failed model operation **by case only**, never the error object, because a Foundation Models
error's context can echo prompt fragments into the device log. The web port omitted it entirely,
so the first real failure surfaced as "Sorry, I couldn't finish that." with nothing anywhere
saying which condition produced it. A curated-message mapping is only useful if the unmapped case
leaves a trace. `ModelError.message` is deliberately the content-free `diagnosticLabel`, which is
what makes the log line safe to write.

## Sequencing

| # | Spec |
|---|---|
| W1 | Scaffold, CI, this document. **Done.** |
| W2 | `OnDeviceModel` + `PromptApiModel` + probe route + error taxonomy. **Done.** |
| W3 | `src/kit/` domain layer; `OndasTests.swift` ported 1:1. **Done.** |
| W4 | Telemetry stub. **Done.** |
| W5 | IndexedDB store + repository. **Done.** |
| W6 | `ChatEngine`, including the D3 measurement. **Done.** |
| W7 | UI: conversation list, chat, rebuilt Settings. **Done.** |
| W8 | Branding from the iOS master, a11y pass, squircle corners, single-pane back button. **Done.** |

W3, W4 and W5 own disjoint directories and can run in parallel. W6 and W7 cannot.

## CI path filters

Three workflows, mirror images, with **two** deliberate overlaps. A shared artifact only stops
drift if changing it runs the platform that did *not* change.

| Change | ci.yml | android.yml | web.yml |
|---|---|---|---|
| `Ondas/**` (general) | ✅ | — | — |
| `Ondas/Resources/Assets.xcassets/**` | ✅ | — | ✅ |
| `android/**` | — | ✅ | — |
| `web/**` | — | — | ✅ |
| `contracts/**` | ✅ | ✅ | *(not yet)* |

- **`Assets.xcassets` fires web.yml** because `src/design/Theme.test.ts` reads the accent colorset
  in place. Without it, editing the iOS accent would go green while un-branding the web app.
- **`contracts/**` does not fire web.yml yet.** Telemetry is stubbed, so no web test decodes
  `contracts/otlp/llm_span.json`, and `contracts/README.md` is explicit that a fixture nothing
  loads is worse than no fixture. Add it in the same change that builds the real encoder.
- Do not "tidy" any of these filters into mutual exclusivity. That disables the protection while
  leaving the directories looking guarded.

## Local gate

```sh
cd web
npm ci
npm run typecheck && npm run lint && npm test && npm run build
```

**Do not treat any test count written into this file as current; run the gate.** Totals recorded
in prose go stale within days and then read as a regression when they are only history.

`vitest run` deliberately carries **no `--passWithNoTests`**. A suite that reports success while
running nothing is the "tests that cannot fail" pattern; if it errors with "no test files found",
that is the correct failure.
