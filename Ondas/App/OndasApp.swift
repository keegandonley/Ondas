import SwiftData
import SwiftUI

@main
struct OndasApp: App {
    /// Shared CloudKit-synced container so conversations follow the user across devices
    /// with no account or sign-up.
    private let modelContainer = AppModelContainer.make()

    #if targetEnvironment(macCatalyst)
    // Starts/stops the macOS menu-bar agent alongside the app. Catalyst only — iPhone/iPad have
    // no menu bar.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #endif

    init() {
        // Load the user's saved telemetry preference (off by default) into the shared service so any
        // model usage this session can be reported. Fire-and-forget: the actor updates itself.
        let config = TelemetrySettingsStore().currentConfig()
        Task { await TelemetryService.shared.update(config) }

        // CloudKit sync failures are otherwise silent (no throw, no crash) — start observing so a
        // sync problem shows up as a status line in Settings instead of just "chats aren't syncing".
        CloudKitSyncMonitor.shared.start()
    }

    var body: some Scene {
        WindowGroup {
            ConversationListView()
        }
        .modelContainer(modelContainer)
    }
}
