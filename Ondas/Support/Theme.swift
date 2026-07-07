import SwiftUI

/// Ondas's small visual vocabulary. Screens pull colors from here (and the asset
/// catalog's `AccentColor`) so the look stays consistent as the UI grows.
enum Theme {
    /// Fill for the user's own message bubbles — the app's accent.
    static let userBubble = Color.accentColor

    /// Fill for assistant message bubbles; a neutral surface that adapts to light/dark.
    static let assistantBubble = Color(.secondarySystemBackground)

    /// Corner radius shared by message bubbles and generated-image cards.
    static let bubbleCornerRadius: CGFloat = 20
}
