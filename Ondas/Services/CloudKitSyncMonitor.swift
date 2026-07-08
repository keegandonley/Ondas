import CloudKit
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

    private static let logger = Logger(subsystem: AppInfo.bundleID, category: "CloudKitSync")

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
            let succeeded = event.succeeded
            let errorDescription = event.error.map(Self.describe)
            Task { @MainActor [weak self] in
                self?.handle(type: type, succeeded: succeeded, errorDescription: errorDescription)
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

    /// `error.localizedDescription` alone is close to useless for a `CKError.Code.partialFailure`
    /// (code 2) — it's a *container* error, and the actual per-record reason lives in
    /// `CKError.partialErrorsByItemID`. Unwrap it so the real cause (e.g. a specific record's
    /// constraint violation or quota error) shows up instead of the generic top-level message.
    private nonisolated static func describe(_ error: Error) -> String {
        guard let ckError = error as? CKError,
              let partialErrors = ckError.partialErrorsByItemID,
              !partialErrors.isEmpty
        else {
            return (error as NSError).localizedDescription
        }
        // Multiple records commonly fail for the same underlying reason; de-duplicate before joining.
        let reasons = Set(partialErrors.values.map { ($0 as NSError).localizedDescription })
        return "partial failure — " + reasons.sorted().joined(separator: "; ")
    }

    /// `succeeded` and `error` are independent fields on `NSPersistentCloudKitContainerEvent` — a
    /// failed event isn't guaranteed to carry an `NSError` (e.g. an account/permission change can
    /// end a sync with `succeeded == false` and no error object). Branch on `succeeded` rather than
    /// on error-presence so that case is still reported as a failure instead of silently reading as
    /// success.
    private func handle(type: String, succeeded: Bool, errorDescription: String?) {
        guard succeeded else {
            let reason = errorDescription ?? "no error details provided"
            Self.logger.error("CloudKit \(type, privacy: .public) failed: \(reason, privacy: .public)")
            status = "Sync error (\(type)): \(reason)"
            return
        }
        Self.logger.info("CloudKit \(type, privacy: .public) succeeded")
        status = "Up to date (last \(type))"
    }
}
