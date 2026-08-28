# Ondas for Android

A native Kotlin port of the Ondas iOS app, living beside it in the same repo. The two apps
stay **native and separately maintained** — this is not a cross-platform migration.

Read [PORTING.md](PORTING.md) before changing anything. It is the binding document: the
porting rule, the approved decisions, the constraints carried over from the sibling ports,
and the mandatory drifts.

## Module graph

| Module | Plugin | Mirrors |
|---|---|---|
| `:ondaskit` | `kotlin.jvm` (pure JVM, **no Android plugin**) | the platform-free half of `Ondas/Services` + `Ondas/Models` |
| `:app` | `android.application` | `Ondas/Features`, `Ondas/App`, and the ML Kit boundary |

`:shared` is deferred; `settings.gradle.kts` records why.

## Toolchain

- Gradle **9.7.1**, AGP **9.3.2**, Kotlin **2.4.10**
- `compileSdk` / `targetSdk` **37**, `minSdk` **30**
- Gradle runs on **JDK 21** — *not* Android Studio's bundled JBR:
  ```sh
  export JAVA_HOME=/opt/homebrew/opt/openjdk@21
  ```
- There must be exactly **one** Android SDK root: `~/Library/Android/sdk`. A second root
  (from the `android-commandlinetools` cask) means licenses accepted in one are invisible to
  the other, and Gradle silently picks whichever `local.properties` points at.

## Dev loop

```sh
cd android
./gradlew :app:installDebug
./gradlew :ondaskit:test :app:testDebugUnitTest
./gradlew :app:lintDebug
```

The full local gate, which is what CI runs:

```sh
./gradlew :ondaskit:test :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

## Two things that are easy to miss

**Gemini Nano does not exist on an emulator.** Chat inference goes through AICore, which
emulator images do not carry. Anything touching the model has to be verified on the physical
Pixel 11 — and that phone is a device Keegan is actively using, so batch the device work and
ask for it rather than driving it unannounced.

**Every test lives in `src/test`.** There is no `androidTest` source set. Compose UI tests
run on Robolectric in the JVM so CI needs no emulator; if an instrumented test is ever added
it needs its own job with a device and must not be folded into the existing workflow.

## What this port does not include

Image generation (ImagePlayground has no Android counterpart), iCloud sync (storage is
local-only Room), and the macOS menu-bar agent. `PORTING.md § Known unported Swift` is the
authoritative list, including the app icon, which should be generated from the iOS master
rather than hand-cut.
