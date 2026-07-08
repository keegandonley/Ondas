import Foundation
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

/// A minimal secret store so the telemetry key can live in the Keychain in the app while tests
/// substitute an in-memory implementation (the Keychain is unavailable/flaky in the unit-test host).
protocol SecretStore: Sendable {
    func secret(forKey account: String) -> String?
    func setSecret(_ value: String?, forKey account: String)
}

/// Keychain-backed `SecretStore` scoped to a single generic-password service (the bundle id).
struct KeychainSecretStore: SecretStore {
    let service: String

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
        // Empty/nil clears the stored secret rather than storing a blank one.
        guard let value, !value.isEmpty else {
            SecItemDelete(query as CFDictionary)
            return
        }
        let data = Data(value.utf8)
        let update = [kSecValueData as String: data] as CFDictionary
        let status = SecItemUpdate(query as CFDictionary, update)
        if status == errSecItemNotFound {
            var insert = query
            insert[kSecValueData as String] = data
            SecItemAdd(insert as CFDictionary, nil)
        }
    }
}

/// Loads and persists telemetry preferences: the on/off flag and endpoint in `UserDefaults`, the
/// bearer key in a `SecretStore` (Keychain) so the secret never lands in a plist or backup-readable
/// default. `@MainActor` because it is driven from the settings UI and app launch.
@MainActor
struct TelemetrySettingsStore {
    private let defaults: UserDefaults
    private let secrets: SecretStore

    private enum Keys {
        static let enabled = "telemetry.enabled"
        static let sendTranscripts = "telemetry.sendTranscripts"
        static let endpoint = "telemetry.endpoint"
        static let apiKeyAccount = "telemetry.apiKey"
    }

    init(
        defaults: UserDefaults = .standard,
        secrets: SecretStore = KeychainSecretStore(
            service: Bundle.main.bundleIdentifier ?? "com.keegancodes.ondas"
        )
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
        let trimmedEndpoint = values.endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedKey = values.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        return TelemetryConfig(
            isEnabled: values.isEnabled,
            sendTranscripts: values.sendTranscripts,
            endpoint: trimmedEndpoint.isEmpty ? nil : URL(string: trimmedEndpoint),
            apiKey: trimmedKey.isEmpty ? nil : trimmedKey
        )
    }
}
