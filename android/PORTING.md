# Porting Ondas to Android

This is the binding document for the Android port. Every subagent brief must point at it.

## The rule

Verbatim from the vault entry that governs this project:

> **The source app is the spec.** Port it faithfully.
>
> Any deviation — behavioral, structural, or visual — **needs Keegan's approval BEFORE it
> lands.** Flag and ask. A deviation that seems obviously better is still a deviation.
> "I judged this was better" is the exact failure mode.

For Ondas, "the source app" is the Swift code in `Ondas/`.

## Scope: Android gets the same investment iOS got

Ondas's efficiency and stability are the product of a lot of accumulated work: the
turn-cancellation hardening, the session-identity guard on the token count, the compaction
generation counter, the drain-on-every-path discipline, the three-state capacity model, the
curated error taxonomy. Several of those were caught by smart-critic as blockers before
merge. **Every one of them encodes a bug that was actually hit.**

1. The Swift source is the spec. Port it faithfully.
2. Any deviation needs approval **before** it lands. "I judged this was better" is the
   exact failure mode.
3. Never write an ad-hoc substitute for a component that exists in Swift. Port the
   component.
4. Never present a reduced-scope option as if it were the faithful one. If an option is a
   fragment of the source behavior, say so plainly.
5. Size is not a reason to cut. A 770-line `ChatEngine` gets a 770-line port.
6. **Test the claim before accepting a platform-limitation excuse, including your own.** On
   the Scalene port, five of eight claimed platform limits dissolved on contact.

## Decisions taken at kickoff (2026-08-27, approved by Keegan)

| Decision | Choice |
|---|---|
| Location | `android/` beside the Swift app, same repo. CI is path-filtered so Kotlin changes never trigger Xcode Cloud or the macOS runner, and vice versa. |
| Application id | `com.keegancodes.ondas`, matching the iOS bundle id. |
| Image generation | **Cut from Android v1.** Google ships no on-device image-generation API for third-party apps, and the alternatives (cloud API, bundled diffusion model) each break something Ondas is defined by. |
| Storage / sync | **Room, local-only.** CloudKit has no free, account-free Android equivalent. |
| Scope | Full parity, phased over numbered specs #87–#94. |
| Distribution | As on the Scalene port: `internal` debug-key release signing, path-filtered GitHub Actions, no Play publishing. |
| Module count | **Two, not three** — `:ondaskit` + `:app`, no `:shared`. See below. |
| Room means KSP | Accepted. It is the one new toolchain element in this family of repos. |
| `contracts/` | Justified for exactly one thing: the OTLP payload coding-stats ingests. |

### Why two modules and not three

Scalene and Cadence each have a `:shared` design-system module because each has a **second
surface** consuming it — Glance widgets, Wear OS. Ondas has neither, and its entire design
system is `Support/Theme.swift`: an accent color, two bubble colors, a corner radius. The
deferred module is recorded as a comment in `settings.gradle.kts` so the intended shape is
on file. If a widget or Wear surface is ever ported, the design tokens move out of `:app`
**first** — Glance cannot depend on an application module.

## Module graph

```
:ondaskit  (pure Kotlin/JVM, allWarningsAsErrors)
     |
   :app     (com.keegancodes.ondas)
```

`:ondaskit` has no Swift package to mirror — the iOS app is a single target — but it
enforces a split the app already has internally: `Compaction`, `ConversationTitle`,
`TokenUsage` and the telemetry encoder are written without touching FoundationModels,
SwiftData or SwiftUI, which is exactly why `OndasTests` can cover them at all. Keeping the
Android plugin off the module means the compiler enforces that boundary instead of a review
having to notice it eroding.

`ChatEngine` stays in `:app` because its whole reason for existing is the ML Kit boundary.

| Swift | Kotlin |
|---|---|
| `Ondas/Models/` | `ondaskit/…/models/` |
| `Services/{Compaction,ConversationTitle}.swift`, `TokenUsage`/`CapacityState`/`TurnSignal` | `ondaskit/…/chat/` |
| `Services/Telemetry/` | `ondaskit/…/telemetry/` |
| `Services/ChatEngine.swift` | `app/…/chat/ChatEngine.kt` |
| `Services/GenerationSettingsStore.swift` | `app/…/settings/` |
| `Features/{Chat,Conversations,Settings}/` | `app/…/features/{chat,conversations,settings}/` |
| `App/AppModelContainer.swift` | `app/…/data/OndasDatabase.kt` + `OndasGraph.kt` |
| `Support/Theme.swift` | `app/…/design/Theme.kt` |

## Carried-over constraints

These were paid for once already on the Scalene and Cadence ports. **They are not
re-litigated per file.**

### Toolchain
- `org.jetbrains.kotlin.android` is a **hard configuration failure** under AGP 9, which has
  built-in Kotlin support. The standalone `kotlin { jvmToolchain(n) }` block goes with it on
  Android modules; AGP owns the toolchain. `org.jetbrains.kotlin.jvm` is still correct for
  pure-JVM modules.
- `buildFeatures { compose = true }` without `org.jetbrains.kotlin.plugin.compose` fails
  configuration, even in a module declaring no `@Composable`.
- Gradle runs on **JDK 21**, not Studio's bundled JBR.
- There must be exactly **one** Android SDK root (`~/Library/Android/sdk`). A second root
  from `brew install --cask android-commandlinetools` means licenses accepted in one are
  invisible to the other.
- Robolectric ships no framework jar for compileSdk 37 and its picker refuses rather than
  falling back, failing with a bare `initializationError`. Pinned to `sdk=35`.
- **An XML comment cannot contain `--`.** It fails manifest merging with no line number.
  Bites when documenting an `adb --es` invocation; put those in a KDoc or README.

