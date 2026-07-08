import OSLog
import SwiftData

extension ModelContext {
    private static let logger = Logger(subsystem: AppInfo.bundleID, category: "Persistence")

    /// Saves, logging failure instead of throwing. The app-wide policy for non-fatal saves:
    /// the in-memory objects stay correct and the next successful save persists them, so
    /// interrupting the user isn't warranted — but a systemic schema/CloudKit fault would
    /// fail every save, so it must be visible in the log for diagnosis.
    func saveOrLog() {
        do {
            try save()
        } catch {
            Self.logger.error("Failed to save model context: \(error, privacy: .public)")
        }
    }
}
