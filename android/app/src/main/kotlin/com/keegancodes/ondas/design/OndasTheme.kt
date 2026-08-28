package com.keegancodes.ondas.design

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * Ondas's colours, taken from the iOS asset catalog rather than picked to look similar.
 *
 * ## The accent comes from the ICON, not from `AccentColor.colorset`
 *
 * iOS ships a violet accent (`AccentColor.colorset` = #665CF2 / #8B82F9) alongside a blue-and-cyan
 * icon, and the first version of this file reproduced that split faithfully — accent tints the
 * controls, icon is its own artwork.
 *
 * **Keegan overrode it (2026-08-27): "I prefer the white and blue branding of the iOS version, let's
 * match."** So the scheme is built from the icon's own sampled values instead, and the app reads as
 * the blue-on-white the icon does. This is a deliberate, approved divergence from the asset
 * catalog's accent — a future reader comparing the two should not "restore" the violet.
 *
 * The launch background stays from `LaunchBackground.colorset` (#FFFFFF / #101113).
 *
 * ## Dynamic colour is deliberately off
 *
 * Material You would reseed the whole scheme from the user's wallpaper, which is the Android
 * idiom but would throw away the brand colour this app is identified by — and would make the user
 * bubble a different colour on every phone. The sibling ports made the same call for the same
 * reason. If it is ever wanted, it belongs behind a setting, not as the default.
 *
 * The neutrals are Material 3 tonal values around the accent's hue, standing in for the SwiftUI
 * semantic colours listed in [Theme]'s table. The dark surface is the launch background from the
 * asset catalog, so the window the system paints before Compose starts matches the first frame
 * Compose draws.
 */
// Sampled from the icon master itself (tools/GenerateBrandAssets.java samples the same file):
// the ring's lower arc is #0068F8, its upper arc #00C0F8, the wave crests #68C8F8, and the
// ground #F5FAFD. These are the artwork's own values, not an approximation of them.
private val OndasBlue = Color(0xFF0068F8)
private val OndasCyan = Color(0xFF00C0F8)
private val OndasCrest = Color(0xFF68C8F8)
private val OndasGround = Color(0xFFF5FAFD)

/** Lifted for dark mode: #0068F8 on a dark surface is too low-contrast to read as the brand. */
private val OndasBlueDark = Color(0xFF6FB4FF)

private val LightColors = lightColorScheme(
    primary = OndasBlue,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD3E7FF),
    onPrimaryContainer = Color(0xFF001C3B),
    secondary = OndasCyan,
    onSecondary = Color(0xFF00344A),
    secondaryContainer = Color(0xFFCDEDFB),
    onSecondaryContainer = Color(0xFF00344A),
    tertiary = OndasCrest,
    // The icon's ground, so the app reads as the same white the artwork sits on.
    background = OndasGround,
    onBackground = Color(0xFF111C27),
    surface = OndasGround,
    onSurface = Color(0xFF111C27),
    // The counterpart of `.secondarySystemBackground`, which fills the assistant bubble. Tinted
    // toward the brand rather than neutral grey, so a reply bubble still reads as part of Ondas.
    surfaceVariant = Color(0xFFDDE9F3),
    onSurfaceVariant = Color(0xFF3F4A57),
    surfaceContainer = Color(0xFFEAF2F9),
    outline = Color(0xFF6F7A87),
    outlineVariant = Color(0xFFC0CCD8),
    error = Color(0xFFBA1A1A),
    onError = Color.White,
)

private val DarkColors = darkColorScheme(
    primary = OndasBlueDark,
    onPrimary = Color(0xFF00325C),
    primaryContainer = Color(0xFF004A87),
    onPrimaryContainer = Color(0xFFD3E7FF),
    secondary = Color(0xFF7FD4F5),
    onSecondary = Color(0xFF00344A),
    tertiary = OndasCrest,
    // #101113 — the dark LaunchBackground from the asset catalog.
    background = Color(0xFF101113),
    onBackground = Color(0xFFE5E1E9),
    surface = Color(0xFF101113),
    onSurface = Color(0xFFE5E1E9),
    surfaceVariant = Color(0xFF1F2A36),
    onSurfaceVariant = Color(0xFFC0CCD8),
    surfaceContainer = Color(0xFF17202A),
    outline = Color(0xFF8A94A0),
    outlineVariant = Color(0xFF3F4A57),
    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
)

@Composable
public fun OndasTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        content = content,
    )
}
