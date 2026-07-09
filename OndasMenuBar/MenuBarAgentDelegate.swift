import AppKit
import OSLog
import SwiftData
import SwiftUI

/// Owns the menu-bar status item and the popover it toggles. The popover hosts SwiftUI content
/// (`MenuBarChatView`) via `NSHostingController`, giving the native popover chrome — anchored
/// arrow, vibrancy, and transient click-away dismissal — for free.
@MainActor
final class MenuBarAgentDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private let popover = NSPopover()
    private let logger = Logger(subsystem: AppInfo.bundleID, category: "MenuBarAgent")

    /// Retry budget for the first-launch window where the app may be creating the shared store.
    private static let storeOpenAttempts = 5
    private static let storeOpenRetryDelay: TimeInterval = 0.4

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Observe the app's termination FIRST, so we can't miss it during the store-open retries
        // below (a mid-retry quit must still stop the agent).
        observeParentAppTermination()

        // The menu-bar item exists only while the app runs. The agent is also a login item, so it
        // can launch at login without the app — in that case, quit immediately.
        guard isMainAppRunning() else {
            NSApp.terminate(nil)
            return
        }

        // Open the agent's own container on the shared App Group store (its own process, so it
        // can't share the app's live container). `cloudKit: false` — the app is the sole mirror.
        // A headless agent can't usefully `fatalError`, so open gracefully: quit if the store never
        // opens rather than crash with no visible signal.
        guard let modelContainer = openStore() else {
            logger.error("Menu-bar agent could not open the shared store; quitting.")
            NSApp.terminate(nil)
            return
        }
        loadTelemetryPreference()
        configurePopover(with: modelContainer)
        configureStatusItem()
    }

    private func isMainAppRunning() -> Bool {
        NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == AppInfo.bundleID }
    }

    /// Opens the shared store, retrying briefly: on first launch the app may be creating/migrating
    /// it concurrently, which is the one window where a cross-process open can transiently fail.
    private func openStore() -> ModelContainer? {
        for attempt in 1...Self.storeOpenAttempts {
            do {
                return try AppModelContainer.makeThrowing(cloudKit: false)
            } catch {
                logger.notice("Shared store open attempt \(attempt) failed; retrying.")
                Thread.sleep(forTimeInterval: Self.storeOpenRetryDelay)
            }
        }
        return nil
    }

    /// Loads the user's telemetry preference (shared via the App Group) so agent-run turns honor
    /// the same on/off + endpoint the app uses. (The bearer key isn't shared — see `TelemetryConfig`.)
    private func loadTelemetryPreference() {
        let config = TelemetrySettingsStore().currentConfig()
        Task { await TelemetryService.shared.update(config) }
    }

    private func configurePopover(with modelContainer: ModelContainer) {
        popover.behavior = .transient
        popover.animates = true
        popover.contentSize = MenuBarChatView.preferredSize
        popover.contentViewController = NSHostingController(
            rootView: MenuBarChatView().modelContainer(modelContainer)
        )
    }

    private func configureStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.image = NSImage(
                systemSymbolName: "bubble.left.and.bubble.right",
                accessibilityDescription: "Ondas Quick Chat"
            )
            button.image?.isTemplate = true
            button.action = #selector(togglePopover)
            button.target = self
        }
        statusItem = item
    }

    @objc private func togglePopover() {
        guard let button = statusItem?.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            // Re-read the telemetry preference each time the popover opens: the agent loaded it once
            // at launch, but the user may have enabled/reconfigured telemetry (or saved the shared
            // key) in the app afterwards. This is the agent's equivalent of the app re-`update`-ing
            // `TelemetryService` when Settings is saved.
            loadTelemetryPreference()
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .maxY)
            // Make the popover key so the chat composer can take text input immediately.
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    /// The agent accompanies the main app; when the app quits, the agent should too.
    private func observeParentAppTermination() {
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(parentAppTerminated(_:)),
            name: NSWorkspace.didTerminateApplicationNotification,
            object: nil
        )
    }

    @objc private func parentAppTerminated(_ note: Notification) {
        let terminated = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
        if terminated?.bundleIdentifier == AppInfo.bundleID {
            NSApp.terminate(nil)
        }
    }
}
