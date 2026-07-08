import CoreData
import Foundation
import Observation
import OSLog

/// Observes Core Data's CloudKit sync-event notifications so a sync failure is visible instead of
/// silently invisible. SwiftData's CloudKit-backed store (`AppModelContainer`, `cloudKitDatabase:
/// .automatic`) is implemented on `NSPersistentCloudKitContainer` under the hood, which still posts
/// `NSPersistentCloudKitContainer.eventChangedNotification` even though the app never touches Core
/// Data directly — this is the only way to observe sync health, since SwiftData exposes no public
/// sync-status API as of iOS 26. Logged via `OSLog` and surfaced as a status line in Settings.
@MainActor
@Observable
final class CloudKitSyncMonitor {
    static let shared = CloudKitSyncMonitor()

    /// Summary of the most recently *finished* sync event (setup/import/export), or nil until the
    /// first one completes. In-progress events (`endDate == nil`) are ignored.
    private(set) var status: String?

    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.keegancodes.ondas",
        category: "CloudKitSync"
    )

    private var isObserving = false

    private init() {}

    /// Starts observing. Safe to call more than once (e.g. app launch and previews) — only the
    /// first call registers the observer.
    func start() {
        guard !isObserving else { return }
        isObserving = true
        NotificationCenter.default.addObserver(
            forName: NSPersistentCloudKitContainer.eventChangedNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let event = notification.userInfo?[
                NSPersistentCloudKitContainer.eventNotificationUserInfoKey
            ] as? NSPersistentCloudKitContainer.Event, event.endDate != nil else { return }
            // Pull out plain Sendable values here rather than hopping to the main actor with the
            // `NSPersistentCloudKitContainer.Event` itself, which isn't `Sendable`.
            let type = Self.label(for: event.type)
            let errorDescription = event.error?.localizedDescription
            Task { @MainActor [weak self] in
                self?.handle(type: type, errorDescription: errorDescription)
            }
        }
    }

    /// A human-readable name for the event type. `NSPersistentCloudKitContainer.EventType` doesn't
    /// print its case name via `String(describing:)` (it renders as
    /// `NSPersistentCloudKitContainerEventType(rawValue: 2)` in practice) — this switch is the
    /// reliable way to label it.
    private nonisolated static func label(for type: NSPersistentCloudKitContainer.EventType) -> String {
        switch type {
        case .setup: return "setup"
        case .import: return "import"
        case .export: return "export"
        @unknown default: return "sync"
        }
    }

    private func handle(type: String, errorDescription: String?) {
        if let errorDescription {
            Self.logger.error("CloudKit \(type, privacy: .public) failed: \(errorDescription, privacy: .public)")
            status = "Sync error (\(type)): \(errorDescription)"
        } else {
            Self.logger.info("CloudKit \(type, privacy: .public) succeeded")
            status = "Up to date (last \(type))"
        }
    }
}
