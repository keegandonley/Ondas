import Foundation

/// App-wide identity constants.
enum AppInfo {
    /// The shared identity used as the `Logger` subsystem everywhere and the Keychain service name,
    /// so all diagnostics and secrets group under one identity.
    ///
    /// Deliberately a fixed string, not `Bundle.main.bundleIdentifier`: this file is compiled into
    /// both the Catalyst app and the macOS menu-bar agent, which have different bundle ids — they
    /// must resolve to the *same* identity so logs/secrets/telemetry group together. It also equals
    /// the main app's real bundle id (the agent's parent-termination watcher compares against it).
    static let bundleID = "com.keegancodes.ondas"

    /// App Group shared between the app and the macOS menu-bar agent so both open the same
    /// SwiftData store (the agent runs in its own process; see `AppModelContainer`).
    ///
    /// Platform-specific on purpose. On macOS (the Catalyst app on a Mac + the native agent) this is
    /// the **team-scoped** container (`<TeamID>.…`): macOS Sequoia+ shows a "would like to access
    /// data from other apps" consent prompt on *every launch* for a `group.`-prefixed container, but
    /// treats a team-ID-prefixed one as same-team and never prompts. iPhone/iPad require the `group.`
    /// form. The team prefix is this account's fixed Team ID (also `DEVELOPMENT_TEAM` in project.yml).
    /// The store is CloudKit-backed, so the different local container per platform still holds the
    /// same synced data.
    static let appGroupID: String = {
        #if targetEnvironment(macCatalyst) || os(macOS)
        return "3D997JL57S.com.keegancodes.ondas"
        #else
        return "group.com.keegancodes.ondas"
        #endif
    }()

    /// Bundle identifier of the embedded macOS menu-bar agent helper.
    static let menuBarAgentBundleID = "com.keegancodes.ondas.MenuBar"
}
