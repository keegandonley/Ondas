import Foundation

/// A user-facing creativity dial for chat replies, mapped to `GenerationOptions.temperature`.
/// `.balanced` passes `nil` rather than a specific number, so it mirrors the on-device model's own
/// default behavior instead of guessing at what that default numerically is.
enum ResponseStyle: String, CaseIterable, Identifiable {
    case precise
    case balanced
    case creative

    var id: String { rawValue }

    var label: String {
        switch self {
        case .precise: return "Precise"
        case .balanced: return "Balanced"
        case .creative: return "Creative"
        }
    }

    var footer: String {
        switch self {
        case .precise: return "Lower temperature: more focused, consistent replies."
        case .balanced: return "The on-device model's default behavior."
        case .creative: return "Higher temperature: more varied, exploratory replies."
        }
    }

    var temperature: Double? {
        switch self {
        case .precise: return 0.3
        case .balanced: return nil
        case .creative: return 1.3
        }
    }
}

/// Loads and persists the user's chat response-style preference in `UserDefaults`. Read fresh by
/// `ChatEngine` on every turn (a cheap `UserDefaults` lookup) rather than cached, so a change in
/// Settings takes effect on the very next message without any cross-object update plumbing.
struct GenerationSettingsStore {
    private let defaults: KeyValueStore

    private enum Keys {
        static let responseStyle = "generation.responseStyle"
    }

    // The platform-appropriate shared store (App-Group container on Mac so the menu-bar agent reads
    // the same response-style; process-local `UserDefaults` on iOS). See `SharedSettings`.
    init(defaults: KeyValueStore = SharedSettings.store) {
        self.defaults = defaults
    }

    func load() -> ResponseStyle {
        guard let raw = defaults.string(forKey: Keys.responseStyle),
              let style = ResponseStyle(rawValue: raw)
        else {
            return .balanced
        }
        return style
    }

    func save(_ style: ResponseStyle) {
        defaults.set(style.rawValue, forKey: Keys.responseStyle)
    }
}
