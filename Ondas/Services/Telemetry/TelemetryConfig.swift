import Foundation
import OSLog
import Security

/// An immutable snapshot of the user's telemetry preferences, safe to hand to the telemetry actor.
///
/// Telemetry is opt-in and off by default: this app is otherwise fully on-device, so nothing about a
/// conversation leaves the device unless the user turns this on and points it at an endpoint.
struct TelemetryConfig: Sendable, Equatable {
    var isEnabled: Bool
    var sendTranscripts: Bool
    var endpoint: URL?
    var apiKey: String?

    /// Whether a span can actually be delivered — enabled, with a destination and a key.
    var isDeliverable: Bool {
        isEnabled && endpoint != nil && !(apiKey ?? "").isEmpty
    }

    static let disabled = TelemetryConfig(
        isEnabled: false,
        sendTranscripts: false,
        endpoint: nil,
        apiKey: nil
    )
}

extension TelemetryConfig {
    /// Builds a config from raw user-entered field values, normalizing them the single way the
    /// app does it (trim; blank means absent). Shared by the persisted settings
    /// (`TelemetrySettingsStore.currentConfig`) and the Settings screen's unsaved draft, so the
    /// test button exercises exactly what saving would produce. Lives in an extension so the
    /// memberwise init stays available.
    init(isEnabled: Bool, sendTranscripts: Bool, endpointField: String, apiKeyField: String) {
        let trimmedEndpoint = endpointField.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedKey = apiKeyField.trimmingCharacters(in: .whitespacesAndNewlines)
        self.init(
            isEnabled: isEnabled,
            sendTranscripts: sendTranscripts,
            endpoint: trimmedEndpoint.isEmpty ? nil : URL(string: trimmedEndpoint),
            apiKey: trimmedKey.isEmpty ? nil : trimmedKey
        )
    }
}

/// A minimal secret store so the telemetry key can live in the Keychain in the app while tests
/// substitute an in-memory implementation (the Keychain is unavailable/flaky in the unit-test host).
protocol SecretStore: Sendable {
    func secret(forKey account: String) -> String?
    func setSecret(_ value: String?, forKey account: String)
}

/// Keychain-backed `SecretStore` scoped to a single generic-password service (the bundle id).
struct KeychainSecretStore: SecretStore {
    let service: String

    private static let logger = Logger(subsystem: AppInfo.bundleID, category: "Keychain")

    private func baseQuery(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    func secret(forKey account: String) -> String? {
        var query = baseQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8)
        else {
            return nil
        }
        return value
    }

    func setSecret(_ value: String?, forKey account: String) {
        let query = baseQuery(account)
        // Empty/nil clears the stored secret rather than storing a blank one. Deleting a secret
        // that was never stored is a normal no-op, not a failure.
        guard let value, !value.isEmpty else {
            let status = SecItemDelete(query as CFDictionary)
            if status != errSecSuccess, status != errSecItemNotFound {
                Self.logger.error("Keychain delete failed for \(account, privacy: .public): \(status)")
            }
            return
        }
        let data = Data(value.utf8)
        let update = [kSecValueData as String: data] as CFDictionary
        var status = SecItemUpdate(query as CFDictionary, update)
        if status == errSecItemNotFound {
            var insert = query
            insert[kSecValueData as String] = data
            status = SecItemAdd(insert as CFDictionary, nil)
        }
        // A silent failure here would mean the user's key evaporates on next launch and telemetry
        // quietly stops — make it visible in the log.
        if status != errSecSuccess {
            Self.logger.error("Keychain write failed for \(account, privacy: .public): \(status)")
        }
    }
}

/// Loads and persists telemetry preferences: the on/off flag and endpoint in `UserDefaults`, the
/// bearer key in a `SecretStore` (Keychain) so the secret never lands in a plist or backup-readable
/// default. `@MainActor` because it is driven from the settings UI and app launch.
@MainActor
struct TelemetrySettingsStore {
    private let defaults: KeyValueStore
    private let secrets: SecretStore

    private enum Keys {
        static let enabled = "telemetry.enabled"
        static let sendTranscripts = "telemetry.sendTranscripts"
        static let endpoint = "telemetry.endpoint"
        static let apiKeyAccount = "telemetry.apiKey"
    }

    // The platform-appropriate shared store (App-Group container on Mac so app + agent read the same
    // telemetry preference; process-local `UserDefaults` on iOS). The bearer key lives in the
    // Keychain under the shared `keychain-access-groups` group on Mac, so the agent reads it too.
    init(
        defaults: KeyValueStore = SharedSettings.store,
        secrets: SecretStore = KeychainSecretStore(service: AppInfo.bundleID)
    ) {
        self.defaults = defaults
        self.secrets = secrets
    }

    /// The user-editable field values.
    func load() -> (isEnabled: Bool, sendTranscripts: Bool, endpoint: String, apiKey: String) {
        (
            isEnabled: defaults.bool(forKey: Keys.enabled),
            sendTranscripts: defaults.bool(forKey: Keys.sendTranscripts),
            endpoint: defaults.string(forKey: Keys.endpoint) ?? "",
            apiKey: secrets.secret(forKey: Keys.apiKeyAccount) ?? ""
        )
    }

    /// Persists the fields; a blank key clears the stored secret.
    func save(isEnabled: Bool, sendTranscripts: Bool, endpoint: String, apiKey: String) {
        defaults.set(isEnabled, forKey: Keys.enabled)
        defaults.set(sendTranscripts, forKey: Keys.sendTranscripts)
        defaults.set(endpoint, forKey: Keys.endpoint)
        secrets.setSecret(apiKey, forKey: Keys.apiKeyAccount)
    }

    /// The immutable snapshot to hand to `TelemetryService`.
    func currentConfig() -> TelemetryConfig {
        let values = load()
        return TelemetryConfig(
            isEnabled: values.isEnabled,
            sendTranscripts: values.sendTranscripts,
            endpointField: values.endpoint,
            apiKeyField: values.apiKey
        )
    }
}
