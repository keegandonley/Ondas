pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "Ondas"

// :ondaskit is a PURE Kotlin/JVM module on purpose. Ondas has no SPM package for it to
// mirror -- the Swift app is a single target -- but the SPLIT it enforces is the same one
// the app already has internally: Compaction, ConversationTitle, TokenUsage and the
// telemetry encoder are written without touching FoundationModels, SwiftData or SwiftUI,
// which is exactly why OndasTests can cover them at all.
//
// Keeping the Android plugin OFF this module means its tests run on plain JUnit with no
// emulator and no Robolectric, and the compiler mechanically enforces that boundary
// instead of a review having to notice it eroding.
include(":ondaskit")

// The application. ChatEngine lives here rather than in :ondaskit because its whole reason
// for existing is the ML Kit / Gemini Nano boundary, and :ondaskit is the module that is
// supposed to have no platform in it.
include(":app")

// Deferred, and recorded here so the intended shape is on file rather than rediscovered:
//
//   :shared - a design-system / cross-surface module. Scalene and Cadence both have one
//             because each has a SECOND surface consuming it (Glance widgets, Wear OS).
//             Ondas has neither, and its whole design system is Support/Theme.swift: an
//             accent color, two bubble colors and a corner radius. A module for that would
//             be structure with nothing in it. If a widget or a Wear surface is ever
//             ported, the design tokens move out of :app into :shared FIRST -- Glance
//             cannot depend on an application module.