### Library traps
- `kotlinx.datetime.Instant` is a **deprecated typealias** in datetime 0.8.0 and fails any
  module with `allWarningsAsErrors`. Use `kotlin.time.Instant` / `kotlin.time.Clock`.
  `Month.number` does not exist in 0.8.0; use `month.ordinal + 1`.
- `androidx.security:security-crypto` (EncryptedSharedPreferences) is **deprecated**. Use
  the Android Keystore directly: AES/GCM, `setUserAuthenticationRequired(false)`, IV length
  prefixed into the payload.

### OkHttp's defaults are NOT URLSession's
Only relevant to the telemetry exporter here, but it has bitten both sibling ports and
neither failure is catchable by a MockWebServer test:
- **Timeouts.** `URLSession.shared` inherits 60s; OkHttp's defaults are **10s**. "Neither
  side configures a timeout" does **not** mean parity — compare the DEFAULTS.
- **Per-host concurrency.** `Dispatcher.maxRequestsPerHost` defaults to 5 and counts
  *requests*, applying even over multiplexed HTTP/2. `URLSession` caps *connections*.

Assert both as **configuration values** in a test, because they are introduced by omission
and there is no line of code for a review to look at.

### kotlinx-serialization vs Codable
```kotlin
Json { encodeDefaults = true; explicitNulls = false; ignoreUnknownKeys = true }
```
`encodeDefaults` is the dangerous one: kotlinx **omits** a property whose value equals its
default, so a defaulted version field is never written and every reader then decodes `0`.

Rule for hand-written serializers: **mirror what Swift does.** Where Swift hand-writes
`init(from:)`, hand-write a `KSerializer`; where Swift uses synthesized `Codable`, the
synthesized kotlinx serializer is the faithful counterpart.

### Kotlin cannot add interface conformance from an extension file
Swift's `extension Client: SomeProtocol {}` has no Kotlin equivalent. Methods that must
satisfy an interface have to be **members** of the class. Plan interface membership up
front — an "add it as extension functions later" split does not work once view models need
a fake to program against.

## What does NOT carry over from iOS

- **App Groups / shared containers.** `ContainerPreferences`, the hand-rolled
  `SharedPreferences.plist`, `SharedSettings`, and the whole platform-conditional container
  id problem exist because a Catalyst app and a separate macOS agent are two processes.
  Android has one. Do not port them.
- **The `flock` single-instance guard** and the `0xdead10cc` suspend-while-holding-a-lock
  SIGKILL fall out with the above. Both are iOS/macOS-only failure modes.
- **Keychain access groups.** Same reason.
- **The Mac Catalyst `LazyVStack` livelock.** The iOS transcript is a deliberately non-lazy
  `VStack` because `LazyVStack` never converged in a single SwiftUI layout pass with mixed
  row heights. That is a SwiftUI ideal-size measurement problem; **a `LazyColumn` is correct
  on Android**, and porting the workaround would be cargo-culting a bug fix for a bug that
  does not exist here.
- **CloudKit's schema constraints.** Every property defaulted, no `@Attribute(.unique)`,
  optional relationships — all of it exists to satisfy CloudKit. Room does not require it.
  Keep the field names and types identical anyway so the two model layers stay
  line-comparable; see Mandatory drifts.

## Mandatory drifts

Nothing gets on this list without the justification: **a faithful implementation is
impossible, not merely more work.**

