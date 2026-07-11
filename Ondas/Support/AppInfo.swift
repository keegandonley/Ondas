import Foundation

/// Anchors identity lookup to the app or helper bundle that contains this source.
/// `Bundle.main` would instead resolve to the XCTest runner when unit tests load the app module.
private final class AppInfoBundleMarker {}

/// App-wide identity constants.
enum AppInfo {
    /// The shared identity used as the `Logger` subsystem everywhere and the Keychain service name,
    /// so all diagnostics and secrets group under one identity.
    ///
    /// Deliberately the configured *main-app* identity, not the containing bundle identifier: this
    /// file is compiled into both the Catalyst app and the macOS menu-bar agent, which have
    /// different bundle ids — they must resolve to the same identity so logs, secrets, and
    /// telemetry group together. It also lets the agent identify its parent process.
    static let bundleID = configuredValue(
        forInfoDictionaryKey: "OndasMainAppBundleIdentifier",
        fallback: bundle.bundleIdentifier ?? "com.example.ondas"
    )

    /// App Group shared between the app and the macOS menu-bar agent so both open the same
    /// SwiftData store (the agent runs in its own process; see `AppModelContainer`).
    ///
    /// Platform-specific on purpose. On macOS (the Catalyst app on a Mac + the native agent) this is
    /// the **team-scoped** container (`<TeamID>.…`): macOS Sequoia+ shows a "would like to access
    /// data from other apps" consent prompt on *every launch* for a `group.`-prefixed container, but
    /// treats a team-ID-prefixed one as same-team and never prompts. iPhone/iPad require the `group.`
    /// form. The team prefix comes from the active signing configuration. The store is
    /// CloudKit-backed, so the different local container per platform still holds the same synced
    /// data.
    static let appGroupID: String = {
        #if targetEnvironment(macCatalyst) || os(macOS)
        return configuredValue(
            forInfoDictionaryKey: "OndasMacAppGroupIdentifier",
            fallback: "group.\(bundleID)"
        )
        #else
        return configuredValue(
            forInfoDictionaryKey: "OndasIOSAppGroupIdentifier",
            fallback: "group.\(bundleID)"
        )
        #endif
    }()

    /// Bundle identifier of the embedded macOS menu-bar agent helper.
    static let menuBarAgentBundleID = configuredValue(
        forInfoDictionaryKey: "OndasMenuBarAgentBundleIdentifier",
        fallback: "\(bundleID).MenuBar"
    )

    private static let bundle = Bundle(for: AppInfoBundleMarker.self)

    /// Build-setting substitutions occur while copying Info.plist. The fallback keeps previews and
    /// tests usable if their host bundle does not contain the app's generated metadata.
    private static func configuredValue(forInfoDictionaryKey key: String, fallback: String) -> String {
        guard let value = bundle.object(forInfoDictionaryKey: key) as? String,
              !value.isEmpty,
              !value.hasPrefix("$(") else {
            return fallback
        }
        return value
    }
}
