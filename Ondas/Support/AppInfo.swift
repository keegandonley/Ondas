import Foundation

/// App-wide identity constants.
enum AppInfo {
    /// The app's bundle identifier with a compile-time fallback. Shared as the `Logger`
    /// subsystem everywhere and as the Keychain service name, so all diagnostics and
    /// secrets group under one identity.
    static let bundleID = Bundle.main.bundleIdentifier ?? "com.keegancodes.ondas"
}