1. **`ChatMessage.id` becomes a real Room `@PrimaryKey`.** SwiftData assigns uniqueness via
   a fresh `UUID` per row precisely *because* CloudKit forbids `@Attribute(.unique)`. With
   CloudKit gone the constraint is gone, and Room requires a primary key. Field names and
   types stay identical. (Spec #91.)
2. **Model availability gains a `DOWNLOADING` state with progress.** iOS's
   `SystemLanguageModel.availability` has three unavailable reasons and no download flow —
   the model is either present or it is not. ML Kit exposes `checkStatus()` →
   AVAILABLE/DOWNLOADABLE/DOWNLOADING/UNAVAILABLE plus `download(): Flow<DownloadStatus>`.
   This is new UI with no Swift counterpart. (Specs #88, #92, #93.)
3. **There is no `LanguageModelSession`, so `makeTranscript` has no counterpart.**
   Conversation history must be assembled into each request rather than seeded into a
   session object. **RESOLVED by spec #88**: history is assembled as a single role-labelled
   `TextPart` ("User: … / Assistant: …"), the system prompt goes in the dedicated
   `SystemInstruction` field, and `PromptPrefix` carries the stable leading portion (~25–30%
   faster). A `List<Content>` was tested and rejected — `Content` has no role and the model
   demonstrably loses track of who said what. See findings §4. This remains the largest
   structural deviation in the port.
4. **Streaming chunks are deltas, not cumulative snapshots.** `assistant.text = snapshot`
   becomes concatenation, and an empty final chunk must not read as an empty reply.
   (Spec #88, verified on device.)
5. **Inference requires the foreground.** AICore returns `BACKGROUND_USE_BLOCKED` whenever
   the device is dozing or locked, even when the activity is still the resumed one. iOS has
   no equivalent restriction, and it forecloses any background model work.

## Spec #88 findings — the verified Gemini Nano surface

Measured on Keegan's Pixel 11 Pro (Android 17 / SDK 37, AICore
`0.release.prod_aicore_20260723.00_RC11`) against `com.google.mlkit:genai-prompt:1.0.0-beta4`.
Reproduce with the debug-only probe: install the debug APK, then
`adb shell am force-stop com.keegancodes.ondas` followed by
`adb shell am start -n com.keegancodes.ondas/.spike.NanoSpikeActivity`, and read logcat tag
`ONDAS_SPIKE`. The force-stop is required — a warm process only re-delivers the intent and
`onCreate` never runs again.

| Probe | Result |
|---|---|
| `checkStatus()` on a fresh device | **`DOWNLOADABLE`**, not `AVAILABLE` |
| `getBaseModelName()` | `nano-v4-full` |
| `getTokenLimit()` | **8192** |
| `isSystemPromptAvailable()` | true |
| `isCachingFeatureAvailable()` | true |
| `isStructuredOutputFeatureAvailable()` | true |
| `isThinkingModeAvailable()` | true |
| Request defaults with nothing set | `temperature=0.0 topK=3 maxOutputTokens=4096 candidateCount=1 seed=0 enableThinking=false` |
| `countTokens` | 18 tokens for a 44-char sentence; **34 with a `SystemInstruction` added, so instructions ARE counted** |
| **Streaming chunks** | **DELTAS, not cumulative** |
| Multi-turn, one `Content` per turn (no roles) | recalled the fact correctly |
| Multi-turn, one flattened role-labelled `TextPart` | recalled the fact correctly |
| `SystemInstruction` steering | "answer in exactly one word" → `Paris` |
| `PromptPrefix` (1622-char shared prefix, 5 samples, medians) | inline **186–190 ms**, prefixed **131–139 ms** → ~25–30% |
| Omitting `temperature` | **is exactly 0.0 / greedy** — proved by varying the seed |
| `temperature` range | **must be 0..1**, `IllegalArgumentException` at build time |
| Response policy refusal | `GenAiException` code **11** |
| Oversize prompt | `GenAiException` code **12**, *"Input text length exceeds the limit"* |
| `countTokens` on that same oversize prompt | **also throws** — returns nothing |
| Empty prompt | no error; the model replies asking for input |

### 1. Streaming is DELTA — this is the one that would have been a silent bug

`assistant.text = snapshot.content` is correct on iOS because Apple's snapshots are
cumulative. Here the chunks were `"One, two"`, `", three, four, five"`,
`", six, seven, eight"`, `""` — each is new text only, and the final chunk is **empty**.
Ported code must **concatenate**, and must not treat an empty final chunk as an empty reply.

### 2. `tokenLimit` is 8192, double the window Ondas is tuned for

`responseTokenReserve = 1024`, `messageLimit = 40`, and the 0.8 warning band were all
calibrated against Apple's ~4k window. They are **not** transferable as numbers. See
Awaiting approval.

### 3. Temperature: no "unset", and a 0..1 range that makes *Creative* illegal

`GenerateContentRequest.Builder.temperature` is `Float?`, but the built request exposes a
primitive `float` defaulting to **0.0**. That 0.0 is not a placeholder for a model default —
proved by holding the prompt fixed and varying the seed, since greedy decoding ignores it:

```
omittedVariesAcrossSeeds=false   explicitZeroVaries=false
hotVaries=true (at 1.0)          omittedEqualsExplicitZero=true
```

Unset **is** greedy. Swift's `GenerationOptions(temperature: nil)` means "the model's own
default" and has nothing to match here.

Worse for the port: **temperature must be between 0 and 1**, enforced with an
`IllegalArgumentException` at build time — note, *not* a `GenAiException`, so a catch written
for the ML Kit error type misses it. Ondas ships *Creative* at **1.3**, which is illegal.
Both style values, not just Balanced, therefore need a decision. See Awaiting approval.

### 4. History assembly: RESOLVED — flatten with role labels; a `List<Content>` loses the speaker

`Content` carries **no role** (unlike the cloud Gemini API — `Content.Builder` exposes only
`addPart`/`parts`/`text`/`image`), and passing `List<Content>` does **not** imply alternating
turns.

The first test planted one fact and asked for it back. Both shapes passed, which meant
nothing: a bag of text answers that correctly whether or not attribution survived. The
discriminating test gives each speaker a different name, so losing roles is visible:

| history: `User: My name is Keegan.` / `Assistant: … My name is Ondas.` | role-less `List<Content>` | flattened, role-labelled |
|---|---|---|
| "What is my name?" (want Keegan) | ❌ "Your name is **Ondas**." | ✅ "Your name is Keegan." |
| "What is your name?" (want Ondas) | ❌ "My name is Gemma 4. It's nice to meet you, Ondas." | ✅ "My name is Ondas." |

**Decision: assemble history as a single role-labelled `TextPart`**, with the system prompt
in the dedicated `SystemInstruction` field. `PromptPrefix` carries the stable leading portion
(~25–30% faster, §5). A `List<Content>` is not a usable transcript.

Note the role-less failure is not mild — the model adopted the user's name as its own and
invented "Gemma 4" for itself. Anything relying on the model knowing who said what (Ondas's
whole rehydration model) breaks silently in that form.

**This is the clearest argument in the port so far for testing the discriminating case.** The
easy test passed on both, and the shape it would have blessed is broken.

### 5. Two "platform limitations" that were not

Both appeared in the first run and dissolved on contact — recorded because the rule says to
test the claim, including your own:

- Every generation probe failed with `GenAiException` code **30**, *"Background usage is
  blocked."* Cause: the device dozed mid-run. The activity was still the resumed one, so
  `ResumedActivity` is not sufficient — **AICore refuses inference whenever the device is
  dozing or locked.** The probe now holds `FLAG_KEEP_SCREEN_ON`.
- `countTokens` with a `SystemInstruction` failed with code **10003 "Tokenization failed"**.
  Same cause. Foreground it works and correctly counts the instruction.

Code 30 is still a genuine and important constraint for the port: **inference cannot run
while the app is backgrounded or the screen is off.** Any future deferred or background work
(a scheduled compaction, a widget, a quick-reply surface) has no path to the model.

### 6. `countTokens` cannot pre-check an oversize prompt

It throws on exactly the input it would be used to guard against, so it is not a usable
"will this fit?" check at the top end. The error message says *"Please check the countTokens
API"*, which is circular. Guarding has to be length-based before the token count is
attempted.

### 7. Error codes for the mapping in spec #92

`GenAiException.getErrorCode()` plus `getRetryDelay()`. Constants of note:
`REQUEST_TOO_LARGE` (12), `BACKGROUND_USE_BLOCKED` (30), `NOT_AVAILABLE`, `BUSY`,
`PER_APP_BATTERY_USE_QUOTA_EXCEEDED`, `NEEDS_SYSTEM_UPDATE`, `AICORE_INCOMPATIBLE`,
`NOT_ENOUGH_DISK_SPACE`.

**Code 11 is the guardrail/refusal counterpart**: *"Generated response doesn't pass certain
policy check."* It checks the GENERATED RESPONSE, not the input, so it arrives after a
call that looked fine. Ondas's curated "I can't help with that request." maps onto it.

It is easier to hit than expected — it fired on "Write a one-sentence story about a fox",
a bland creative-writing prompt. Treat it as a normal outcome, and catch it per-request:
one refusal otherwise aborts whatever loop it lands in.

An empty prompt is **not** an error — the model replies asking for input — so Ondas's
client-side empty guard must stay.

## Spec #89 notes — `:ondaskit` domain layer

**Test coverage is 15 of 22, not "all".** `OndasTests/OndasTests.swift` holds 22 tests (the
port plan said 20; that was miscounted). Seven cover features cut from v1 and have nothing to
test here: four `ImageCommand` parsing tests and three `GalleryImageMerger` tests. The other
15 are ported with their exact boundary values intact — 2457/2458 against 3072 for the warning
band, and 31/32/39/40/45 for the message-count fallback.

**Two tests were ADDED**, covering a divergence that exists only on this platform. Swift's
`String.count` and `prefix(_:)` walk grapheme clusters; Kotlin's `length` and `substring` walk
UTF-16 code units. A naive port does not merely count emoji differently — it can cut a
surrogate pair in half and put a broken character in a user-visible title. `ConversationTitle`
therefore truncates via `BreakIterator`, which is the unit Swift uses.

Both added tests are **mutation-verified**: replacing the `BreakIterator` calls with
`length`/`substring` fails both, and the real implementation passes both. The first version of
the surrogate test did *not* fail under that mutation — with `"👩‍🚀"` repeated, the naive cut
landed on a ZWJ boundary and the bug hid. It needed a one-character offset so index 40 falls
inside a pair. A test that cannot fail is worse than no test, so it is worth checking that an
added test actually discriminates rather than assuming it does.

### Approved deviation (2026-08-27): SwiftData/CloudKit relationship ceremony is not ported

Caught by review as an **unrecorded** deviation, and correctly — the rule says a deviation that
seems obviously better is still a deviation. Approved by Keegan after the fact; recorded here
so it reads as a decision rather than an oversight.

Two fields exist in the Swift models only to satisfy SwiftData + CloudKit:

| Swift | Android | Why |
|---|---|---|
| `Conversation.messages: [ChatMessage]?` | `messages: List<ChatMessage>` (non-null) | CloudKit requires optional to-many relationships. Swift itself reads it as `(messages ?? [])` everywhere, so absent and empty already mean the same thing. A nullable list would force `?: emptyList()` at every call site to encode a constraint that no longer exists. |
| `ChatMessage.conversation: Conversation?` | omitted | The SwiftData inverse back-reference. Room models ownership with a foreign key on the message row, so this lands as `conversationId` at spec #91 rather than as an object reference here. |

This narrows the "keep the field names and types identical anyway" rule above: it applies to
fields carrying **data**, not to relationship plumbing whose shape was dictated by the
persistence framework. The data fields — `id`, `title`, `createdAt`, `updatedAt`, `roleRaw`,
`text`, `isError`, `isCompactionSummary` — remain identical.

**Shape divergences forced by immutability and by the image cut**, none of them judgement
calls:

- Models are immutable `data class`es where Swift has mutable `@Model` reference types. Compose
  cannot see in-place mutation, so state is replaced rather than edited.
- `ChatMessage.isEmptyPlaceholder` drops Swift's `!hasImage` clause and
  `Conversation.previewText` drops its "Image request"/"Generated image" branch — with images
  cut, neither case can arise. Absent, not dead.
- `Conversation.reuseEmptyOrCreate` is not here: it needs a persistence context and lands with
  Room at spec #91.
- `Conversation.MESSAGE_LIMIT` (40) and `TokenUsage.WARNING_FRACTION` (0.8) are ported as-is
  but flagged **provisional in their own KDoc**, pointing at A1 — they encode a ~4096-token
  window and Nano's is 8192.

## Spec #90 notes — telemetry and the shared contract

**All 12 tests in the Swift file ported**, plus **1 new test added to BOTH suites** (the shared
contract fixture) and **3 Kotlin-only additions**. The Kotlin suite therefore has 16 telemetry
tests and the Swift file now has 13. The Kotlin-only additions each cover something that cannot be
observed the way the Swift tests observe it:

- the trace id equals the dashless lowercase UUID — Swift reads `uuid_t`'s raw bytes, this port
  reads the two `Long` halves, and a byte-order slip would still produce 32 valid hex characters
  while silently splitting one conversation across two traces;
- the transport configuration, asserted as **values** rather than behaviour (see below);
- `v1/traces` appended exactly once whether or not the user's URL ends in a slash.

### Two concurrency bugs the port introduced, both caught in review

Neither is a deviation to approve — they were defects, and they are fixed. Recorded because both
are shapes that will recur elsewhere in this port.

**1. `defer` is immune to cancellation; `finally { mutex.withLock { … } }` is not.** Swift's
`defer { isFlushing = false }` is a synchronous assignment. The Kotlin cleanup called a
*suspending* function, and a coroutine cancelled mid-POST resumes a contended `lock()` straight
into `CancellationException` — so the reset would never run and this app-scoped exporter would
refuse to drain for the rest of the process's life. Fixed with `withContext(NonCancellable)`.
**General rule for the rest of the port: any Swift `defer` that mutates state maps to a Kotlin
`finally` that must not suspend, or must be wrapped in `NonCancellable`.**

**2. Android-only hazards have no Swift counterpart to port.** `KeystoreSecretStore.secretKey()`
creates the key on first use, and two concurrent first calls could both generate under the same
alias — the second silently replacing the first, making anything already encrypted undecryptable,
which `secret()` then quarantines. Silent credential loss, not a crash. Swift's Keychain has no
key-generation step at all, so there was nothing in the source to port faithfully *from*: reading
the Swift line by line cannot surface this class of bug. Fixed with a process-wide lock, since the
alias is process-wide.

**No regression test guards either one**, and that is deliberate rather than an oversight.
Reproducing the first needs the mutex contended at the exact moment a cancelled coroutine reaches
cleanup, and the second needs two threads inside first-use key generation; neither is
deterministic. A test that cannot actually fail on the bug it names is worse than none — the
`contracts/` fixture in this same spec was exactly that until it was mutation-tested. The IV
framing, which *is* deterministic logic, was extracted to pure functions and does have tests.

### `contracts/otlp/llm_span.json` — and the mutation test that saved it

Both suites now decode the same file: `TelemetryTest.encoder output matches the shared contract
fixture` and `TelemetryTests.encoderOutputMatchesSharedContractFixture`. Structural comparison,
not bytes — key order is each encoder's artifact and means nothing to the collector.

**The first version of this was worthless and looked fine.** Mutating the fixture (unquoting the
64-bit `intValue`, the exact "cleanup" a future reader might attempt) left *both* suites green:

- Gradle considered `:ondaskit:test` up-to-date, because the fixture lives outside the module and
  was not a declared task input. The suite "passed" in 10s without executing.
- The `xcodebuild -only-testing` selector was missing the `()` on the Swift Testing test name, so
  it matched nothing and reported `TEST SUCCEEDED` for running zero tests.

Fixed by declaring `contracts/` as a test `inputs.dir`. After that the mutation fails both suites,
which is the only evidence that the contract does anything. **A fixture nobody's build re-runs is
worse than no fixture** — it asserts a wire format nobody verified, exactly the failure the sibling
Scalene port recorded.

Two lessons worth carrying: a green suite that finishes suspiciously fast has not necessarily run,
and `-only-testing` reports success when its selector matches nothing.

### Approved deviations (Keegan, 2026-08-27)

**`llm.model_name` reports the real model, not a synthetic constant.** Swift hard-codes
`"apple-on-device"` only because `SystemLanguageModel` exposes no name; ML Kit's
`getBaseModelName()` does (`nano-v4-full`). Android reports that. Consequence to be aware of when
reading coding-stats: the value **changes as Google ships new Nano versions**, so Android usage
will fragment across model names over time where iOS stays one label. That is accepted — the real
name is the more truthful datum, and the grouping can be collapsed at query time if it ever
matters. `TelemetryService` takes `modelName` as a constructor parameter with no default, so the
value is chosen once at wiring time rather than defaulted somewhere quiet.

**`unixNano` uses exact integer arithmetic.** Swift multiplies a `Double`
`timeIntervalSince1970` by 1e9; for present-day instants that exceeds the 53-bit mantissa and
quantises timestamps to ~256ns. Reproducing it would mean writing the imprecision deliberately.
Android is exact, iOS keeps its quantisation, and the divergence is invisible to any consumer of
a span timestamp.

### Faithful, with the divergences named

- **Transport timeouts are set explicitly to 60s** even though Swift sets none, because
  `URLSession.shared` inherits 60s and OkHttp's own default is 10s. Asserted as configuration in
  `HttpClientConfigTest`-style tests, since MockWebServer answers instantly and can never observe it.
- **The exporter's mutex is deliberately released across the POST.** Swift's `actor` serialises
  state but is reentrant across `await`, and the `isFlushing` guard exists *because* of that
  reentrancy. Holding a Kotlin mutex across the network call would serialise callers, quietly make
  `isFlushing` dead code, and change the very behaviour the guard was written for.
- **`post` runs on `Dispatchers.IO`.** OkHttp's `execute()` blocks its thread where Swift's
  `urlSession.data(for:)` is a real suspension point; without this a chat turn could block the
  main dispatcher.
- **`TelemetryService` is graph-owned, not a `static let shared`** — consistent with the hand-wired
  container, and it lets a test build one without a global.
- **`recordToolCall` is ported although nothing calls it.** The only tool on iOS is image
  generation, which is cut; it is part of the coding-stats contract and re-deriving it later is
  worse than carrying it.

## Spec #91 notes — Room

**KSP publishes no release for Kotlin 2.4.x.** The newest is 2.3.11, which reads like a hard
blocker for Room and is not: KSP2 is decoupled from the compiler internals it used to track, and
2.3.11 configures and runs against Kotlin 2.4.10 + AGP 9. Established by trying it. Taking the
version numbers at face value would have sent this port to SQLDelight or a hand-rolled SQLite
layer for no reason — the same "test the claim before accepting a platform limitation" rule that
dissolved two false limits during the #88 spike.

**Timestamps are stored as epoch NANOSECONDS, not millis.** `ChatEngine` inserts the assistant
placeholder at `user.createdAt + 0.001s` so a turn pair sorts deterministically. At millisecond
resolution that offset is a single tick and any rounding collapses the two into one instant,
making turn order depend on insertion order instead of the timestamp. A regression test round-trips
the sub-millisecond offset.

**A redundant line with a confident, wrong comment was removed.** The database originally installed
a `PRAGMA foreign_keys=ON` callback, on the reasoning that raw SQLite has foreign keys off by
default so the `CASCADE` would silently do nothing. Raw SQLite does — but **Room enables them
itself on every connection it opens.** Found by mutation: deleting the callback left every test
green, and deleting `onDelete = CASCADE` broke the cascade test immediately. So the constraint is
enforced and the test is real; the callback was ceremony, and its comment asserted a danger that
does not exist here. Worth recording because a confident comment is harder to delete later than
the code it justifies.

Everything else ports directly: newest-activity-first ordering, cascade delete, `reuseEmptyOrCreate`
(the CloudKit reason is gone, the user-visible one — a list of identical "New Chat" rows — is not),
and the `saveOrLog` non-fatal write policy, funnelled through one `write()` helper so a caller
cannot accidentally adopt a different one.

## Spec #92 notes — ChatEngine

### A1 resolved: the capacity constants are now derived, and the derivation is tested

Measured on the Pixel 11 by growing a synthetic transcript until the summariser failed:

| summariser input | outcome |
|---|---|
| 527 / 1,017 / 1,997 / 2,977 / 3,957 / 5,959 tokens | summarised fine |
| ~7,900 tokens (160 turns) | `GenAiException` code 12 |

So the one-pass ceiling is **at least 5,959 tokens**. The band must fire below it, or the user is
offered a Continue button that cannot work — the same dead end the band exists to prevent,
reached from the other side:

```
WARNING_FRACTION * (tokenLimit - reserve)  <=  summariser ceiling
0.8              * (8192       - 1024)     =   5,734  <=  5,959   ✓   (~4% headroom)
```

The reserve lands back on Swift's 1024. That is a coincidence worth stating plainly: it is now the
**output of that inequality** rather than a constant inherited from a model with half the window,
and `CapacityDerivationTest` asserts the inequality so a future change to either side fails a test
instead of silently offering a compaction that errors.

### The session-identity guard has no object to hang off

Swift guards slow work with `self.session === session`, because the engine is reused across
conversations and a token count started on one thread must not commit onto another. There is no
session object here, so the same guard is a monotonic `sessionGeneration` bumped on every
`configure` to a new conversation. Same property, different mechanism.

### Two `defer` blocks became `NonCancellable` `finally` blocks

Applying the rule spec #90 produced. `send`'s cleanup deletes an empty placeholder or persists
partial text, and `performCompaction`'s clears the compaction flag — all of it suspending work that
a cancelled coroutine would otherwise skip, where Swift's `defer` cannot be skipped.

**Honest limit on the test coverage:** mutating `NonCancellable` away leaves the suite green. The
suite runs Room on direct executors (see below), which removes the suspension points cancellation
needs to be observed. The test that names cancellation says so in its own doc comment rather than
implying a guarantee it does not provide.

### A test-infrastructure bug that made correct code look broken

Room's suspend DAO functions dispatch onto Room's **own** query executor, outside a `TestScope`'s
virtual time. `advanceUntilIdle()` therefore returned while database work was still in flight, and
a test asserting "a second submit while responding is ignored" failed — not because the guard was
wrong, but because `isResponding` had not been set yet. Fixed by giving the in-memory test database
direct executors. Worth knowing before debugging the engine's logic on the strength of a red test.

### Verified by mutation

- Concatenating stream deltas instead of assigning them: mutating `append` to `set` fails two
  tests. This is the Apple habit (`snapshot.content` is cumulative there) and the single most
  likely thing to be "corrected" back into a bug.
- The compaction marker is appended last and empties the live segment.
- Failures log a case label only, never content that could echo the prompt.

### Not ported

`generateImage` and the whole `asImage` branch of `send` — image generation is cut. `send` therefore
takes no `asImage` parameter, and the `ondas.tool` telemetry span has no caller (it is still ported;
see spec #90 notes).

## Specs #93/#94 notes — UI, and what only a device caught

### Two defects that 143 passing tests did not see

Both found by taking one screenshot of the running app. Both structural, neither subtle once seen.

1. **Everything rendered under the status bar.** `enableEdgeToEdge()` was on and nothing in the
   tree consumed insets, so the first message bubble sat on top of the clock and the wifi/battery
   icons. Invisible to the whole suite, because **Robolectric composes without system bars** — a
   screen test cannot fail on an inset bug. Fixed with `windowInsetsPadding(WindowInsets.safeDrawing)`
   at the root.
2. **The chat pane had no app bar at all** — no title, no way back. `ChatView.swift:73-74` sets
   `.navigationTitle(conversation.title)` + `.navigationBarTitleDisplayMode(.inline)`, and
   `NavigationSplitView` supplies that bar for free when the detail is pushed. Compose does not, so
   it has to be drawn, and it was simply missing.

The second is the sharper lesson. **The chrome fell in the seam between the two parallel agents
even though the brief assigned it explicitly** — the chat agent reasonably treated the bar as the
shell's, the shell agent reasonably treated the chat pane's contents as the chat agent's. Naming an
owner was not sufficient; what was missing was anyone looking at the result. The Cadence port
recorded this same failure and its fix was "name an owner"; this port shows that is only half of it.

The back affordance shows only when the layout is single-pane, matching `NavigationSplitView`: on a
two-pane tablet the list is already on screen.

### Branding: generated from the iOS master, never hand-cut

`android/tools/GenerateBrandAssets.java`, run as `java tools/GenerateBrandAssets.java ..` from
`android/`. Same approach as the sibling Scalene generator, and the same reason: the iOS icon is
the source of truth, so a change there is re-run rather than re-drawn.

It reads `Ondas/Resources/Assets.xcassets/AppIcon.appiconset/OndasIcon.png` and emits
`ic_launcher_foreground.png`, `ic_launcher_monochrome.png` (Android 13+ themed icons) and
`brand_colors.xml`.

**Why it is not just a resize.** An adaptive icon is a 108dp canvas of which only the central 66dp
is guaranteed visible; launchers mask the rest. The iOS master is full-bleed with the mark filling
~73% of it, so dropped in raw a circular mask clips the wave crests. The generator measures the
mark's true bounds (x=143..879, y=134..888), keys out the sampled background (`#F5FAFD`) with a
soft alpha edge rather than a hard threshold — a hard cut leaves the antialiased boundary ringed
with near-white pixels, glaring against a dark wallpaper — and rescales into the safe zone.

Colours are read from the asset catalog, not matched by eye:

| | light | dark |
|---|---|---|
| accent | `0.400, 0.361, 0.949` → **#665CF2** | `0.545, 0.510, 0.976` → **#8B82F9** |
| launch background | **#FFFFFF** | `0.063, 0.067, 0.075` → **#101113** |

Two things that look like mistakes and are not:

- **The accent is violet while the icon is blue and cyan.** That is how iOS ships — the accent
  tints controls, the icon is its own artwork. Do not "reconcile" them.
- **Dynamic colour is off.** Material You would reseed the scheme from the user's wallpaper, making
  the user bubble a different colour on every phone and discarding the brand colour the app is
  identified by. Both sibling ports made the same call. If it is ever wanted it belongs behind a
  setting, not as the default.

The dark surface is the launch background, so the window the system paints before Compose starts
matches the first frame Compose draws instead of flashing a different colour.

### Review fixes, and a claim that had to be retracted

The combined #93/#94 review returned FAIL. What it found, and what happened:

- **An unsent draft was lost on rotation.** The composer used plain `remember`, and `MainActivity`
  declares no `configChanges`, so a rotation destroyed it. Swift's composer survives rotation for
  free, so this was a straight regression. Now `rememberSaveable`, with a `StateRestorationTester`
  test that fails under the old code. **Nothing in the suite exercised a recreate cycle at all**,
  which is why a whole class of state-restoration bugs could pass unnoticed.
- **`ChatEngine` never applied its own writes to its own state**, relying on a Room round-trip via
  the shell's observer. Two traced consequences: a just-sent message briefly absent from the
  transcript while the composer had already cleared, and — worse — `refreshTokenUsage` reads state
  synchronously, so the capacity meter could be computed from a conversation missing the turn that
  just finished, leaving a stale "approaching capacity" with nothing scheduled to re-check it.
  Writes now apply locally first; the store stays the source of truth and reconciles. Two tests
  fail without it.
- **A claim in the spec record was false.** Spec #93's notes said there was screenshot coverage via
  a `captureToPng` harness. There was none anywhere in the repo — it came from the implementing
  agent's report and was recorded without being checked. Corrected in the spec, and the harness has
  since been built for real (below).

### The screenshot harness, built because its absence was the actual gap

`app/src/test/.../testing/ScreenshotHarness.kt` renders a composable to a real PNG under
Robolectric's `GraphicsMode.NATIVE`, headlessly, into `app/build/screenshots/`.
`ChatScreenshotTest` covers six states: normal, the warning band, full, the download banner, a
compacted conversation, and a streaming reply.

It exists because **two obvious visual defects shipped past 143 passing tests** — everything
rendering under the status bar, and a chat pane with no app bar. A finder-based Compose test
asserts that nodes exist, not that the result looks like anything, so neither was catchable.

**What it does not prove, stated so the next reader does not over-trust it:** a screen that renders
here has still not been seen on a phone. Notably the inset bug **would still not fail here**,
because Robolectric composes without system bars. This narrows the gap; it does not close it. Look
at the device before claiming a screen works.

### Duplicated user-facing copy, consolidated

`MODEL_DOWNLOADABLE_MESSAGE` was independently declared in both `ChatEngine` and `ChatScreen`,
coupled only by a test, and the capacity banner re-typed the literal `"New Chat"` instead of the
shell's `NEW_CHAT_ACTION`. Both now have one home. The download button no longer depends on the
string at all — it keys off `ChatEngineState.modelStatus` — but two copies of user-facing copy
still drift.

### Icons: RESOLVED — use the dependency (Keegan, 2026-08-27)

Material3 1.4.0 dropped its transitive dependency on `material-icons-core`, so `Icons.Default.*`
is not on the classpath by default. The two parallel agents hit that wall independently and
resolved it in opposite directions: the chat agent verified the absence and hand-drew its glyphs on
`Canvas`; the shell agent added the dependency and used it for nine icons. The addition was
unapproved and left the app with two strategies — plus comments in the chat code confidently
explaining the dependency was unavailable, a few files from nine usages of it.

Keegan's call: **keep the dependency.** The jump-to-bottom chevron is now
`Icons.Filled.KeyboardArrowDown` and the send button is `Icons.AutoMirrored.Filled.Send`.

**One glyph is still drawn, and deliberately.** `Stop` is **not in `material-icons-core`** —
verified against the artifact rather than assumed; it ships only in `material-icons-extended`,
which is a far larger dependency to add for one square. `Close` was rejected as a substitute
because an X means dismiss, not stop, and the composer's stop button is the cancel affordance for
a running turn. So `drawStopSquare` stays, with that reasoning in the code.

Worth noting the shape of the check: "use the dependency" sounded like it eliminated the `Canvas`
code entirely, and it did not. Listing the artifact's actual contents took a minute and avoided
either pulling in `-extended` unnecessarily or shipping a semantically wrong icon.

### Considered and DECLINED: the two review refactors (Keegan, 2026-08-28)

Review flagged two code-quality items. Both were costed and neither is being done. Recorded here
so they are not re-raised as open work every time someone reads this file.

**1. Break up `ChatEngine.send()` and `performCompaction()`.** Declined, for two reasons.

`send()` is a faithful port of Swift's `send()`, and this document values the two staying
comparable so a fix to one maps onto the other. **Splitting it is itself a structural deviation
from the source** — the review flagged it on general code-quality grounds without weighing that.

More importantly: **the suite cannot protect a refactor of this file.** Several of its guards are
deliberately untested — the `NonCancellable` wrappers cannot be mutation-caught, because the
harness runs Room on direct executors and that removes the suspension points cancellation needs to
be observable. Each of those guards encodes a bug that was actually hit. A refactor could silently
drop one and the whole suite would stay green, which is the worst possible failure mode for
"cleanup" work on the file where the port's stability lives.

**2. `SettingsController` fragments state into 7 `mutableStateOf` properties** rather than the
single-snapshot pattern used everywhere else. This one is genuinely safe to change — it has no
Swift counterpart at all (Swift keeps that state as `@State` inside `SettingsView`), so reshaping
it would cost nothing in fidelity. Declined as part of the same call; the inconsistency stands.

**If either is revisited**, the procedure is: refactor, run the gate, then re-run every mutation
recorded in the spec #92 and #93 notes and confirm each still fails. A guard whose mutation stops
failing was eaten by the refactor.

## Sequencing (Keegan, 2026-08-27)

Specs run **straight through in order: #91 → #92 → #93**, with no interim debug chat screen.

A crude debug-only harness on top of #92 was offered and declined. The first build worth opening
on a phone is therefore #93; before that, on-device verification is driven programmatically and
read from logcat, the way the #88 spike was. Recorded because "there is nothing to install yet"
looks like a gap in the plan when it is a deliberate ordering: #89 and #90 needed no device and
locked the coding-stats wire contract before the rest of the port could drift from it.

## Awaiting approval

Both raised by spec #88. Neither is a judgement I should make.

**A1 — the capacity constants, now that the window is 8192 rather than ~4096. DECIDED:
re-derive from the compaction summariser's actual headroom** (Keegan, 2026-08-27), rather
than keeping the literal numbers or rescaling the ratios.

That measurement cannot be taken until the summariser exists, so it is **a required task of
spec #92**, not a number to guess now. The procedure: build the live segment up to a series
of known token counts, run the summariser at each, and find the largest live segment it can
condense in one pass without hitting code 12. `responseTokenReserve` and the warning fraction
are then derived from that ceiling — which is the relationship the 0.8 band was always
standing in for. Until it is measured, do not hard-code a warning fraction; leave the constant
named and unset so an unmeasured value cannot quietly ship.

**A2 — what the three response styles map to. DECIDED: Precise 0.3 / Balanced 0.7 /
Creative 1.0** (Keegan, 2026-08-27).

The route there is worth keeping, because it is the shape of a whole class of porting
question. The first instinct was "measure Nano's own default and match it, preserving the
intent of `nil` rather than its value" — the faithful-looking answer. Measurement killed it:
there is no model default to match, unset is greedy 0.0, and the legal range 0..1 makes
*Creative* 1.3 illegal as well. So only *Precise* 0.3 ported unchanged, and the other two
had to be chosen outright.

`ResponseStyle.balanced` therefore maps to a real number on Android where it maps to `nil`
on iOS. That is a deliberate, approved behavioural divergence, not an oversight — a reader
comparing the two files will see it and should not "fix" it.

Workers report deviations in their final report; the lead consolidates them here with the
Swift file and line, what Swift does, what Android did, and why — pending a keep-or-revert
call.

## Known unported Swift

- `OndasMenuBar/` (556 LOC), `App/AppDelegate.swift`, `SingleInstanceGuard`, the
  `ondas-menubar://` scheme — macOS-only.
- `Services/ImageGenerator.swift`, `ImageCommand.swift`, `PhotoLibrarySaver.swift`,
  `Support/ImageThumbnail.swift`, all of `Features/Gallery/` (579 LOC), the
  `GeneratedImage` model, `GalleryImageMerger`, and `ChatMessage.imageData` — image
  generation is cut from v1.
- `Services/CloudKitSyncMonitor.swift` and the iCloud Sync row in Settings — local-only.
- `Support/ContainerPreferences.swift`, `SharedSettings` — see "does not carry over".
- The `ondas.tool` / `generate_image` telemetry span — falls out with image generation.
  `ondas.feature` stays, so the span can return if image generation ever does.
- **App icon and accent color.** Not yet derived. Scalene generates every Android brand
  asset from the one iOS master via a measurement-verified generator
  (`android/tools/GenerateBrandAssets.java`) that fails the build if the mark's proportions
  drift. Ondas should do the same from `Assets.xcassets/AppIcon.appiconset` rather than
  anyone hand-cutting a lookalike. Until then the launcher shows the system default, which
  is honest — a hand-drawn approximation would not be.

## The device constraint

**Gemini Nano needs AICore, and an emulator does not have it.** Specs #88, #92 and #93
cannot be signed off without the physical Pixel 11. Everything else — `:ondaskit`, Room,
telemetry, Compose rendering under Robolectric — runs headless.

Keegan's phone is a device he is actively using, not test hardware. Batch the device work
and ask for it; do not grab the phone. `adb` actions that grab focus, force-stop apps or
change settings interrupt him, and a screenshot may capture what *he* is doing.

## Local gate

```sh
cd android
./gradlew :ondaskit:test :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

**Do not treat any test count written into this file as current; run the gate.** Totals
recorded in prose go stale within days and then read as a regression when they are only
history.
