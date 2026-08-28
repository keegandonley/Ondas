# contracts/

Wire fixtures that **both** the Swift and the Kotlin test suites decode.

Two native codebases drift silently. Prose parity plans do not stop it; a shared fixture does,
because a wire-shape change breaks one platform's build the moment the other's changes.

Both suites read these files **in place**. Do not copy a fixture into a module — a duplicated
fixture is exactly how the drift this directory exists to prevent gets hidden.

| Reader | How it resolves the path |
|---|---|
| Kotlin (`:ondaskit`) | the `ondas.contracts` system property, set in `android/ondaskit/build.gradle.kts` |
| Swift (`OndasTests`) | `#filePath`, walked up to the repo root |

## Why a change here fires BOTH CI workflows

`.github/workflows/android.yml` includes `contracts/**` in its `paths`, and `ci.yml` does **not**
exclude it. That overlap is deliberate: the entire point is that changing a fixture runs the
platform that did *not* change. Do not "tidy" the filters to make them mutually exclusive — it
would disable the protection while leaving the directory looking guarded.

## What belongs here

Only fixtures a test **actually decodes**. A hand-written fixture that nothing loads is worse than
no fixture: it asserts a wire format nobody verified. (The sibling Scalene port carried two such
files for a month before anyone noticed they described a shape that does not exist.)

## `otlp/llm_span.json`

The OTLP/HTTP JSON payload Ondas POSTs to a user-supplied collector, which coding-stats ingests.
It is the encoding of one `ondas.llm` span with `serviceVersion = "1.0"`.

Load-bearing details, each of which a "cleanup" would plausibly get wrong:

- `startTimeUnixNano`, `endTimeUnixNano` and `intValue` are **strings**, because protobuf JSON
  encodes 64-bit integers as strings. They are not numbers that someone forgot to unquote.
- `kind` is `1` (`SPAN_KIND_INTERNAL`) and *is* a number.
- An attribute value carries **exactly one** of `stringValue` / `intValue`; the other key is
  absent rather than null.
- `service.name` is `ondas` — the label the ingest attributes the source with.

Key **order** is not part of the contract: each platform's encoder chooses it, and the collector
does not care. Both suites therefore compare parsed structures, not bytes.

`apple-on-device` appears here as the model name only because it is the literal value in the
encoding test on both sides. It is a fixture value, not the constant either app reports at runtime.
