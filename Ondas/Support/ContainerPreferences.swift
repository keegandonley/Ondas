import Foundation
import OSLog

/// The small slice of `UserDefaults` the settings stores use. Lets them be backed by either the
/// system defaults (unit tests inject a `UserDefaults` suite) or the shared-container plist (app +
/// agent). `UserDefaults` already has these exact methods, so it conforms for free.
protocol KeyValueStore {
    func string(forKey defaultName: String) -> String?
    func bool(forKey defaultName: String) -> Bool
    func set(_ value: Any?, forKey defaultName: String)
}

extension UserDefaults: KeyValueStore {}

/// The platform-appropriate store for shared settings (response style, telemetry prefs).
///
/// On macOS/Catalyst it's the App-Group-container plist (shared with the menu-bar agent). On iOS it's
/// process-local `UserDefaults` — there's no agent to share with, and the iOS App Store build can't
/// carry the App Group entitlement, so `ContainerPreferences` would have no container there.
enum SharedSettings {
    static var store: KeyValueStore {
        #if os(macOS) || (targetEnvironment(macCatalyst) && ONDAS_MENUBAR)
        ContainerPreferences.shared
        #else
        UserDefaults.standard
        #endif
    }
}

/// Preferences shared between the app and the menu-bar agent, stored as a plist in the shared App
/// Group container.
///
/// Deliberately NOT `UserDefaults(suiteName:)`: a defaults suite must be a `group.`-prefixed
/// container, and on macOS Sequoia+ *any* access to a `group.` container (a store file OR its
/// preferences) triggers the per-launch "would like to access data from other apps" consent prompt.
/// `AppInfo.appGroupID` is team-scoped on macOS (same-team → no prompt) and `group.` on iOS (no such
/// prompt there), and this file lives inside it, so no `group.` container is ever touched on macOS.
///
/// Only the app writes settings (from its Settings screen); the agent only reads. Writes are atomic
/// (temp + rename) so a concurrent reader always sees a complete file, and reads hit disk each call
/// so a change made in the app is picked up by the agent on its next read. Stateless (just the file
/// URL) → `Sendable` with no locking.
final class ContainerPreferences: KeyValueStore, Sendable {
    static let shared = ContainerPreferences(appGroupID: AppInfo.appGroupID)

    private let fileURL: URL?
    private let logger = Logger(subsystem: AppInfo.bundleID, category: "ContainerPreferences")

    init(appGroupID: String) {
        let url = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupID)?
            .appendingPathComponent("SharedPreferences.plist")
        fileURL = url
        if url == nil {
            // A nil container means the App Group entitlement is missing/misprovisioned — settings
            // would silently read as defaults and never persist. Make that visible rather than fail
            // silently (mirrors KeychainSecretStore's logging policy).
            logger.error("No App Group container for \(appGroupID, privacy: .public); shared settings unavailable.")
        }
    }

    func string(forKey defaultName: String) -> String? {
        load()[defaultName] as? String
    }

    func bool(forKey defaultName: String) -> Bool {
        load()[defaultName] as? Bool ?? false
    }

    func set(_ value: Any?, forKey defaultName: String) {
        guard let fileURL else { return }
        var dict = load()
        if let value {
            dict[defaultName] = value
        } else {
            dict.removeValue(forKey: defaultName)
        }
        do {
            let data = try PropertyListSerialization.data(fromPropertyList: dict, format: .binary, options: 0)
            try data.write(to: fileURL, options: .atomic)
        } catch {
            // A silent write failure means the user's setting evaporates on next launch — surface it.
            logger.error("Failed to persist shared preference \(defaultName, privacy: .public): \(error, privacy: .public)")
        }
    }

    private func load() -> [String: Any] {
        guard
            let fileURL,
            let data = try? Data(contentsOf: fileURL),
            let dict = try? PropertyListSerialization.propertyList(
                from: data, options: [], format: nil
            ) as? [String: Any]
        else {
            return [:]
        }
        return dict
    }
}
