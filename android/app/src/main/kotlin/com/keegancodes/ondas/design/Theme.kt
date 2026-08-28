package com.keegancodes.ondas.design

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.dp

/**
 * Ondas's small visual vocabulary — the port of `Ondas/Support/Theme.swift`.
 *
 * Swift's version is three static values (`userBubble`, `assistantBubble`, `bubbleCornerRadius`)
 * because SwiftUI supplies the rest as semantic colors: `Color.primary`, `.secondary`, `.tertiary`,
 * `.separator`, `.bar`. Compose has no such vocabulary outside a color scheme, so those five land
 * here as named roles rather than being spelled out at every call site. Nothing here is a new
 * design decision: each is the Material 3 counterpart of the SwiftUI role it replaces.
 *
 * | SwiftUI | Here |
 * |---|---|
 * | `Color.accentColor` | `colorScheme.primary` |
 * | `Color.white` (text on the user bubble) | `colorScheme.onPrimary` |
 * | `Color(uiColor: .secondarySystemBackground)` | `colorScheme.surfaceVariant` |
 * | `Color.primary` | `colorScheme.onSurface` |
 * | `.secondary` | `colorScheme.onSurfaceVariant` |
 * | `.tertiary` | `colorScheme.onSurfaceVariant` at 60% |
 * | `.separator` | `colorScheme.outlineVariant` |
 * | `.bar` | `colorScheme.surfaceContainer` |
 *
 * The accent itself is NOT yet derived from the iOS asset catalog — see PORTING.md § Known
 * unported Swift. Until the brand assets are generated from the iOS master, `primary` is whatever
 * the surrounding [MaterialTheme] supplies, which is honest; a hand-picked lookalike would not be.
 */
public object Theme {

    /** Fill for the user's own message bubbles — the app's accent. */
    public val userBubble: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.primary

    /** Text drawn on top of [userBubble]. Swift hard-codes `Color.white`. */
    public val onUserBubble: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.onPrimary

    /** Fill for assistant message bubbles — and for the composer capsule, as in Swift. */
    public val assistantBubble: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.surfaceVariant

    /** Text drawn on top of [assistantBubble]. */
    public val onAssistantBubble: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.onSurface

    /** Chrome behind the banners, the token meter and the composer — SwiftUI's `.bar` material. */
    public val bar: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.surfaceContainer

    /** De-emphasised label color — SwiftUI's `.secondary`. */
    public val secondaryLabel: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.onSurfaceVariant

    /** The faintest label color — SwiftUI's `.tertiary`. */
    public val tertiaryLabel: Color
        @Composable @ReadOnlyComposable get() =
            MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = TERTIARY_ALPHA)

    /** Hairline color — SwiftUI's `.separator`. */
    public val separator: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.outlineVariant

    /** The meter's "getting close" color. Swift names `.orange` outright, so this does too. */
    public val meterWarning: Color = Color(0xFFFF9500)

    /** Corner radius shared by message bubbles. */
    public val bubbleCornerRadius = 20.dp

    /** Swift's `RoundedRectangle(cornerRadius:style: .continuous)` around a bubble. */
    public val bubbleShape: Shape = RoundedCornerShape(bubbleCornerRadius)

    private const val TERTIARY_ALPHA = 0.6f
}
