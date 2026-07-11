import Foundation
import OSLog

/// Guarantees that only one menu-bar agent process runs at a time.
///
/// The agent can be started twice in a single session: the `SMAppService` login item launches it at
/// login, and the Catalyst app also opens `ondas-menubar://` to start it in the current session
/// (`SMAppService` only guarantees a launch *at login*). macOS does not de-duplicate a background
/// `.accessory` (`LSUIElement`) app across those two launch paths, so without a guard both instances
/// survive and the user sees two identical menu-bar icons.
///
/// The lock is an advisory `flock` on a file in the shared App Group container. Whichever process
/// acquires the exclusive, non-blocking lock first wins and holds it for its entire lifetime; any
/// later instance fails to acquire it and exits. This is race-free even when both instances launch
/// in the same instant — unlike enumerating `NSRunningApplication`, where each process can start
/// before the other appears in the list and both then believe they are alone.
enum SingleInstanceGuard {
    private static let logger = Logger(subsystem: AppInfo.bundleID, category: "MenuBarAgent")
    private static let lockFileName = "menubar-agent.lock"

    /// Attempts to become the sole menu-bar agent. Returns `true` if this process now holds the lock
    /// and should proceed; `false` if another instance already holds it and this process must exit.
    ///
    /// Fails open (returns `true`) when the shared container or lock file is unavailable: a rare
    /// duplicate icon is a lesser evil than an agent that can never show its menu-bar item at all.
    static func acquireLock() -> Bool {
        guard let lockURL = lockFileURL() else {
            logger.error("No shared container for the single-instance lock; proceeding without it.")
            return true
        }

        let descriptor = open(lockURL.path, O_CREAT | O_RDWR, 0o644)
        guard descriptor >= 0 else {
            logger.error("Could not open the single-instance lock file; proceeding without it.")
            return true
        }

        if flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
            // Capture errno before `close`, which can overwrite it. Only `EWOULDBLOCK`/`EAGAIN`
            // means "another instance holds the lock" — the expected duplicate-launch case.
            let lockError = errno
            close(descriptor)
            guard lockError == EWOULDBLOCK || lockError == EAGAIN else {
                // A non-contention failure (e.g. EINTR, ENOLCK, EINVAL). Fail open rather than
                // silently suppress the menu-bar item, matching the branches above.
                logger.error("Single-instance lock failed (errno \(lockError)); proceeding without it.")
                return true
            }
            return false
        }

        // Intentionally leave `descriptor` open for the process lifetime: `flock` is released when
        // the descriptor is closed, so closing it here would let a second instance start. The OS
        // reclaims the descriptor (and the lock) when this process exits.
        return true
    }

    private static func lockFileURL() -> URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: AppInfo.appGroupID)?
            .appendingPathComponent(lockFileName)
    }
}
